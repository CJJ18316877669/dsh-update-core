import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';

/**
 * 原子写 JSON：先写同目录临时文件，再 rename。
 * 避免进程崩溃时留下半截 journal / watchdog。
 * @param {string} file
 * @param {unknown} value
 */
export async function writeJsonAtomic(file, value) {
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  const payload = `${JSON.stringify(value, null, 2)}\n`;
  try {
    await writeFile(tmp, payload, { encoding: 'utf8', mode: 0o600 });
    await rename(tmp, file);
  } catch (error) {
    await unlink(tmp).catch(() => {});
    throw error;
  }
}

/**
 * @param {string} file
 * @returns {Promise<unknown|null>} 文件不存在返回 null；JSON 损坏抛错，由调用方决定隔离策略
 */
export async function readJson(file) {
  let text;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT') return null;
    throw error;
  }
  return JSON.parse(text);
}

/**
 * 把损坏文件改名保留，避免每次启动都读到坏数据。
 * @param {string} file
 * @param {number} [timestamp]
 */
export async function quarantine(file, timestamp = Date.now()) {
  const target = `${file}.corrupt-${timestamp}`;
  try {
    await rename(file, target);
    return target;
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT') return null;
    throw error;
  }
}

/** @param {string} file */
export async function removeFile(file) {
  try {
    await unlink(file);
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'ENOENT') throw error;
  }
}
