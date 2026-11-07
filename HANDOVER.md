# DeepSeek Harness 一键更新方案 · 交接文档

> 更新时间：2026-11-08 00:27（UTC+8）  
> 适用对象：接手本项目的模型 / 工程师  
> 当前版本：README 1.2；参考实现 `0.1.0`；测试 61 项  
> 项目根目录：`C:\Users\18316\Desktop\DeepSeek-Harness-一键更新方案`

---

## 0. 先做这三件事

1. 在项目根目录执行 `npm test`，确认 61 项全部通过。
2. 执行 `node src/cli.mjs demo --scenario success --fast`，看到 `[succeeded]` 与 journal 路径。
3. 阅读 `README.md` 的 §0、§4.2、§5、§7，再读 `src/orchestrator.mjs` 和 `test/integration.test.mjs`。

完成这三步即可在不了解前情的情况下接手。

---

## 1. 任务目标

### 1.1 产品目标

为 DeepSeek Harness（`dsh`）提供**一个按钮完成版本更新**的能力，并满足四个约束：

1. 更新核心版本的同时，保证已安装插件在新版本上仍可加载。
2. 不兼容插件可以禁用但**不删除**，并且可恢复。
3. 切换失败、自检失败、启动失败都能自动回滚；回滚失败进入安全模式。
4. 结果可解释：用户看到发生了什么、是否已回滚、下一步做什么。

### 1.2 当前阶段的目标

把设计文档中的核心链路落成**可运行、可测试、可替换后端**的参考实现，作为后续接入真实 dsh / Desktop 的基线。

当前阶段已完成；下一阶段目标是把参考实现接入真实宿主（见 §4）。

### 1.3 非目标

- 不是完整 dsh 运行时，不实现插件加载器、Cordis、会话格式本身。
- 不是完整 Electron 安装器；桌面安装/重启/原生恢复仍归 `electron-updater` 与 `DesktopUpdateCoordinator`。
- 不是完整包管理器；npm 后端只负责 registry 解析、校验、staging 安装与 profile 切换。
- 不追求 npm `semver` 的全量语法；当前是覆盖更新器场景的子集。

### 1.4 术语

| 术语 | 含义 |
|---|---|
| dsh / Harness | DeepSeek Harness，目标产品 |
| profile | `$DSH_HOME/profiles/<name>`，由依赖、bundle、patch 组成 |
| plugin / bundle | 可安装到 profile 的 npm 包，向运行时贡献能力或配置层 |
| gate | 插件兼容门控：判断 update / keep / disable / manual / block |
| journal | 更新事务日志，双阶段提交与崩溃恢复的依据 |
| watchdog | 切换后观察新版本是否能正常启动的独立状态机 |
| staging | 下载并安装好的候选 profile，尚未切换为正式 profile |
| L0/L1 快照 | L0 配置（package.json/lockfile/patch），L1 整个 profile |

---

## 2. 当前进展与已完成工作

### 2.1 交付物

| 文件 / 目录 | 内容 | 状态 |
|---|---|---|
| `README.md` | 设计方案 1.2：调研、选型、17 状态、8 阶段、门控、回滚、错误码、实施计划 | 完整 |
| `prototype.html` | 单页可交互原型，覆盖 17 个状态 + 部分成功分支 + 故障注入 | 可运行，尚未接核心 |
| `state-machine.svg` | 主流程、硬阻断、自动回滚、安全模式 | 已修正自检失败分支 |
| `preview*.png` | 6 张关键状态截图（1080×1100） | 与当前原型一致 |
| `src/` | 零依赖 Node 参考实现，15 个模块 | 完整，61 项测试 |
| `test/` | 8 个测试文件，61 项用例 | 全部通过 |
| `package.json` | ESM、Node ≥ 20、`test` / `demo` / `status` 脚本 | 完整 |

### 2.2 已实现的核心能力

- **编排**：检查 → 解析兼容集 → 快照 → 下载/校验/暂存 → 任务排空 → 原子切换 → 自检 → 提交；失败回滚、用户取消、安全模式。
- **单飞与并发**：`FileLock`（`update.lock`），陈旧锁 10 分钟可接管，切换阶段续心跳。
- **Journal**：原子写、7 个状态、合法迁移校验、终端 journal 归档、启动恢复判定。
- **Watchdog**：武装、心跳、截止时间、启动次数、版本不匹配判定；提交后心跳，回滚后解除。
- **插件门控**：`engines.dsh` 优先、`@deepseek-ai/dsh*` peer 回退、5 种处置、未知范围标记 staging 验证、禁用/恢复存储。
- **后端**：
  - `FakeBackend`：内存、全阶段故障注入，测试/演示用。
  - `NpmBackend`：dist-tag、SRI 校验、staging `npm install`、profile 原子切换、快照回滚、路径边界校验。
  - `ElectronUpdaterBackend`：autoUpdater 适配、下载进度、安装交接；健康/回滚明确委托。
- **i18n**：8 种语言的结果/错误文案、复数规则、回退。
- **遥测**：脱敏（路径/邮箱/令牌/URL 凭据）、采样、内存 sink、永不因 sink 失败影响更新。
- **CLI**：`demo` 覆盖 success / partial / blocked / rollback / safe / download-fail / cancel；`status` 读取 journal/watchdog。

### 2.3 已验证的行为

截至交接时：

- `npm test`：**61 passed / 0 failed**。
- `node src/cli.mjs demo --scenario success --fast` → 退出 0，journal `committed`。
- `partial` → 退出 0，结果含 2 个插件禁用。
- `blocked` → 退出 2，无 journal 写入。
- `rollback` → 退出 1，journal `rolled-back`，版本恢复。
- `safe` → 退出 3，journal `failed` + `safeMode: true`。
- `download-fail` → 退出 1，版本未改动。
- `cancel` → 退出 0，journal 被丢弃，零改动。
- 集成测试：真实临时 profile + 假 registry/installer，完成 `0.2.2-rc.1 → 0.2.3`，再手动回滚到旧版本。

### 2.4 明确未完成的部分

见 §4。最重要的五项：真实 profile 的 `cordis.patch.yml` 禁用写入、staging 启动自检、Desktop  Coordinator 接入、watchdog helper 进程、遥测上报端点。

---

## 3. 架构与代码地图

### 3.1 分层

```
CLI / Host (src/cli.mjs, apps/desktop)
        │
UpdateOrchestrator (src/orchestrator.mjs)
        │   ├── PluginGate (src/plugin-gate.mjs)
        │   ├── UpdateJournal (src/journal.mjs)
        │   ├── Watchdog (src/watchdog.mjs)
        │   ├── FileLock (src/lock.mjs)
        │   └── Telemetry / I18n
        ▼
Backend 接口
  ├── NpmBackend (src/backends/npm.mjs)
  ├── ElectronUpdaterBackend (src/backends/electron-updater.mjs)
  └── FakeBackend (src/backends/fake.mjs)
```

### 3.2 文件职责

| 文件 | 职责 | 改动时注意 |
|---|---|---|
| `src/orchestrator.mjs` | 状态机、流程编排、回滚决策、锁与进度 | 状态名与 README 4.2 一致；不要绕过 journal |
| `src/journal.mjs` | 事务日志、迁移、归档、恢复 | 迁移表 `ALLOWED_TRANSITIONS` 是协议 |
| `src/watchdog.mjs` | 启动观察状态机 | `evaluate` 的 `boot:true` 只在真实新进程启动时传 |
| `src/plugin-gate.mjs` | 兼容判定、版本选择、五种处置、禁用存储 | `verify()` 是 staging 阶段调用，不在 check 阶段 |
| `src/backends/npm.mjs` | registry、SRI、staging、切换、回滚 | 必须先 `check()` 再 `prepare()`；默认不碰真实 home |
| `src/backends/electron-updater.mjs` | 桌面适配 | 健康/回滚委托，`delegated` 不应被当作已验证 |
| `src/backends/fake.mjs` | 测试/演示 | `failAt` 支持字符串或数组 |
| `src/errors.mjs` | `UPD-*` 错误码、内部码映射 | 新错误先加 spec，再加 i18n key |
| `src/i18n.mjs` | 8 语言 catalog | 新增 key 要同步 8 个 locale |
| `src/telemetry.mjs` | 脱敏、采样、sink | 不发送插件名/配置内容 |
| `src/lock.mjs` | 单飞锁 | 长任务要 `touch()` |
| `src/json-store.mjs` | 原子 JSON 读写/隔离 | journal/watchdog/lock 共用 |
| `src/cli.mjs` | demo/status | 退出码是契约：0/1/2/3 |
| `prototype.html` | UI 原型 | 与核心独立，不要混入 Node API |
| `README.md` | 设计事实源 | 代码与文档冲突时，先确认哪边是最新决策 |

### 3.3 核心 API 速查

```js
const orchestrator = new UpdateOrchestrator({
  backend, gate, journal, watchdog, telemetry, i18n, home, channel: 'stable'
});

orchestrator.subscribe((state) => { /* UI/日志 */ });
await orchestrator.check({ manual: true });
await orchestrator.start({ confirm: true }); // 有 disable 时必须 confirm
await orchestrator.cancel();                 // 仅激活前有效
await orchestrator.rollback();               // 最近一次 committed 更新
await orchestrator.recover({ currentVersion });
orchestrator.setChannel('nightly');
```

Backend 契约（必需方法）：

| 方法 | 作用 |
|---|---|
| `getCurrentVersion()` | 当前核心版本 |
| `check(channel)` | 返回候选 release 数组 |
| `listPlugins()` | 当前已安装插件 |
| `resolvePlugins(release, installed)` | 候选插件版本（可选） |
| `snapshot()` | 建立回滚点（可选） |
| `prepare(plan, {onProgress, signal})` | 下载/校验/暂存 |
| `drain({signal})` | 等待运行中任务（可选） |
| `activate(staged)` | 原子切换，返回 `{commit, rollback}` |
| `health(handle)` | 自检，返回 `{ok, checks}` |
| `rollback(journal)` | 后端级回滚（可选） |
| `cleanup()` | 清理（可选） |

### 3.4 状态机

```
idle
  └─ check → checking
        ├─ up-to-date
        ├─ blocked
        ├─ available-incompatible
        └─ available
              └─ start → preparing → downloading → verifying
                    → staged → draining → activating
                          ├─ succeeded
                          ├─ rolled-back
                          └─ safe-mode
```

- Journal 状态：`prepared → applying → verifying → committed`；失败分支 `rolling-back → rolled-back / failed`。
- `committed` 允许手动回滚到 `rolling-back`。
- 取消只允许在 `applying` 之前。

### 3.5 磁盘布局

```
$DSH_HOME/
  updates/
    update-journal.json          # 当前事务
    history/<journal-id>.json    # 已结束事务归档
    watchdog.json                # 启动观察
    update.lock                  # 单飞锁
    staging/<id>/                # 候选 profile
    backup/<profile>-<id>/       # 回滚点
  profiles/<name>/               # 正式 profile
```

---

## 4. 待完成事项与优先级

### P0（接真实用户前必须完成）

| ID | 任务 | 为什么 | 落点 | 验收标准 |
|---|---|---|---|---|
| P0-1 | 写真实 `cordis.patch.yml` 的禁用/恢复 | 现在只写 `plugins.json`，dsh 不会读，等于“禁用”没生效 | `src/backends/npm.mjs`、`src/plugin-gate.mjs`，建议新增 `src/profile-store.mjs` | 不兼容插件在 dsh 中确实不加载；`restore` 能移除 `disabled`；有单元与 fixture 测试 |
| P0-2 | staging 启动自检 | 目前 health 只比版本和 `plugins.json`，插件 import 失败抓不到 | `src/orchestrator.mjs` 的 prepare 与 switch 之间；`PluginGate.verify`；可注入 `stagingVerifier` | 故意放一个坏插件，staging 启动失败 → 可选插件 disable / 核心插件 block；正式 profile 零改动 |
| P0-3 | 接入 Desktop Coordinator | 适配器目前只调用 `quitAndInstall`，真实重启/失败/原生回滚未验证 | `src/backends/electron-updater.mjs` + dsh Desktop 主进程 | Windows NSIS 与 macOS 安装、启动失败回滚、原生恢复对话框验收 |
| P0-4 | watchdog helper 进程 | 现在只有状态机；主进程崩溃时没有人执行回滚 | `src/watchdog.mjs` + 新 `src/watchdog-helper.mjs`，`orchestrator` 切换前 spawn | kill 新进程 → 旧版本恢复；helper 崩溃 → 下次启动 `recover` 兜底 |
| P0-5 | 遥测上报端点与隐私评审 | 现在只有内存 sink，没有实际上报 | `src/telemetry.mjs` + 新 `HttpSink` | 无 PII、采样生效、失败不影响更新、可关闭 |

### P1（生产化前完成）

| ID | 任务 | 说明 |
|---|---|---|
| P1-1 | npm 原生构建 / pnpm / `allowBuilds` | 当前 `npm install --ignore-scripts`，native 插件会缺构建产物 |
| P1-2 | 快照成本与保留策略 | 现在 `cp` 整个 profile（含 `node_modules`）；应区分 L0/L1，限制 backup 数量与天数 |
| P1-3 | semver 完整语义或替换 | 当前是子集；alias、复杂 workspace、极端范围可能误判。可评估引入 `semver` |
| P1-4 | 真实 registry / 真实 Electron 冒烟 | 现有测试全部用 fake fetch/installer，真实网络与签名未验证 |
| P1-5 | 清理 `.failed-*` / 旧 backup / journal history | 目前只清 staging 7 天；长期运行会占磁盘 |
| P1-6 | CI + git 初始化 | 当前目录没有 `.git`、没有 CI；建议先 `git init`，再加 `npm test` 矩阵 |
| P1-7 | 锁的竞态加固 | 两个进程同时判定“陈旧锁”时有极小概率互相接管；可加 token + 二次校验 |

### P2（体验与演示）

| ID | 任务 | 说明 |
|---|---|---|
| P2-1 | 原型接核心 | 用本地 HTTP/WS 把 `prototype.html` 的模拟进度换成真实 `orchestrator` 事件；当前两者独立 |
| P2-2 | 原型 i18n | 核心已有 8 语言，原型仍硬编码中文；可共享 message key |
| P2-3 | 文档与截图同步 | 改原型后重拍 `preview*.png`；README 版本记录同步 |
| P2-4 | 错误码 UI 映射 | 把 `UPD-*` 与主操作、可重试性在 UI 中显式展示 |

### 建议顺序

1. P0-1（禁用真正生效）→ P0-2（staging 自检）：先把“更新后插件可用”闭环。
2. P0-4（watchdog helper）→ P0-3（Desktop）：把“失败能回来”闭环。
3. P0-5（遥测）→ P1-4/P1-6（真实冒烟 + CI）：把可观测与回归闭环。
4. P1-1/P1-2（native 与快照）→ P2（原型接核心）。

---

## 5. 关键约束与注意事项

### 环境与工程

- Node **≥ 20**，ESM，零第三方依赖；新增依赖前先确认是否接受破坏“零依赖”。
- 主要开发环境是 Windows（Git Bash）；代码本身跨平台，路径处理用 `node:path`。
- 没有 `.git`；改动是直接覆盖文件。建议接手后第一步 `git init` 并提交当前基线。
- 测试只使用 OS 临时目录与 fake registry/installer；**不要**把测试指向真实 `$DSH_HOME`。
- `npm test` 使用 Node 内置 test runner，不需要安装依赖。

### 行为约束

- `orchestrator.start()` 在 `plan.disables > 0` 时必须显式 `{ confirm: true }`，否则抛 `UPD-201`。
- 取消只在 `applying` 之前有效；`activating` 之后不允许取消。
- Journal 迁移必须走 `ALLOWED_TRANSITIONS`；不要手写 journal 绕过。
- `PluginGate.verify()` 是 staging 阶段的能力，不要放回 `check()`；否则会在安装前误禁用插件。
- `Watchdog.evaluate({ boot: true })` 只在真实新进程启动时传；轮询不要传，否则会误判 boot loop。
- `Watchdog` 提交后需要 `beat()`；参考实现已在 commit 后调用。若换宿主，必须保留。
- 遥测只发聚合字段；插件名、配置内容、路径、令牌都不能上报。
- 原型是独立 UI，不要为了复用把 Node API 塞进 `prototype.html`。

### 文件与目录

- `.workbuddy/` 是项目记忆，**不要删除**。
- `docs/双模型协作分工方案.md` 与当前更新器任务无关，**不要修改或纳入交付说明**。
- 原型截图 `preview*.png` 是 1080×1100；改 UI 后需要重拍，否则会与代码不一致。
- `README.md` 是设计事实源；代码偏离时，先判断是文档过时还是实现缺陷，再同步。

### 安全

- 不要对真实 `$DSH_HOME` 运行 `NpmBackend`，除非已备份 profile；它会改名/复制 profile 目录。
- 所有回滚路径必须限制在 `updates/backup` 下；`NpmBackend.rollback` 已有前缀校验，不要移除。
- registry 必须是 HTTPS（localhost 例外）；URL 不得含凭据。
- 安装脚本默认 `--ignore-scripts`；放开前必须实现 allowlist / 风险提示。

---

## 6. 已知问题与风险

| 级别 | 领域 | 现象 | 影响 | 缓解 / 下一步 |
|---|---|---|---|---|
| 高 | 插件禁用 | `plugins.json` 不是 dsh 的配置格式 | “已禁用”在真实 dsh 中不生效 | P0-1 写 `cordis.patch.yml` |
| 高 | 自检 | health 只检查版本与 `plugins.json` | 插件 import/启动日志失败漏检 | P0-2 staging 启动 + 日志证据 |
| 高 | Desktop | `health` 返回 `ok: true, delegated: true` | 编排器可能把“未验证”当成功 | P0-3 接入 Coordinator；在 UI 标记 delegated |
| 高 | 崩溃恢复 | 没有 detached watchdog helper | 主进程崩溃时无人回滚 | P0-4 |
| 高 | 真实环境 | 测试全部 fake，未跑真实 npm/Electron | 生产行为未知 | P1-4 受控冒烟 |
| 中 | 快照 | `cp` 整个 profile 含 `node_modules` | 磁盘/耗时大，可能超时 | P1-2 L0/L1 分级、增量快照 |
| 中 | native | `--ignore-scripts` | native 插件缺构建产物 | P1-1 pnpm/allowBuilds |
| 中 | semver | 子集实现 | 极端范围误判 | P1-3 补测试或换库 |
| 中 | 清理 | `.failed-*`、旧 backup 不自动清 | 长期磁盘增长 | P1-5 保留策略 |
| 中 | 工程 | 无 git / 无 CI | 回归不可追踪 | P1-6 |
| 中 | 原型 | 与核心未接线 | 演示进度是模拟值 | P2-1 |
| 低 | 锁 | 陈旧锁接管存在极小竞态 | 双进程同时更新概率极低 | P1-7 二次校验 |
| 低 | 历史 | journal history 无限增长 | 磁盘缓慢增长 | P1-5 |
| 低 | i18n | 核心 8 语言，原型仅中文 | 演示不一致 | P2-2 |
| 低 | 文档 | `docs/双模型协作分工方案.md` 无关 | 误改风险 | 不要动 |

---

## 7. 建议的后续执行步骤

### Step 0：建立基线

1. `git init`，提交当前全部文件（包括 `src/`、`test/`、原型、README）。
2. `npm test`，确认 61/61。
3. 跑一遍 §8 的 CLI 场景，记录输出。

### Step 1：选定下一个里程碑

建议先做 **P0-1 + P0-2**，因为它们是“更新后插件仍然可用”的核心承诺；不要先做 UI 接线。

### Step 2：P0-1 真实禁用写入

1. 新增 `ProfileStore` 接口：`disable(plugin, reason)`、`enable(handle)`、`list()`。
2. 在 staging 中修改 `cordis.patch.yml` 对应行，写 `disabled: true`；同时保留 `restore.json`。
3. 用 fixture profile 做测试：disable → `dsh --dump-config` 不含该行；enable → 恢复。
4. 替换 `JsonPluginStore` 的默认实现；保留 JSON 作为测试后端。

### Step 3：P0-2 staging 启动自检

1. 在 `prepare` 完成后、`journal.transition('applying')` 前，运行 staging 启动。
2. 注入 `stagingVerifier(plan)`：启动 staging profile，抓 `--version`、`--dump-config`、启动日志。
3. 失败时：可选插件 → disable；核心插件 → block；写证据到 journal/audit。
4. 测试：坏插件、超时、端口占用、正常四种。

### Step 4：P0-4 watchdog helper

1. 新增 `src/watchdog-helper.mjs`，参数只接受 journal 路径、profile、port、timeout。
2. 切换前 `spawn(detached).unref()`；helper 等旧 PID 退出、启动新版本、轮询健康、写 journal。
3. 失败走 `backend.rollback`；helper 崩溃由 `orchestrator.recover` 兜底。
4. 测试：kill 新进程、helper 自身崩溃、回滚失败进安全模式。

### Step 5：P0-3 Desktop

1. 在 Desktop 主进程注入真实 `autoUpdater`。
2. 保持 `delegated: true`，由 Coordinator 负责重启后健康与原生恢复。
3. Windows NSIS + macOS 手工验收；失败注入至少覆盖安装失败、启动失败。

### Step 6：P0-5 遥测 + P1-6 CI

1. `HttpSink` 使用固定端点、超时、失败即丢弃；默认关闭，需显式启用。
2. 隐私评审：只发事件名、版本、耗时、错误码、插件数量。
3. CI：`npm test` + `node --check`；不需要安装依赖。

### Step 7：P2 原型接核心（可选）

1. 起一个本地 HTTP/WS server，暴露 `check/start/cancel/rollback` 与状态事件。
2. 原型把 `setTimeout` 模拟替换为事件订阅；保留 devbar 作为故障注入。
3. 重拍 6 张截图，更新 README。

### 不要做

- 不要在未备份的情况下对真实 `$DSH_HOME` 跑 npm 后端。
- 不要删除/手改 journal 来“跳过”失败；启动恢复会依赖它。
- 不要把 `gate.verify()` 提前到 check 阶段。
- 不要把 Desktop 的 `delegated` 当成本机已验证。
- 不要修改 `docs/双模型协作分工方案.md`。

---

## 8. 常用命令与验收清单

```bash
# 环境
node -v            # 需 >= 20
npm test           # 61 passed

# CLI 演示
node src/cli.mjs demo --scenario success --fast
node src/cli.mjs demo --scenario partial --fast
node src/cli.mjs demo --scenario blocked --fast
node src/cli.mjs demo --scenario rollback --fast
node src/cli.mjs demo --scenario safe --fast
node src/cli.mjs demo --scenario download-fail --fast
node src/cli.mjs demo --scenario cancel --fast

# 查看某个 home 的 journal/watchdog
node src/cli.mjs status --home <dir>

# 语法检查（无构建步骤）
for f in $(find src test -name '*.mjs'); do node --check "$f"; done
```

退出码契约：

| 场景 | 退出码 |
|---|---|
| success / partial / cancel | 0 |
| failed / rollback | 1 |
| blocked | 2 |
| safe-mode | 3 |

手工验收：

- [ ] `npm test` 全绿。
- [ ] success 的 journal 为 `committed`，watchdog `armed` 且 `heartbeats >= 1`。
- [ ] rollback 的 journal 为 `rolled-back`，版本回到 `0.2.2-rc.1`。
- [ ] safe 的 journal 为 `failed` 且 `safeMode: true`。
- [ ] cancel 后 journal 文件不存在，版本未变。
- [ ] blocked 不产生 journal。
- [ ] `node src/cli.mjs status --home <demo-home>` 能打印 journal/watchdog。

---

## 9. 交接确认清单

- [ ] 已读 README §0、§4.2、§5、§7。
- [ ] 已跑 `npm test` 与 7 个 CLI 场景。
- [ ] 已确认 `docs/双模型协作分工方案.md` 与本任务无关，不会修改。
- [ ] 已知晓 `.workbuddy/` 是项目记忆，不删除。
- [ ] 已确认没有 git 历史，准备先 `git init`。
- [ ] 已选定下一里程碑（建议 P0-1 + P0-2）。
- [ ] 已知晓 `NpmBackend` 会真实改动 profile，测试只用临时目录。
- [ ] 已知晓 Desktop 健康检查是委托状态，不是本机验证。

---

## 10. 关键参考

- 设计事实源：`README.md`（§4 按钮状态机、§5 流程、§6 插件兼容、§7 回滚、§8 错误码、§10 实施计划）。
- 核心入口：`src/orchestrator.mjs` 的 `UpdateOrchestrator`。
- 端到端范例：`test/integration.test.mjs`。
- 后端契约范例：`src/backends/fake.mjs`（最小实现）与 `src/backends/npm.mjs`（真实路径）。
- 事务格式：`src/journal.mjs` 顶部 `JOURNAL_SCHEMA` / `ALLOWED_TRANSITIONS`。
- 错误码：`src/errors.mjs` 的 `ERROR_SPECS` 与 `INTERNAL_TO_PUBLIC`。
- 状态图：`state-machine.svg`。
- 视觉参考：`preview*.png`。

---

_交接文档结束。若代码行为与本文不一致，以 `npm test`、`src/` 实现和 README 的最新版本为准，并在下一次提交中同步修正本文。_
