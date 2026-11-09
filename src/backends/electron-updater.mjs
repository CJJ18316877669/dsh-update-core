import { UpdateError, AbortedError } from '../errors.mjs';

/**
 * electron-updater 适配器。
 * 不直接 import electron-updater：桌面主进程注入 autoUpdater，便于测试与替换。
 * 约定 autoUpdater 至少提供 checkForUpdates / downloadUpdate / quitAndInstall，并以 EventEmitter 方式发事件。
 */
export class ElectronUpdaterBackend {
  /**
   * @param {{autoUpdater:any, currentVersion:string, plugins?:Array<Record<string, any>>, channel?:string}} options
   */
  constructor(options) {
    if (!options || !options.autoUpdater) throw new TypeError('ElectronUpdaterBackend requires autoUpdater');
    if (typeof options.currentVersion !== 'string' || options.currentVersion === '') {
      throw new TypeError('ElectronUpdaterBackend requires currentVersion');
    }
    this.kind = 'desktop';
    this.autoUpdater = options.autoUpdater;
    this.currentVersion = options.currentVersion;
    this.plugins = options.plugins || [];
    this.channel = options.channel || 'stable';
    this.coordinator = options.coordinator || null;
    this.listener = null;
  }

  async getCurrentVersion() {
    return this.currentVersion;
  }

  async check(channel) {
    if (typeof this.autoUpdater.checkForUpdates !== 'function') {
      throw new UpdateError('UPD-702', { message: 'autoUpdater.checkForUpdates is not available' });
    }
    let result;
    try {
      result = await this.autoUpdater.checkForUpdates();
    } catch (error) {
      throw new UpdateError('UPD-101', { message: 'desktop update check failed', cause: error });
    }
    const info = result && (result.updateInfo || result);
    if (!info || typeof info.version !== 'string' || info.version === '') return [];
    return [{
      version: info.version,
      channel,
      releaseDate: info.releaseDate,
      dist: { files: info.files || [] },
      notes: info.releaseNotes,
    }];
  }

  async listPlugins() {
    return this.plugins.map((plugin) => ({ ...plugin }));
  }

  async resolvePlugins() {
    return {};
  }

  async prepare(plan, ctx = {}) {
    if (typeof this.autoUpdater.downloadUpdate !== 'function') {
      throw new UpdateError('UPD-702', { message: 'autoUpdater.downloadUpdate is not available' });
    }
    const onProgress = typeof ctx.onProgress === 'function' ? ctx.onProgress : () => {};
    const signal = ctx.signal;
    let onDownload = null;
    if (typeof this.autoUpdater.on === 'function') {
      onDownload = (progress) => {
        const total = Number(progress && progress.total);
        const transferred = Number(progress && progress.transferred);
        const percent = total > 0 ? Math.min(100, Math.round((transferred / total) * 100)) : 0;
        onProgress({ percent, stage: 'download' });
      };
      this.autoUpdater.on('download-progress', onDownload);
    }
    try {
      if (signal && signal.aborted) throw new AbortedError();
      await this.autoUpdater.downloadUpdate();
      if (signal && signal.aborted) throw new AbortedError();
      onProgress({ percent: 100, stage: 'verify' });
      return { id: 'desktop-staged', plan };
    } catch (error) {
      if (error instanceof UpdateError || error instanceof AbortedError) throw error;
      throw new UpdateError('UPD-401', { message: 'desktop download failed', cause: error });
    } finally {
      if (onDownload && typeof this.autoUpdater.removeListener === 'function') {
        this.autoUpdater.removeListener('download-progress', onDownload);
      }
    }
  }

  async drain(ctx = {}) {
    if (ctx.signal && ctx.signal.aborted) throw new AbortedError();
    if (this.coordinator && typeof this.coordinator.drain === 'function') {
      return this.coordinator.drain(ctx);
    }
    return { ok: true };
  }

  async activate() {
    if (typeof this.autoUpdater.quitAndInstall !== 'function') {
      throw new UpdateError('UPD-702', { message: 'autoUpdater.quitAndInstall is not available' });
    }
    if (this.coordinator && typeof this.coordinator.quitAndInstall === 'function') {
      await this.coordinator.quitAndInstall();
    } else {
      this.autoUpdater.quitAndInstall(false, true);
    }
    return {
      id: 'desktop-install',
      commit: async () => {},
      rollback: async () => {
        if (this.coordinator && typeof this.coordinator.rollback === 'function') {
          return this.coordinator.rollback();
        }
        throw new Error('desktop rollback is handled by the installer');
      },
    };
  }

  async health() {
    // 桌面安装后的进程重启、启动日志与回滚由 DesktopUpdateCoordinator 负责。
    // delegated 表示“本适配器没有验证”；orchestrator 不得据此提交事务。
    if (this.coordinator && typeof this.coordinator.health === 'function') {
      return this.coordinator.health();
    }
    return { ok: true, delegated: true, checks: ['delegated-to-desktop'] };
  }

  async rollback() {
    if (this.coordinator && typeof this.coordinator.rollback === 'function') {
      try {
        const result = await this.coordinator.rollback();
        return result || { ok: true, mode: 'rolled-back', reason: 'desktop-coordinator' };
      } catch (error) {
        return { ok: false, mode: 'safe-mode', reason: error instanceof Error ? error.message : String(error) };
      }
    }
    return { ok: false, mode: 'safe-mode', reason: 'desktop-rollback-requires-installer' };
  }

  async cleanup() {}
}
