/**
 * 最小但完整的 semver 子集，覆盖更新器需要的范围语法。
 * 支持：精确版本、部分版本、^、~、> >= < <=、空格 AND、||、连字符范围、预发布。
 * 不依赖第三方包，保证离线可运行。
 */

const VERSION_RE = /^[v=]?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

/**
 * @typedef {{major:number, minor:number, patch:number, prerelease:string[], raw:string}} ParsedVersion
 */

/**
 * @param {unknown} input
 * @returns {ParsedVersion|null}
 */
export function parse(input) {
  if (typeof input !== 'string') return null;
  const raw = input.trim();
  const m = VERSION_RE.exec(raw);
  if (!m) return null;
  const prerelease = m[4] ? m[4].split('.') : [];
  if (prerelease.some((id) => id === '' || (/^\d+$/.test(id) && id.length > 1 && id.startsWith('0')))) {
    return null;
  }
  if ([m[1], m[2], m[3]].some((part) => part.length > 1 && part.startsWith('0'))) return null;
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    prerelease,
    raw,
  };
}

/** @param {ParsedVersion} v */
export function format(v) {
  const base = `${v.major}.${v.minor}.${v.patch}`;
  return v.prerelease.length ? `${base}-${v.prerelease.join('.')}` : base;
}

/** @param {ParsedVersion} v */
export function isPrerelease(v) {
  return v.prerelease.length > 0;
}

/**
 * @param {string|ParsedVersion} a
 * @param {string|ParsedVersion} b
 * @returns {-1|0|1}
 */
export function compare(a, b) {
  const va = typeof a === 'string' ? parse(a) : a;
  const vb = typeof b === 'string' ? parse(b) : b;
  if (!va || !vb) throw new TypeError(`invalid version: ${!va ? a : b}`);
  for (const key of /** @type {const} */ (['major', 'minor', 'patch'])) {
    if (va[key] !== vb[key]) return va[key] > vb[key] ? 1 : -1;
  }
  if (va.prerelease.length === 0 && vb.prerelease.length === 0) return 0;
  if (va.prerelease.length === 0) return 1;
  if (vb.prerelease.length === 0) return -1;
  const len = Math.max(va.prerelease.length, vb.prerelease.length);
  for (let i = 0; i < len; i += 1) {
    const ai = va.prerelease[i];
    const bi = vb.prerelease[i];
    if (ai === undefined) return -1;
    if (bi === undefined) return 1;
    if (ai === bi) continue;
    const an = /^\d+$/.test(ai);
    const bn = /^\d+$/.test(bi);
    if (an && bn) return Number(ai) > Number(bi) ? 1 : -1;
    if (an !== bn) return an ? -1 : 1;
    return ai > bi ? 1 : -1;
  }
  return 0;
}

/** @param {string|ParsedVersion} a @param {string|ParsedVersion} b */
export function rcompare(a, b) {
  return compare(b, a);
}

/** @param {string|ParsedVersion} version @param {string|ParsedVersion} minimum */
export function gt(version, minimum) {
  return compare(version, minimum) > 0;
}

/** @param {string|ParsedVersion} version @param {string|ParsedVersion} minimum */
export function gte(version, minimum) {
  return compare(version, minimum) >= 0;
}

/** @param {string|ParsedVersion} version @param {string|ParsedVersion} maximum */
export function lt(version, maximum) {
  return compare(version, maximum) < 0;
}

/**
 * 把部分版本（1 / 1.2 / 1.2.x）展开成下界。
 * @param {string} input
 * @returns {{major:number, minor:number, patch:number, parts:number, wildcard:boolean}|null}
 */
function partial(input) {
  const raw = input.trim().replace(/^[v=]/, '');
  if (raw === '' || raw === '*' || raw === 'x' || raw === 'X') {
    return { major: 0, minor: 0, patch: 0, parts: 0, wildcard: true };
  }
  const m = /^(\d+)(?:\.(\d+|[xX*]))?(?:\.(\d+|[xX*]))?(?:-([0-9A-Za-z.-]+))?$/.exec(raw);
  if (!m) return null;
  const minorWild = m[2] === undefined || /^[xX*]$/.test(m[2]);
  const patchWild = m[3] === undefined || /^[xX*]$/.test(m[3]);
  if (minorWild && !patchWild) return null;
  if (m[1].length > 1 && m[1].startsWith('0')) return null;
  if (!minorWild && m[2].length > 1 && m[2].startsWith('0')) return null;
  if (!minorWild && !patchWild && m[3].length > 1 && m[3].startsWith('0')) return null;
  const major = Number(m[1]);
  const minor = minorWild ? 0 : Number(m[2]);
  const patch = minorWild || patchWild ? 0 : Number(m[3]);
  const parts = minorWild ? 1 : patchWild ? 2 : 3;
  return {
    major,
    minor,
    patch,
    parts,
    wildcard: false,
    prerelease: m[4] ? m[4].split('.') : [],
  };
}

/**
 * 展开单个 token 为比较器数组。
 * @param {string} token
 * @returns {Array<{op:'>'|'>='|'<'|'<='|'=', version:ParsedVersion}>|null}
 */
function expandToken(token) {
  const m = /^(\^|~|>=|<=|>|<|=)?\s*(.+)$/.exec(token);
  if (!m) return null;
  const op = m[1] || '';
  const body = m[2].trim();
  if (body === '' || body === '*' || body === 'x' || body === 'X') return [];

  const lower = partial(body);
  if (!lower) return null;
  const lowerVersion = {
    major: lower.major,
    minor: lower.minor,
    patch: lower.patch,
    prerelease: lower.prerelease || [],
    raw: body,
  };

  if (op === '^') {
    let upper;
    if (lower.major > 0 || lower.parts === 1) {
      upper = { major: lower.major + 1, minor: 0, patch: 0, prerelease: [], raw: '' };
    } else if (lower.minor > 0 || lower.parts === 2) {
      upper = { major: 0, minor: lower.minor + 1, patch: 0, prerelease: [], raw: '' };
    } else {
      upper = { major: 0, minor: 0, patch: lower.patch + 1, prerelease: [], raw: '' };
    }
    return [
      { op: '>=', version: lowerVersion },
      { op: '<', version: upper },
    ];
  }

  if (op === '~') {
    const upper = lower.parts <= 1
      ? { major: lower.major + 1, minor: 0, patch: 0, prerelease: [], raw: '' }
      : { major: lower.major, minor: lower.minor + 1, patch: 0, prerelease: [], raw: '' };
    return [
      { op: '>=', version: lowerVersion },
      { op: '<', version: upper },
    ];
  }

  if (op === '>=' || op === '>' || op === '<' || op === '<=') {
    if (lower.wildcard) return [];
    if (op === '<=' && lower.parts < 3) {
      const upper = lower.parts === 1
        ? { major: lower.major + 1, minor: 0, patch: 0, prerelease: [], raw: '' }
        : { major: lower.major, minor: lower.minor + 1, patch: 0, prerelease: [], raw: '' };
      return [{ op: '<', version: upper }];
    }
    if (op === '>' && lower.parts < 3) {
      const next = lower.parts === 1
        ? { major: lower.major + 1, minor: 0, patch: 0, prerelease: [], raw: '' }
        : { major: lower.major, minor: lower.minor + 1, patch: 0, prerelease: [], raw: '' };
      return [{ op: '>=', version: next }];
    }
    return [{ op, version: lowerVersion }];
  }

  // 无操作符或 '='：部分版本按 npm 语义当成范围
  if (lower.wildcard) return [];
  if (lower.parts === 3) return [{ op: '=', version: lowerVersion }];
  const upper = lower.parts === 1
    ? { major: lower.major + 1, minor: 0, patch: 0, prerelease: [], raw: '' }
    : { major: lower.major, minor: lower.minor + 1, patch: 0, prerelease: [], raw: '' };
  return [
    { op: '>=', version: lowerVersion },
    { op: '<', version: upper },
  ];
}

/**
 * @typedef {{op:'>'|'>='|'<'|'<='|'=', version:ParsedVersion}} Comparator
 * @typedef {Comparator[]} ComparatorSet
 */

/**
 * @param {string} range
 * @returns {ComparatorSet[]|null} null 表示范围非法
 */
export function parseRange(range) {
  if (typeof range !== 'string') return null;
  const trimmed = range.trim();
  if (trimmed === '') return [[]];
  const sets = [];
  for (const rawSet of trimmed.split('||')) {
    const setText = rawSet.trim();
    if (setText === '') return null;
    // 允许 `>= 1.2.0` 这类操作符与版本之间有空格；先归一化再拆分。
    const normalizedSet = setText.replace(/(\^|~|>=|<=|>|<|=)\s+(?=[\dv*xX])/g, '$1');
    const hyphen = /^(\S+)\s+-\s+(\S+)$/.exec(normalizedSet);
    if (hyphen) {
      const low = partial(hyphen[1]);
      const high = partial(hyphen[2]);
      if (!low || !high) return null;
      const lowVersion = { major: low.major, minor: low.minor, patch: low.patch, prerelease: low.prerelease || [], raw: '' };
      const highVersion = high.parts < 3
        ? (high.parts === 1
          ? { major: high.major + 1, minor: 0, patch: 0, prerelease: [], raw: '' }
          : { major: high.major, minor: high.minor + 1, patch: 0, prerelease: [], raw: '' })
        : { major: high.major, minor: high.minor, patch: high.patch, prerelease: high.prerelease || [], raw: '' };
      sets.push([
        { op: '>=', version: lowVersion },
        { op: high.parts < 3 ? '<' : '<=', version: highVersion },
      ]);
      continue;
    }
    const comparators = [];
    for (const token of normalizedSet.split(/\s+/)) {
      if (!token) continue;
      const expanded = expandToken(token);
      if (!expanded) return null;
      comparators.push(...expanded);
    }
    sets.push(comparators);
  }
  return sets;
}

/**
 * @param {ParsedVersion} version
 * @param {Comparator} comparator
 */
function testComparator(version, comparator) {
  const c = compare(version, comparator.version);
  switch (comparator.op) {
    case '>': return c > 0;
    case '>=': return c >= 0;
    case '<': return c < 0;
    case '<=': return c <= 0;
    case '=': return c === 0;
    default: return false;
  }
}

/**
 * @param {string|ParsedVersion} version
 * @param {string} range
 * @param {{includePrerelease?:boolean}} [options]
 * @returns {boolean}
 */
export function satisfies(version, range, options = {}) {
  const includePrerelease = options.includePrerelease !== false;
  const v = typeof version === 'string' ? parse(version) : version;
  if (!v) return false;
  const sets = parseRange(range);
  if (!sets) return false;

  if (v.prerelease.length > 0 && !includePrerelease) {
    const allowed = sets.some((set) => set.some((c) => (
      c.version.prerelease.length > 0
      && c.version.major === v.major
      && c.version.minor === v.minor
      && c.version.patch === v.patch
    )));
    if (!allowed) return false;
  }

  return sets.some((set) => set.every((c) => testComparator(v, c)));
}

/**
 * @param {Array<string|ParsedVersion>} versions
 * @param {string} range
 * @param {{includePrerelease?:boolean}} [options]
 * @returns {string|null}
 */
export function maxSatisfying(versions, range, options = {}) {
  let best = null;
  for (const candidate of versions) {
    if (!satisfies(candidate, range, options)) continue;
    if (best === null || compare(candidate, best) > 0) {
      best = typeof candidate === 'string' ? candidate : format(candidate);
    }
  }
  return best;
}

/**
 * 稳定版优先，其次按版本降序；预发布永远排在稳定版之后。
 * @param {Array<string|ParsedVersion>} versions
 * @returns {string[]}
 */
export function sortStableFirstDesc(versions) {
  return versions
    .map((v) => (typeof v === 'string' ? v : format(v)))
    .sort((a, b) => {
      const pa = parse(a);
      const pb = parse(b);
      if (!pa || !pb) return 0;
      const aPrerelease = pa.prerelease.length > 0;
      const bPrerelease = pb.prerelease.length > 0;
      if (aPrerelease !== bPrerelease) return aPrerelease ? 1 : -1;
      return rcompare(pa, pb);
    });
}
