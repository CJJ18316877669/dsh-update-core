/**
 * 遥测：默认只落内存；默认不联网。
 * 约束：只发聚合字段，不发送插件名、配置内容、路径、令牌。
 */

const MAX_DEPTH = 6;

/**
 * @param {string} input
 * @param {string} [home]
 */
function redactString(input, home) {
  let out = input;
  if (home) out = out.split(home).join('<home>');
  out = out
    .replace(/([A-Za-z]:\\Users\\)([^\\\s"'<>]+)/g, '$1<user>')
    .replace(/(\/Users\/)([^/\s"'<>]+)/g, '$1<user>')
    .replace(/(\/home\/)([^/\s"'<>]+)/g, '$1<user>')
    .replace(/\/\/[^/\s@]+@/g, '//<redacted>@')
    .replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, '<email>')
    .replace(/\b(Bearer)\s+[A-Za-z0-9._~+/-]+=*/gi, '$1 <redacted>')
    .replace(/\b(token|password|passwd|secret|authorization|npm_token)=([^\s&]+)/gi, '$1=<redacted>');
  return out;
}

/**
 * @param {unknown} value
 * @param {{home?:string, depth?:number, seen?:WeakSet<object>}} [options]
 * @returns {unknown}
 */
export function redact(value, options = {}) {
  const depth = options.depth || 0;
  if (depth > MAX_DEPTH) return '<max-depth>';
  if (typeof value === 'string') return redactString(value, options.home);
  if (value === null || typeof value !== 'object') return value;
  const seen = options.seen || new WeakSet();
  if (seen.has(value)) return '<circular>';
  seen.add(value);
  if (Array.isArray(value)) {
    return value.slice(0, 50).map((item) => redact(item, { ...options, depth: depth + 1, seen }));
  }
  if (value instanceof Error) {
    return {
      name: value.name,
      code: /** @type {any} */ (value).code,
      message: redactString(value.message, options.home),
    };
  }
  /** @type {Record<string, unknown>} */
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (/token|password|secret|authorization/i.test(key)) {
      out[key] = '<redacted>';
      continue;
    }
    out[key] = redact(item, { ...options, depth: depth + 1, seen });
  }
  return out;
}

export class MemorySink {
  /** @param {{limit?:number}} [options] */
  constructor(options = {}) {
    this.limit = options.limit ?? 500;
    /** @type {Record<string, unknown>[]} */
    this.events = [];
  }

  /** @param {Record<string, unknown>} event */
  write(event) {
    this.events.push(event);
    if (this.events.length > this.limit) this.events.shift();
  }
}

export class Telemetry {
  /**
   * @param {{sink?:{write:(event:Record<string,unknown>)=>unknown}, enabled?:boolean, sampleRates?:Record<string,number>, random?:()=>number, clock?:()=>Date, home?:string}} [options]
   */
  constructor(options = {}) {
    options = options || {};
    this.sink = options.sink || null;
    this.enabled = options.enabled !== false;
    this.sampleRates = options.sampleRates || { 'update.stage': 0.05 };
    this.random = options.random || Math.random;
    this.clock = options.clock || (() => new Date());
    this.home = options.home || '';
    this.dropped = 0;
    this.failures = 0;
  }

  /**
   * @param {string} event
   * @param {Record<string, unknown>} [props]
   * @returns {boolean} 是否实际记录
   */
  emit(event, props = {}) {
    if (!this.enabled) return false;
    if (!this.shouldSample(event)) return false;
    if (!this.sink) return false;
    const safe = redact(props, { home: this.home });
    const payload = {
      event,
      ts: this.clock().toISOString(),
      ...(safe && typeof safe === 'object' && !Array.isArray(safe) ? safe : { value: safe }),
    };
    try {
      const result = this.sink.write(payload);
      if (result && typeof (/** @type {any} */ (result)).catch === 'function') {
        /** @type {Promise<unknown>} */ (result).catch(() => { this.failures += 1; });
      }
      return true;
    } catch {
      this.failures += 1;
      return false;
    }
  }

  /** @param {string} event */
  shouldSample(event) {
    const rate = this.sampleRates[event];
    if (rate === undefined) return true;
    if (rate >= 1) return true;
    if (rate <= 0) return false;
    return this.random() < rate;
  }

  async flush() {
    if (this.sink && typeof (/** @type {any} */ (this.sink).flush) === 'function') {
      await /** @type {any} */ (this.sink).flush();
    }
  }
}
