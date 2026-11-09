import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { writeJsonAtomic } from './json-store.mjs';
import { writeFileAtomic } from './platform/fs.mjs';
import { isCorePlugin } from './plugin-gate.mjs';

function conflict(message) {
  const error = new Error(`profile restore conflict: ${message}`);
  error.code = 'PROFILE_CONFLICT';
  return error;
}

function splitLines(text) {
  const lines = [];
  let start = 0;
  while (start < text.length) {
    let contentEnd = start;
    while (contentEnd < text.length && text[contentEnd] !== '\r' && text[contentEnd] !== '\n') {
      contentEnd += 1;
    }
    let end = contentEnd;
    if (text[end] === '\r' && text[end + 1] === '\n') end += 2;
    else if (text[end] === '\r' || text[end] === '\n') end += 1;
    lines.push({ start, end, content: text.slice(start, contentEnd) });
    start = end;
  }
  return lines;
}

function scalarTokenEnd(text, start) {
  if (text[start] === '"') {
    for (let i = start + 1; i < text.length; i += 1) {
      if (text[i] === '\\') i += 1;
      else if (text[i] === '"') return i + 1;
    }
    throw new Error('unsupported YAML: unterminated double-quoted scalar');
  }
  if (text[start] === "'") {
    for (let i = start + 1; i < text.length; i += 1) {
      if (text[i] === "'" && text[i + 1] === "'") i += 1;
      else if (text[i] === "'") return i + 1;
    }
    throw new Error('unsupported YAML: unterminated single-quoted scalar');
  }
  let end = start;
  while (end < text.length) {
    if (text[end] === '#' && end > start && /[ \t]/.test(text[end - 1])) break;
    end += 1;
  }
  while (end > start && /[ \t]/.test(text[end - 1])) end -= 1;
  return end;
}

function parseScalar(text, start, end) {
  const token = text.slice(start, end);
  if (token.startsWith('"')) return JSON.parse(token);
  if (token.startsWith("'")) return token.slice(1, -1).replaceAll("''", "'");
  return token;
}

function mappingField(content, start = 0) {
  const match = /^(id|name|disabled)[ \t]*:[ \t]*/.exec(content.slice(start));
  if (!match) return null;
  const valueStart = start + match[0].length;
  const valueEnd = scalarTokenEnd(content, valueStart);
  return {
    key: match[1], valueStart, valueEnd,
    value: parseScalar(content, valueStart, valueEnd),
  };
}

function flowMapping(content, open) {
  const segments = [];
  let segmentStart = open + 1;
  let quote = null;
  let depth = 0;
  for (let i = open + 1; i < content.length; i += 1) {
    const char = content[i];
    if (quote) {
      if (quote === '"' && char === '\\') i += 1;
      else if (quote === "'" && char === "'" && content[i + 1] === "'") i += 1;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") quote = char;
    else if (char === '{' || char === '[') depth += 1;
    else if (char === ']' || (char === '}' && depth > 0)) depth -= 1;
    else if (char === ',' && depth === 0) {
      segments.push([segmentStart, i]);
      segmentStart = i + 1;
    } else if (char === '}' && depth === 0) {
      segments.push([segmentStart, i]);
      const fields = [];
      for (const [start, end] of segments) {
        const leading = /^[ \t]*/.exec(content.slice(start, end))[0].length;
        const field = mappingField(content, start + leading);
        if (field && field.valueStart <= end) {
          field.valueEnd = Math.min(field.valueEnd, end);
          while (field.valueEnd > field.valueStart && /[ \t]/.test(content[field.valueEnd - 1])) {
            field.valueEnd -= 1;
          }
          field.value = parseScalar(content, field.valueStart, field.valueEnd);
          fields.push(field);
        }
      }
      return { fields, close: i };
    }
  }
  throw new Error('unsupported YAML: flow mapping must fit on one line');
}

function parseEntry(text, lines, startLine, endLine) {
  const first = lines[startLine];
  const dash = /^-[ \t]+/.exec(first.content);
  const bodyStart = dash[0].length;
  const body = first.content.slice(bodyStart);
  const start = first.start;
  const end = endLine < lines.length ? lines[endLine].start : text.length;
  const entry = {
    start, end, startLine, endLine, raw: text.slice(start, end), id: null, name: null,
    kind: 'block', disabled: [], directIndent: null, identityLine: null,
  };
  let fields = [];

  if (body.startsWith('{')) {
    entry.kind = 'flow';
    const flow = flowMapping(first.content, bodyStart);
    fields = flow.fields.map((field) => ({ ...field, line: startLine }));
    entry.flowClose = flow.close;
    entry.flowOpen = bodyStart;
  } else {
    const inline = mappingField(first.content, bodyStart);
    if (inline) fields.push({ ...inline, line: startLine });
    const continuation = [];
    for (let i = startLine + 1; i < endLine; i += 1) {
      const content = lines[i].content;
      const match = /^([ \t]+)(?:[A-Za-z_][A-Za-z0-9_-]*|"[^"]+"|'[^']+')[ \t]*:/.exec(content);
      if (match) continuation.push({ line: i, indent: match[1] });
    }
    if (continuation.length) {
      entry.directIndent = continuation.reduce(
        (shortest, item) => (item.indent.length < shortest.length ? item.indent : shortest),
        continuation[0].indent,
      );
      for (const item of continuation) {
        if (item.indent !== entry.directIndent) continue;
        const field = mappingField(lines[item.line].content, item.indent.length);
        if (field) fields.push({ ...field, line: item.line });
      }
    }
  }

  const ids = fields.filter((field) => field.key === 'id');
  const names = fields.filter((field) => field.key === 'name');
  if (ids.length > 1 || names.length > 1) throw new Error('unsupported YAML: duplicate id or name in entry');
  entry.id = ids.length ? ids[0].value : null;
  entry.name = names.length ? names[0].value : null;
  entry.identityLine = (ids[0] || names[0])?.line ?? null;
  entry.disabled = fields.filter((field) => field.key === 'disabled');
  return entry;
}

function parsePatch(text) {
  if (text.charCodeAt(0) === 0xfeff) throw new Error('unsupported YAML: UTF-8 BOM');
  const lines = splitLines(text);
  const entries = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (!/^-[ \t]+/.test(lines[i].content)) continue;
    let end = i + 1;
    while (end < lines.length) {
      const content = lines[end].content;
      if (content && !/^[ \t#]/.test(content)) break;
      end += 1;
    }
    entries.push(parseEntry(text, lines, i, end));
    i = end - 1;
  }
  return { lines, entries };
}

function matchingEntries(parsed, name) {
  return parsed.entries.filter((entry) => entry.id === name || entry.name === name);
}

function oneMatch(parsed, name) {
  const matches = matchingEntries(parsed, name);
  if (matches.length > 1) throw new Error(`ambiguous YAML entries for plugin: ${name}`);
  return matches[0] || null;
}

function disabledState(entry) {
  if (!entry || entry.disabled.length === 0) return false;
  if (entry.disabled.length > 1) throw new Error('unsupported YAML: duplicate disabled field');
  const value = entry.disabled[0].value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error(`unsupported YAML disabled value: ${value}`);
}

function replaceRange(text, start, end, replacement) {
  return text.slice(0, start) + replacement + text.slice(end);
}

function disableEntry(text, parsed, entry) {
  if (disabledState(entry)) return text;
  if (entry.disabled.length === 1) {
    const field = entry.disabled[0];
    const line = parsed.lines[field.line];
    return replaceRange(text, line.start + field.valueStart, line.start + field.valueEnd, 'true');
  }
  if (entry.kind === 'flow') {
    const line = parsed.lines[entry.startLine];
    let insert = entry.flowClose;
    while (insert > entry.flowOpen + 1 && /[ \t]/.test(line.content[insert - 1])) insert -= 1;
    const hasFields = line.content.slice(entry.flowOpen + 1, insert).trim().length > 0;
    return replaceRange(text, line.start + insert, line.start + insert,
      `${hasFields ? ', ' : ''}disabled: true`);
  }

  const eol = detectEol(text);
  const insertLine = entry.identityLine === entry.startLine ? entry.startLine + 1 : entry.endLine;
  const offset = insertLine < parsed.lines.length ? parsed.lines[insertLine].start : text.length;
  const atEnd = offset === text.length;
  const needsLeadingEol = atEnd && offset > entry.start && !/[\r\n]$/.test(text.slice(0, offset));
  const trailingEol = atEnd && needsLeadingEol ? '' : eol;
  const addition = `${needsLeadingEol ? eol : ''}${entry.directIndent || '  '}disabled: true${trailingEol}`;
  return replaceRange(text, offset, offset, addition);
}

function detectEol(text) {
  return text.includes('\r\n') ? '\r\n' : '\n';
}

function appendEntry(text, name) {
  if (/^\.\.\.[ \t]*(?:\r?$|\r?\n)/m.test(text)) {
    throw new Error('unsupported YAML: cannot append after document terminator');
  }
  const eol = detectEol(text);
  const hasFinalEol = text.length === 0 || /[\r\n]$/.test(text);
  const prefix = text && !hasFinalEol ? eol : '';
  const entry = `- id: ${JSON.stringify(name)}${eol}  disabled: true${hasFinalEol ? eol : ''}`;
  return { text: text + prefix + entry, prefix, entry };
}

async function readText(file) {
  try {
    return await readFile(file, 'utf8');
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT') return '';
    throw error;
  }
}

async function writeTextAtomic(file, text) {
  await writeFileAtomic(file, text, { mode: 0o600 });
}

function emptyRestore() {
  return { schema: 1, disabled: {} };
}

export class ProfileStore {
  /** @param {{profileDir:string, patch?:string, restore?:string}} options */
  constructor(options) {
    if (!options || typeof options.profileDir !== 'string' || !options.profileDir) {
      throw new TypeError('ProfileStore requires profileDir');
    }
    this.profileDir = options.profileDir;
    this.patch = options.patch || join(options.profileDir, 'cordis.patch.yml');
    this.restore = options.restore || join(options.profileDir, 'restore.json');
  }

  async readRestore() {
    const text = await readText(this.restore);
    if (!text) return emptyRestore();
    const data = JSON.parse(text);
    if (!data || data.schema !== 1 || !data.disabled || typeof data.disabled !== 'object'
      || Array.isArray(data.disabled)) {
      throw new Error('invalid profile restore data');
    }
    return data;
  }

  /**
   * @param {{name:string, version?:string}} plugin
   * @param {string} reason
   */
  async disable(plugin, reason) {
    if (!plugin || typeof plugin.name !== 'string' || !plugin.name) {
      throw new TypeError('disable requires a plugin name');
    }
    if (isCorePlugin(plugin)) throw new Error('refusing to disable a core plugin');
    const name = plugin.name;
    const text = await readText(this.patch);
    const restore = await this.readRestore();
    const parsed = parsePatch(text);
    const entry = oneMatch(parsed, name);
    const existing = restore.disabled[name];

    if (disabledState(entry)) {
      if (existing) return this.handle(existing);
      return {
        name, version: plugin.version || '', reason, disabledAt: new Date().toISOString(),
      };
    }

    if (existing && existing.originalText !== text) {
      throw conflict(`plugin was changed before repeated disable: ${name}`);
    }

    let nextText;
    let originalEntry = null;
    let addedPrefix = '';
    if (entry) {
      originalEntry = entry.raw;
      nextText = disableEntry(text, parsed, entry);
    } else {
      const appended = appendEntry(text, name);
      nextText = appended.text;
      addedPrefix = appended.prefix;
    }
    const nextParsed = parsePatch(nextText);
    const managed = oneMatch(nextParsed, name);
    if (!managed || !disabledState(managed)) throw new Error(`failed to disable plugin: ${name}`);

    const record = existing || {
      name,
      version: plugin.version || '',
      reason,
      disabledAt: new Date().toISOString(),
      patchPath: this.patch,
      originalText: text,
      originalEntry,
      managedText: nextText,
      managedEntry: managed.raw,
      added: !entry,
      addedPrefix,
    };
    if (!existing) {
      await writeJsonAtomic(this.restore, {
        ...restore,
        disabled: { ...restore.disabled, [name]: record },
      });
    }
    await writeTextAtomic(this.patch, nextText);
    return this.handle(record);
  }

  /** @param {{name:string}|string} handle */
  async enable(handle) {
    const name = typeof handle === 'string' ? handle : handle && handle.name;
    if (typeof name !== 'string' || !name) throw new TypeError('enable requires a plugin name');
    const text = await readText(this.patch);
    const restore = await this.readRestore();
    const parsed = parsePatch(text);
    const entry = oneMatch(parsed, name);
    const record = restore.disabled[name];

    if (!record) {
      if (disabledState(entry)) throw new Error(`no restore data for disabled plugin: ${name}`);
      return { name };
    }
    if ((!entry || !disabledState(entry)) && text === record.originalText) {
      // A previous enable restored the patch but crashed before clearing its
      // recovery record. Completing that cleanup is safe and idempotent.
      const disabled = { ...restore.disabled };
      delete disabled[name];
      await writeJsonAtomic(this.restore, { ...restore, disabled });
      return { name };
    }
    if (!entry || entry.raw !== record.managedEntry || !disabledState(entry)) {
      throw conflict(`managed entry changed for plugin: ${name}`);
    }

    let start = entry.start;
    if (record.added && record.addedPrefix) {
      start -= record.addedPrefix.length;
      if (start < 0 || text.slice(start, entry.start) !== record.addedPrefix) {
        throw conflict(`appended entry prefix changed for plugin: ${name}`);
      }
    }
    const nextText = replaceRange(text, start, entry.end, record.originalEntry || '');
    await writeTextAtomic(this.patch, nextText);
    const disabled = { ...restore.disabled };
    delete disabled[name];
    await writeJsonAtomic(this.restore, { ...restore, disabled });
    return { name };
  }

  async list() {
    const text = await readText(this.patch);
    const parsed = parsePatch(text);
    const restore = await this.readRestore().catch(() => emptyRestore());
    const disabled = {};
    for (const entry of parsed.entries) {
      if (!disabledState(entry)) continue;
      const name = entry.id || entry.name;
      if (!name) continue;
      const record = restore.disabled[name];
      disabled[name] = {
        version: record?.version || '',
        reason: record?.reason || '',
        disabledAt: record?.disabledAt || '',
      };
    }
    return disabled;
  }

  handle(record) {
    return {
      name: record.name,
      version: record.version || '',
      reason: record.reason,
      disabledAt: record.disabledAt,
    };
  }
}
