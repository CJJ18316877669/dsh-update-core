# DeepSeek Harness 一键更新器 · 交接文档

> 更新时间：2026-11-09（UTC+8）
> 当前版本：`dsh-update-core@0.2.0`；测试 112 项
> 仓库：https://github.com/CJJ18316877669/dsh-update-core
> 项目根目录：`C:\Users\18316\Desktop\DeepSeek-Harness-一键更新方案`

---

## 0. 接手先做

```bash
npm test
npm run smoke:registry
node src/cli.mjs demo --scenario success --fast
npm run ui
```

预期：

- 112/112 测试通过。
- 真实 registry 冒烟返回 tarball 字节数与 SRI 结果；当前开发机 Node 22 会同时报告 dsh 要求 Node ≥24.9.0 的运行时阻断。
- success 退出 0，journal `committed`，watchdog 心跳 ≥1。
- UI 输出 `127.0.0.1` 地址，页面右下角显示 `LIVE`，状态来自真实 orchestrator。

---

## 1. 产品目标与边界

目标：一个按钮完成 dsh 更新，同时保证：

1. 核心与插件作为同一事务解析、安装、切换。
2. 不兼容可选插件写 `disabled: true`，不删除，可逐字节恢复。
3. staging、切换、自检、启动失败可回滚；回滚失败进入安全模式。
4. 用户能看到发生什么、是否回滚、下一步做什么。

非目标：重写 dsh 运行时、Cordis 加载器、Electron 安装器或包管理器。Desktop 的安装与原生恢复仍由 `electron-updater` / `DesktopUpdateCoordinator` 负责。

---

## 2. 已完成状态

### 2.1 P0 代码闭环完成（P0-3 真机验收另列 §4）

| ID | 状态 | 实现与证据 |
|---|---|---|
| P0-1 真实禁用 | 完成 | `src/profile-store.mjs` 以 `cordis.patch.yml` 为唯一事实来源；保留注释/CRLF/混合缩进；幂等；冲突拒绝；`enable` 逐字节恢复；13 项测试 |
| P0-2 staging 自检 | 完成 | `prepare` 后、`applying` 前执行 version / dump-config / 启动探测；30s 超时可取消；证据写入 journal；正式 profile 树哈希不变；可选插件禁用、核心阻断；5 项测试 |
| P0-3 Desktop 接入 | 代码完成，真机待验 | Coordinator 可注入 `drain` / `quitAndInstall` / `health` / `rollback`；`delegated` 不提交 journal，重启后真实 health 才 commit；2 项测试 |
| P0-4 watchdog helper | 完成 | detached helper 只接受 journal/profile/port/timeout；等待 journal 终态或 deadline；超时按 snapshot 回滚；失败写 safe mode；6 项测试 |
| P0-5 HttpSink | 完成 | 默认关闭；HTTPS、无凭据、超时即丢弃、批量、队列上限；失败不影响更新；2 项测试 |

### 2.2 P1 工程项

| ID | 状态 | 说明 |
|---|---|---|
| P1-1 native/pnpm/allowBuilds | 完成接口 | 默认 `--ignore-scripts`；仅显式 allowBuilds 逐包 rebuild；npm/pnpm；无 shell 字符串注入 |
| P1-2 快照与保留 | 完成 | 全 profile 快照使用 dereference（避免 Windows symlink 权限）；保留最近 3 份；staging/failed/old/history 有界清理 |
| P1-3 semver | 完成子集加固 | 前导零、partial comparator、hyphen partial、prerelease；alias 仍不伪装成 semver |
| P1-4 真实 smoke | 完成 registry / Desktop 待真机 | `npm run smoke:registry` 实际下载并校验 SRI；Electron 签名与安装需真机 |
| P1-5 清理 | 完成 | staging 7 天；failed/old 7 天；backup 3 份；history 100 条 |
| P1-6 CI | 已运行并修复首轮跨平台问题 | Ubuntu / Windows / macOS 15 arm64 / macOS 15 Intel × Node 20/22/24；首轮暴露测试 glob 与 Windows 盘符假设，已改为平台原生绝对路径和显式文件启动器；最终运行见 Actions |
| P1-7 锁竞态 | 完成 | 陈旧锁 token 二次确认 + unlink 重试；接管竞态失败返回 UPD-303 |

### 2.3 跨平台项

| 项 | 状态 |
|---|---|
| C1 Windows npm `shell:false` | 完成：优先 `node npm-cli.js`；受控 shell 退路 |
| C2 进程树 | 完成：POSIX 进程组 / Windows `taskkill /T /F`；真实子进程树测试 |
| C3 原子交换 | 完成：50/150/400ms 有界重试；EXDEV 复制 + SHA-256 全树校验 |
| C4 回滚吞错 | 完成：不再 `.catch(()=>{})`；保留 `.failed-*` 路径 |
| C5 原子写 | 完成：fsync + rename 重试 |
| C6 陈旧锁 | 完成：token 二次校验 + 删除重试 |
| C7 symlink | 完成：快照/复制 dereference |
| C8 大小写 | 完成：profile 名强制 lowercase |
| C9 Windows 路径长度 | 完成：写入前 240 字符检查 |
| C10 权限 | 文档化：Windows mode 不保证；journal 不含机密 |
| C11 `$DSH_HOME` | 完成：按官方规则 `DSH_HOME` → `~/.dsh`（三平台一致） |
| C12 BOM/中文路径 | 完成：UTF-8 无 BOM、中文注释 fixture、Node 测试 |

### 2.4 原型与发布

- live 原型通过 loopback HTTP + SSE 使用真实 orchestrator；离线 file:// 保留原演示。
- 安全边界：仅 127.0.0.1、Host/Origin 精确校验、进程 token、JSON allowlist、4KB body、CSP、无任意命令/路径。
- 6 张 1080×1100 截图由 Edge DevTools 驱动真实页面重拍。
- MIT License、CHANGELOG、SECURITY、PRIVACY、CONTRIBUTING、Issue/PR 模板、tag 发布 workflow 已补齐。

---

## 3. 架构与代码地图

```
CLI / live server
  └── UpdateOrchestrator
        ├── PluginGate ── ProfileStore → cordis.patch.yml + restore.json
        ├── UpdateJournal（prepared/applying/verifying/committed + 回滚）
        ├── Watchdog / watchdog-helper（detached）
        ├── FileLock（单飞 + 陈旧接管）
        └── Telemetry / I18n
Backend
  ├── NpmBackend（registry/SRI/staging/原子切换/快照/pnpm）
  ├── ElectronUpdaterBackend（Coordinator 委托）
  └── FakeBackend（测试/演示/故障注入）
```

关键文件：

| 文件 | 职责 |
|---|---|
| `src/orchestrator.mjs` | 状态机、staging 门控、回滚决策、取消边界 |
| `src/journal.mjs` | 状态迁移协议、同状态证据注解、归档 |
| `src/profile-store.mjs` | 真实 patch 禁用/恢复 |
| `src/backends/npm.mjs` | 真实 profile 更新路径 |
| `src/watchdog-helper.mjs` | 崩溃恢复 helper |
| `src/local-server.mjs` | live UI 安全服务 |
| `test/staging-verify.test.mjs` | staging 四类验收与零污染 |
| `test/atomic-fs.test.mjs` | 原子切换/回滚注入测试 |
| `scripts/smoke-registry.mjs` | 真实 registry 冒烟 |
| `scripts/capture-previews.mjs` | Edge live 截图 |

磁盘布局不变：`$DSH_HOME/updates/{update-journal.json,history,watchdog.json,update.lock,staging,backup}` 与 `profiles/<name>`。

---

## 4. 外部验收与未解问题

以下不是代码内可替代的验收，不能标记为“真机通过”：

1. **真实 dsh staging 端到端**：当前开发机 Node 22，registry 的 dsh 0.2.2-rc.1 要求 Node ≥24.9.0。需在 Node 24.9+ 上以真实 profile 跑一次 `--dump-config` 与启动，确认官方 patch 禁用语义和插件错误日志身份提取。
2. **Windows Desktop / macOS Desktop**：需真实 dsh Desktop 宿主、NSIS/DMG、签名与公证；当前只有适配器注入测试。
3. **远端 CI**：仓库与 `v0.2.0` 已通过 v2rayN 代理上传。首轮 CI 暴露跨平台测试路径问题，已在 `411df98` 修复；最终 12 矩阵运行结果以 GitHub Actions 页面为准。
4. **真实 native 构建**：allowBuilds 路径已实现，但未在 node-pty/koffi 等真实包上跑工具链。
5. **npm 发布**：`0.2.0` 包已具备 exports/LICENSE/repository，但未发布到 npm；需要 owner 的发布凭据与最终批准。

处理原则：以上失败时宁可阻止更新或安全回滚，不做“看起来成功”的降级。

---

## 5. 常用验收命令

```bash
npm test
npm run smoke:registry
for f in $(find src test scripts -type f -name '*.mjs'); do node --check "$f"; done

node src/cli.mjs demo --scenario success --fast
node src/cli.mjs demo --scenario partial --fast
node src/cli.mjs demo --scenario blocked --fast
node src/cli.mjs demo --scenario rollback --fast
node src/cli.mjs demo --scenario safe --fast
node src/cli.mjs demo --scenario download-fail --fast
node src/cli.mjs demo --scenario cancel --fast

node src/cli.mjs status --home <dir>
npm run ui
```

退出码：success/partial/cancel 0；failed/rollback 1；blocked 2；safe-mode 3。

---

## 6. 约束

- Node ESM、零第三方运行时依赖；Node ≥20 可运行，目标 dsh 版本可要求更高 Node（已预检）。
- 不修改 `ALLOWED_TRANSITIONS` 语义，不绕过 journal。
- `PluginGate.verify()` 只能位于 staging 阶段。
- 测试只使用 OS 临时目录；`NpmBackend` 会真实改名/复制 profile，禁止指向未备份的真实 home。
- `.workbuddy/` 是本地项目记忆，不发布、不删除。
- `docs/双模型协作分工方案.md` 与本更新器交付无关，未修改。

---

_若代码与本文不一致，以 `npm test`、`src/` 与 README 最新决策为准。_
