import { mkdir, open, readFile, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { UpdateError } from './errors.mjs';

/**
 * 单飞锁：每个 DSH_HOME 只允许一个更新进程。
 * 陈旧锁（默认 10 分钟无心跳）可被接管，接管前记录原持有者信息。
 */
export class FileLock {
  /**
   * @param {{home:string, staleMs?:number, clock?:()=>number, pid?:number}} options
   */
  constructor(options) {
    this.path = join(options.home, 'updates', 'update.lock');
    this.staleMs = options.staleMs ?? 10 * 60 * 1000;
    this.clock = options.clock || Date.now;
    this.pid = options.pid ?? process.pid;
    this.token = null;
  }

  async acquire() {
    if (this.token) return this.describe();
    await mkdir(dirname(this.path), { recursive: true });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const token = randomBytes(8).toString('hex');
      let handle;
      try {
        handle = await open(this.path, 'wx', 0o600);
        const info = {
          token,
          pid: this.pid,
          acquiredAt: new Date(this.clock()).toISOString(),
          heartbeatAt: this.clock(),
        };
        await handle.writeFile(`${JSON.stringify(info)}\n`, 'utf8');
        await handle.close();
        this.token = token;
        return { token, pid: this.pid };
      } catch (error) {
        if (handle) await handle.close().catch(() => {});
        if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'EEXIST') throw error;
        const owner = await this.readOwner();
        const heartbeat = owner && typeof owner.heartbeatAt === 'number' ? owner.heartbeatAt : 0;
        const stale = !owner || (this.clock() - heartbeat) > this.staleMs;
        if (!stale) {
          throw new UpdateError('UPD-303', {
            message: 'another update holds the lock',
            details: { pid: owner.pid, acquiredAt: owner.acquiredAt },
          });
        }
        await unlink(this.path).catch(() => {});
      }
    }
    throw new UpdateError('UPD-303', { message: 'could not acquire update lock' });
  }

  async readOwner() {
    try {
      const text = await readFile(this.path, 'utf8');
      const data = JSON.parse(text);
      if (!data || typeof data !== 'object' || typeof data.token !== 'string') return null;
      return data;
    } catch {
      return null;
    }
  }

  async touch() {
    if (!this.token) return false;
    const owner = await this.readOwner();
    if (!owner || owner.token !== this.token) return false;
    const updated = { ...owner, heartbeatAt: this.clock() };
    const { writeJsonAtomic } = await import('./json-store.mjs');
    await writeJsonAtomic(this.path, updated);
    return true;
  }

  async release() {
    if (!this.token) return false;
    const owner = await this.readOwner();
    if (owner && owner.token !== this.token) {
      this.token = null;
      return false;
    }
    await unlink(this.path).catch((error) => {
      if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'ENOENT') throw error;
    });
    this.token = null;
    return true;
  }
}
