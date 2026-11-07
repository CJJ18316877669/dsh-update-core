/**
 * 用户可见错误码与内部原因码的统一入口。
 * 设计约束：内部码只写日志；UI 只展示 UPD-* 与对应文案。
 */

/** @typedef {'check'|'resolve'|'gate'|'preflight'|'download'|'verify'|'install'|'health'|'rollback'|'policy'|'shape'} ErrorStage */

export const ERROR_SPECS = {
  'UPD-101': { stage: 'check', retryable: true, key: 'error.UPD-101' },
  'UPD-102': { stage: 'check', retryable: true, key: 'error.UPD-102' },
  'UPD-103': { stage: 'resolve', retryable: false, key: 'error.UPD-103' },
  'UPD-201': { stage: 'gate', retryable: false, key: 'error.UPD-201' },
  'UPD-202': { stage: 'gate', retryable: false, key: 'error.UPD-202' },
  'UPD-301': { stage: 'preflight', retryable: true, key: 'error.UPD-301' },
  'UPD-302': { stage: 'preflight', retryable: true, key: 'error.UPD-302' },
  'UPD-303': { stage: 'preflight', retryable: true, key: 'error.UPD-303' },
  'UPD-401': { stage: 'download', retryable: true, key: 'error.UPD-401' },
  'UPD-402': { stage: 'verify', retryable: true, key: 'error.UPD-402' },
  'UPD-501': { stage: 'install', retryable: true, key: 'error.UPD-501' },
  'UPD-502': { stage: 'health', retryable: false, key: 'error.UPD-502' },
  'UPD-503': { stage: 'health', retryable: false, key: 'error.UPD-503' },
  'UPD-601': { stage: 'rollback', retryable: false, key: 'error.UPD-601' },
  'UPD-701': { stage: 'policy', retryable: false, key: 'error.UPD-701' },
  'UPD-702': { stage: 'shape', retryable: false, key: 'error.UPD-702' },
};

/** 预检内部原因码 → 用户可见错误码 */
export const INTERNAL_TO_PUBLIC = {
  E_DISK: 'UPD-301',
  E_PERMISSION: 'UPD-302',
  E_BUSY: 'UPD-303',
  E_NO_COMPATIBLE: 'UPD-202',
  E_INTEGRITY: 'UPD-402',
  E_SIGNATURE: 'UPD-402',
  E_UNSUPPORTED: 'UPD-702',
  E_NETWORK: 'UPD-101',
};

const NODE_ERROR_MAP = {
  ENOSPC: 'UPD-301',
  EACCES: 'UPD-302',
  EPERM: 'UPD-302',
  EROFS: 'UPD-302',
  EEXIST: 'UPD-303',
  ENOTFOUND: 'UPD-101',
  ECONNREFUSED: 'UPD-101',
  ECONNRESET: 'UPD-101',
  ETIMEDOUT: 'UPD-101',
  EINTEGRITY: 'UPD-402',
};

export class UpdateError extends Error {
  /**
   * @param {keyof typeof ERROR_SPECS|string} code
   * @param {{message?:string, stage?:ErrorStage, retryable?:boolean, details?:Record<string, unknown>, cause?:unknown}} [options]
   */
  constructor(code, options = {}) {
    const spec = ERROR_SPECS[code];
    super(options.message || `update failed: ${code}`, options.cause ? { cause: options.cause } : undefined);
    this.name = 'UpdateError';
    this.code = code;
    this.stage = options.stage || (spec ? spec.stage : 'install');
    this.retryable = options.retryable ?? (spec ? spec.retryable : false);
    this.details = options.details || {};
  }

  toJSON() {
    return {
      name: this.name,
      code: this.code,
      stage: this.stage,
      retryable: this.retryable,
      message: this.message,
      details: this.details,
    };
  }
}

/** 取消不是错误码，单独识别，避免被 UI 展示成失败。 */
export class AbortedError extends Error {
  constructor(message = 'update aborted') {
    super(message);
    this.name = 'AbortedError';
    this.code = 'ABORTED';
  }
}

/** @param {unknown} error */
export function isAbortError(error) {
  return error instanceof AbortedError
    || (error instanceof Error && (error.name === 'AbortError' || error.code === 'ABORTED'));
}

/** @param {unknown} error */
export function isUpdateError(error) {
  return error instanceof UpdateError;
}

/**
 * 把任意异常规范化为 UpdateError；未知异常保留 cause，不丢栈。
 * @param {unknown} error
 * @param {string} [fallbackCode]
 * @returns {UpdateError}
 */
export function asUpdateError(error, fallbackCode = 'UPD-501') {
  if (error instanceof UpdateError) return error;
  if (isAbortError(error)) return new UpdateError('UPD-501', { message: 'cancelled', cause: error });
  const code = (error && typeof error === 'object' && typeof (/** @type {any} */ (error).code) === 'string')
    ? /** @type {any} */ (error).code
    : '';
  const mapped = NODE_ERROR_MAP[code] || fallbackCode;
  const message = error instanceof Error ? error.message : String(error);
  return new UpdateError(mapped, { message, cause: error });
}

/**
 * @param {ErrorStage} stage
 * @param {string} fallbackCode
 * @param {string} message
 * @param {Record<string, unknown>} [details]
 */
export function stageError(stage, fallbackCode, message, details) {
  return new UpdateError(fallbackCode, { stage, message, details });
}
