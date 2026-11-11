# DeepSeek Harness 一键更新器

> 版本：2.0
> 日期：2026-11-09
> 适用：DeepSeek Harness（`dsh`）0.2.x，Cordis「一切皆插件」架构
> 目标：一个按钮完成 Harness 版本更新，并保证现有插件在新版本上仍可加载；失败可回滚，结果可解释。

**当前状态：`dsh-update-core@0.3.11` 可运行、可测试、可复用，仅支持 Windows。** 123 项自动化测试通过；已提供 Desktop 设置页 DSH 插件，可一键更新核心与兼容插件；已覆盖真实 `cordis.patch.yml` 禁用/逐字节恢复、staging 启动门控、原子切换、独立 watchdog、跨平台路径与进程树、默认关闭的遥测上报、真实 registry SRI 冒烟，以及 live 原型。真实 Node 24 + dsh staging 与 Windows Desktop 签名/启动证据见 `docs/REAL_ACCEPTANCE.md`。

---

## DSH 插件：Desktop 一键更新

从 GitHub 下载/克隆本仓库后，把 `plugin/` 安装到 Desktop profile：

```powershell
git clone https://github.com/CJJ18316877669/dsh-update-core.git
cd dsh-update-core
& 'C:\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd' plugin --profile desktop add "file:$PWD\plugin"
```

> 更新插件自身代码后，pnpm 可能复用同版本的 `file:` 目录而漏掉新增文件。先删除
> `%USERPROFILE%\.dsh\profiles\desktop\node_modules\dsh-update-core-plugin`，再执行上面的 `add` 命令。

完全退出并重新打开 DeepSeek Harness，进入：

```text
设置 → 一键更新
```

Desktop 的定位不依赖固定安装目录：会读取运行中的进程路径、卸载项的 `InstallLocation` / `DisplayIcon`，并兼容 `DeepSeek Harness 0.2.1-rc.5` 这类带版本号的 DisplayName，因此自定义安装目录也能识别。

页面会显示当前核心、官方最新核心，以及每个插件的处置：

- 有兼容新核心的更高版本：更新；
- 最新版本不兼容目标核心：保持当前版本，不删除、不禁用；
- git/GitHub 依赖：解析 release/tag，只接受包名、版本和 DSH 兼容性都匹配的版本；
- 同名但仓库不一致：拒绝更新，标记 `repository-mismatch`；
- 可对单个插件“忽略此版本”，上游再发新版本后会重新提示；
- 每 6 小时自动检查一次（可通过 `autoCheckHours` 调整）；
- 展示最近 30 次更新历史，包括核心版本、插件数量和回滚结果。

点击“一键更新并重启”后，更新请求会立即返回，设置页内置的进度条实时显示安装包下载百分比、已下载大小和阶段（下载核心安装包 / 下载回滚安装包 / 关闭 Desktop / 安装核心 / 更新插件 / 启动验证），不再依赖外部窗口。Desktop 重启后，`active-run.json` 会把尚未结束的运行恢复到设置页。插件随后启动外部 helper：关闭 Desktop、下载并校验官方安装包（核心有新版时）、按计划更新 profile 插件、启动新版本并等待插件心跳确认健康。核心更新前还会预先下载当前版本的官方安装包，并备份 profile 清单与锁文件，用于失败自动回滚和手动“回滚上一版本”。

可选配置写在 `~/.dsh/profiles/desktop/cordis.patch.yml` 中：

```yaml
- id: dsh-update-core-plugin
  config:
    autoCheckHours: 6       # 0 关闭定时检查
    autoApply: false         # true 时检查到更新会自动关闭并更新，默认关闭
    githubToken: ''          # 也可用 DSH_GITHUB_TOKEN / GITHUB_TOKEN 环境变量
```

`autoApply: true` 会在后台检查到更新后直接执行“一键更新”，仍会关闭并重启 Desktop，建议只在你明确接受自动重启时开启。

更新插件自身后，强制刷新 `file:` 依赖：

```powershell
npm run plugin:install
```

该脚本会先删除旧的 `node_modules/dsh-update-core-plugin`，再重新执行 `dsh plugin add`，避免 pnpm 复用旧目录。

更新前备份位于：

```text
~/.dsh/updates/dsh-update-plugin/<run>/
```

要求 Windows x64，Desktop 已安装到 `C:\DeepSeek Harness`（或可通过 `DSH_DESKTOP_EXE` 指定）。更新期间会关闭当前 Desktop，未保存的会话可能中断；安装器需要 UAC 时会弹出系统确认。

## 快速开始

要求 Node.js ≥ 20；真实 dsh 当前 release 自身要求 Node.js ≥ 24.9.0，更新器会在下载前按目标包的 `engines.node` 拒绝不满足的宿主。

```bash
npm test                         # 123 项，零依赖
npm run ui                       # live 原型，默认仅监听 127.0.0.1 的随机端口
npm run smoke:registry           # 真实 registry + tarball SRI 冒烟
node src/cli.mjs demo --scenario success --fast
node src/cli.mjs demo --scenario safe --fast
node src/cli.mjs status --home <dir>
```

`npm run ui` 输出一个 `http://127.0.0.1:<port>/` 地址。该页面由本地服务提供，通过 SSE 订阅真实 `UpdateOrchestrator`；直接双击 `prototype.html` 则进入离线 UI 演示。服务只绑定 loopback，校验 Host/Origin、一次性进程 token 与 JSON body，不开放任意路径、命令或 registry。

## 交付物

| 文件 / 目录 | 内容 |
|---|---|
| `README.md` | 设计事实源、调研、状态机、流程、兼容、回滚与当前实现边界 |
| `HANDOVER.md` | 当前实现状态、验收命令、剩余外部风险和交接说明 |
| `src/` | 零依赖 ESM 实现：编排、Journal、watchdog、ProfileStore、门控、后端、路径/进程/文件系统、i18n、遥测、live server |
| `test/` | 123 项单元、集成、CLI 契约、故障注入与安全边界用例 |
| `prototype.html` / `preview*.png` | live/离线双模式原型与 6 张由真实页面重拍的 1080×1100 截图 |
| `scripts/` | 真实 registry 冒烟与 Edge DevTools 截图脚本 |
| `LICENSE` / `CHANGELOG.md` / `SECURITY.md` / `PRIVACY.md` | MIT 许可、版本记录、安全与隐私说明 |
| `.github/workflows/` | 4 平台 × Node 20/22/24 的测试矩阵与 tag 发布流程 |

## 模块与可复用 API

| 模块 | 职责 |
|---|---|
| `src/orchestrator.mjs` | 检查 → 解析 → 快照 → 下载/校验/暂存 → staging 自检 → 排空 → 原子切换 → 自检 → 提交；失败回滚、取消、单飞锁、委托状态 |
| `src/profile-store.mjs` | 以 `cordis.patch.yml` 为唯一事实来源写 `disabled: true`，保留注释/行尾/缩进，`enable` 逐字节恢复 |
| `src/journal.mjs` | fsync 原子写、7 状态迁移、终端归档、启动恢复判定、staging 证据 |
| `src/watchdog.mjs` / `src/watchdog-helper.mjs` | 武装、心跳、截止时间、版本判定；detached helper 在主进程失联时按 journal 回滚 |
| `src/plugin-gate.mjs` | `engines.dsh` / peer 判定、五种处置、staging 回填、证据式禁用 |
| `src/backends/npm.mjs` | dist-tag、SRI、目标 Node/OS/CPU 预检、staging 安装与启动探测、ProfileStore、原子切换、快照回滚、pnpm/allowBuilds |
| `src/backends/electron-updater.mjs` | 桌面 autoUpdater 与 Coordinator 适配；`delegated` 不提交事务 |
| `src/backends/fake.mjs` | 全阶段故障注入，供测试、CLI 和 live 原型 |
| `src/platform/*.mjs` | Windows/POSIX 进程树、rename 重试与 EXDEV 降级、原子写、官方 `$DSH_HOME` 规则、路径边界 |
| `src/telemetry.mjs` | 8 语言配套脱敏、采样、内存 sink、默认关闭的 HTTPS `HttpSink` |
| `src/local-server.mjs` | live 原型的安全 loopback HTTP/SSE 服务 |
| `src/cli.mjs` | `demo` / `ui` / `status`，退出码契约 0/1/2/3 |

包同时提供子路径导出：`dsh-update-core`、`dsh-update-core/backends/npm`、`dsh-update-core/backends/electron-updater`。

```js
import { UpdateOrchestrator, UpdateJournal, Watchdog, PluginGate, NpmBackend } from 'dsh-update-core';
```

## 安全与生命周期不变量

- 不兼容插件只写 `disabled: true`，不删除 `node_modules`；恢复记录只在 `enable` 时用于还原，不作为当前状态来源。
- staging 在 `applying` 之前完成版本、`--dump-config` 和短时启动探测；失败时正式 profile 字节不变。
- 所有终端写入先 fsync 再原子 rename；Windows 共享冲突有界重试，跨卷降级为复制 + 全树哈希校验。
- 回滚不吞 rename 错误；旧 profile 恢复失败会保留 `.failed-*` 绝对路径并进入安全模式。
- 遥测默认关闭；端点必须 HTTPS，只发聚合字段，失败即丢弃，永不影响更新。
- 测试和 demo 只使用 OS 临时目录，绝不指向真实 `$DSH_HOME`。

**平台范围：仅 Windows x64。** 真实 Node 24 + dsh staging、Windows NSIS 安装签名和真实 Host 启动已经完成；真实跨版本 Desktop 升级与 Coordinator 重启仍在 Windows 上验收。代码提供注入点和明确的安全失败路径，不把模拟结果标记为真机通过。

---

## 0. 结论摘要

**没有单一现成方案能端到端覆盖「核心版本 + 插件依赖图 + 桌面/CLI 双形态 + 回滚」这四件事。** GitHub 上最接近的两个 dsh 专用插件是 `Noob-stupid/dsh-plugin-gating-hub`（124 stars，契约预检 + 全树回滚 + 自动禁用）和 `Airmetro/dsh-update-checker`（22 stars，核心/插件更新 + 备份回滚 + watchdog）。它们验证了需求和技术路线，但都是单人维护、发布不足三个月、日更或周更的社区项目，不适合放在 82 万周下载量的核心更新链路上。

**选定方案：组合式一等公民更新器。**

- 桌面端：复用 `electron-updater`。dsh Desktop 已经在 `apps/desktop/src/update-coordinator.ts` 中使用它，渠道、签名、差量下载、任务排空、安装交接都已具备。
- CLI / Web 端：以 npm registry 的 dist-tag、`sha512` 完整性、`semver` 和 pnpm 为原生更新原语，不引入第二套包管理器。
- 产品层新增：`Update Orchestrator`（编排）+ `Plugin Compatibility Gate`（插件兼容门控）+ `Update Journal / Watchdog`（双阶段提交与回滚）+ 统一按钮状态机。
- 社区插件只作为参考实现和可选增强，不进入默认关键路径。

**按钮形态：** 设置 → 关于 → 版本更新 的主按钮；侧栏/账户行显示紧凑状态；桌面端保留现有「检查更新…」菜单作为同一状态机的另一个入口。按钮文案随状态变化，默认一次点击进入完整流程，只在「可能中断任务/禁用插件」时要求一次确认；开启「无人值守更新」且无运行中任务时可跳过确认。

**核心机制：**

1. **原子更新集**：核心与插件在同一个事务里解析、下载、切换；不做「先升核心、再逐个修插件」的混合版本状态。
2. **四层兼容契约**：版本范围（`engines.dsh` / `@deepseek-ai/dsh*` peer）→ 模块/补丁可解析 → 配置 schema → 会话/插件数据格式。
3. **双阶段提交**：`prepared → applying → verifying → committed`；进程在 `applying/verifying` 中崩溃，下次启动自动回滚。
4. **独立 watchdog**：切换前拉起无依赖的 helper 进程，主进程死了也能完成健康检查与回滚。
5. **证据式禁用**：只禁用有硬证据（模块不可解析、`file://` 目标消失、启动日志点名）的可选插件；`@deepseek-ai/*` 与 core 行永不禁用；不删文件，写一条可一键恢复的记录。

---

## 1. 问题与约束

### 1.1 dsh 的更新面不止「一个版本号」

| 层 | 载体 | 当前更新方式 | 更新时的风险 |
|---|---|---|---|
| 桌面壳 | Electron 安装包 | `electron-updater`，stable/nightly 渠道 | 壳、内置 dsh 运行时、pnpm 必须作为**一个签名单元**升级 |
| CLI / Web 核心 | npm 包 `@deepseek-ai/dsh` | `npx`、全局 npm 或源码构建 | 全局安装是原地改写；`npx` 是临时目录，不能原地更新 |
| Profile 配置 | `$DSH_HOME/profiles/<name>` | `dsh plugin --profile <name> ...` 转发 pnpm | `package.json`、`pnpm-lock.yaml`、`cordis.patch.yml` 三者必须一致 |
| 插件（bundle） | npm / git / `link:` / `file:` | pnpm 安装，`dsh.profile.bundles` 记录顺序 | 插件的 `engines.dsh` 或 peer 范围可能不包含新核心 |
| 插件运行时代码 | Cordis Fiber | `apply` / `inject` / `ctx.effect` | 新核心移除 API、改服务名、改 client slot，都会让插件 FAILED |
| 会话与持久化 | JSONL / Session V4 | 版本化迁移 | 旧核心可能拒绝新格式；跨格式回滚可能读不回数据 |

### 1.2 五种安装形态，能力边界不同

| 形态 | 识别方式 | 能否一键原地更新 | 设计动作 |
|---|---|---|---|
| Desktop | `process.versions.electron`、`app-update.yml`、`profiles/desktop` | 能，交给 Electron 原生更新器 | 按钮打开/聚焦原生更新弹窗，不执行 npm |
| 全局 npm | `npm root -g` 下存在 `@deepseek-ai/dsh` | 能，但需备份全局树 | `npm install -g` + 全树备份 + 健康检查 |
| `npx` 临时运行 | 安装根在 npm `_npx` 缓存，父进程是 npx | 不能可靠原地更新 | 按钮显示「临时运行」，复制 `npx @deepseek-ai/dsh@latest web` |
| 源码 checkout | 存在 `pnpm-workspace.yaml`、`.git` | 不应由产品按钮做 | 显示 dev 模式说明，引导 `git pull && pnpm install && pnpm build` |
| SDK / 嵌入运行时 | Python wheel 或 SDK 自带 dsh | 由宿主管理 | 只检查版本并提示，不自动改宿主 |

> 关键结论：**按钮必须先识别安装形态，再决定后端。** 对 `npx` 和源码模式「假装能一键更新」比不更新更危险。

### 1.3 为什么普通 updater 不够

- **插件图是版本约束的一部分。** 只把 `@deepseek-ai/dsh` 升上去，插件可能全部 FAILED；启动器虽然会用 `engines.dsh` 拒绝不兼容行，但用户看到的是「更新后插件没了」。
- **profile 是用户资产。** `cordis.patch.yml` 里有用户覆盖；patch 按 id 替换整段 config，不做深合并。升级核心时如果 schema 变了，用户配置可能直接失效。
- **任务不能随便中断。** 桌面端已有「运行中 agent / 排队消息 / 后台任务」检查；Web 端没有统一的排空机制，需要补。
- **数据格式可能是单向门。** 当前 Session 格式为 V4；旧读取器可能拒绝新载荷版本。跨格式回滚不能只还原代码。
- **Windows 文件语义特殊。** 文件句柄会阻止目录 rename，杀进程、重试退避和文件占用检测必须按 Windows 行为设计。

### 1.4 设计目标与非目标

**目标**

- 一次点击完成：检查 → 解析兼容集 → 预检 → 下载校验 → 排空 → 切换 → 自检 → 提交。
- 升级前可预知影响：列出将更新的插件、将禁用的插件、将中断的任务。
- 任何阶段失败都不留下「半更新」状态；能自动回滚的自动回滚，不能的进入安全模式。
- 结果与异常可解释：稳定的错误码、用户可执行的下一步、可复制的诊断信息。

**非目标**

- 不做插件市场、插件推荐、插件自动生成。
- 不做企业级灰度舰队管理（只预留 channel / staging 接口）。
- 不替代操作系统包管理器（Homebrew、winget、apt）的升级路径。
- 不在未打包的开发模式或源码 checkout 中执行自动更新。

---

## 2. GitHub 方案调研

> 数据采集时间：2026-11-07。Star / issue 数为 GitHub API 当时值；周下载量为 npm API 2026-10-31 至 2026-11-06 的值。

### 2.1 筛选标准

| 维度 | 要求 |
|---|---|
| 覆盖范围 | 至少覆盖「核心 + 插件」之一；能同时覆盖桌面与 CLI 更好 |
| 可行性 | 与 dsh 的 npm / Electron / Cordis 技术栈匹配，不需要重写打包链 |
| 兼容性 | 能表达并检查插件版本范围；能处理 profile / patch / lockfile |
| 回滚 | 有备份、健康检查、失败恢复中的至少两项 |
| 维护状态 | 近 3 个月有提交；有 release；issue 有响应；许可证清晰 |
| 关键路径风险 | 维护者数量、发布节奏、是否单人项目、是否会被第三方代码接管更新 |

### 2.2 候选总表

| 方案 | 可行性 | 与 dsh 的兼容性 | 回滚能力 | 维护状态（2026-11-07） | 结论 |
|---|---|---|---|---|---|
| **electron-updater**（electron-builder） | 高。Electron 原生更新器，dsh Desktop 已在用 | 高。渠道、签名、差量、安装交接齐全；不管插件 | 无应用级自动回滚；需外层健康检查/旧版重装 | 14,704 stars；周下载 607 万；2026-11-06 活跃；52 open issues；MIT | **选用（桌面后端）** |
| **Velopack** | 中。跨平台安装/更新，但面向 .NET/C++ | 低。需替换 electron-builder 打包链；不解决插件图 | 有 delta/channels；无插件兼容层 | 2,447 stars；2026-11-06 活跃；40 open issues | 不选 |
| **Google Omaha** | 低。Windows 专用 C++ 更新器 | 低。仅 Windows；已归档 | 成熟但过重；不管插件 | 2,617 stars；**archived** | 不选 |
| **Tauri updater** | 低。Tauri 应用专用 | 低。dsh 是 Electron，技术栈不匹配 | 签名/渠道；不管插件 | Tauri 112,585 stars；活跃 | 不选 |
| **self_update / go-update** | 低。Rust/Go 可执行文件自更新 | 低。语言/运行时不符 | 无插件/配置 | self_update 967 stars；活跃 | 不选 |
| **update-notifier** | 中。CLI 更新提示 | 低。只提示，不安装 | 无 | 1,812 stars；周下载 1,139 万；活跃 | 仅借鉴提示层 |
| **npm-check-updates** | 中。改 package.json 版本范围 | 低。不执行安装、不做健康检查 | 无 | 10,325 stars；活跃 | 不选 |
| **dsh-plugin-gating-hub** | 高。dsh 专用，契约预检 + 全树回滚 + 门控 + 市场 | 高。直接操作 profile / patch / `engines.dsh` | **很强**：回滚点、失败自动回滚、一键回上一版、证据式自动禁用 | 124 stars；周下载 6,737；v0.5.109（2026-11-07）；0 open issues；MIT；**单人维护、日更 5 版** | **不放关键路径；作为参考/可选增强** |
| **dsh-update-checker** | 高。dsh 专用，核心 + 插件更新 | 高。Web/Desktop 双形态，lockfile 持久化，桌面委托 | **强**：备份、回滚、watchdog、降级保护；桌面不能回滚 | 22 stars；周下载 1,235；v1.7.3（2026-10-21）；6 open issues；MIT；**单人维护** | **不放关键路径；作为参考/可选增强** |

补充候选：

| 方案 | 说明 | 结论 |
|---|---|---|
| `DSH-Plugins-Marketplace`（202 stars） | 市场为主，安装/更新是附属能力 | 不选为更新内核 |
| `dsh-plugin-workshop`（25 stars） | Steam Workshop 风格，一键安装/更新/卸载 | 太薄，缺少回滚 |
| `DshCockpit`（40 stars） | 桌面驾驶舱，带 runtime 自动更新/回滚 | 场景太窄 |
| `dsh-plugin-updates`（22 stars） | 插件自动更新，24h 检查，备份/回退 | 只覆盖插件，不覆盖核心 |

### 2.3 通用更新框架逐项评估

**electron-updater**

- 优点：Electron 生态事实标准；周下载 607 万；本项目使用其 Windows NSIS 渠道、差量下载、`sha512` 校验和安装交接；dsh Desktop 已有生产级适配层（`apps/desktop/src/update-coordinator.ts`），包括 `autoDownload=false`、手动确认、任务排空、安装失败恢复 Host。
- 缺点：没有应用级自动回滚；没有插件概念；不能用于 npm 全局安装或 `npx`。
- 结论：**只把它当桌面后端，不当全局方案。**

**Velopack**

- 优点：Squirrel.Windows 的后继路线，跨平台、delta 更新、安装器体验好。
- 缺点：.NET/C++ 生态；接入意味着替换 electron-builder 打包链；仍然不管 Cordis 插件图。对 dsh 是「为了更新器重做发布体系」，收益不匹配。
- 结论：不选。

**Google Omaha**

- 优点：Chrome 级更新器，灰度、回滚、策略都成熟。
- 缺点：Windows only、C++、已归档；对 dsh 过重。
- 结论：不选。

**Tauri updater**

- 优点：Tauri 生态成熟，签名更新简单。
- 缺点：dsh 不是 Tauri；迁移 WebView 壳的代价远大于更新器收益。
- 结论：不选。

**self_update / go-update**

- 优点：轻量，单二进制自更新。
- 缺点：语言不匹配；没有 Node/Electron 的签名与安装器能力。
- 结论：不选。

**update-notifier**

- 优点：周下载 1,139 万，CLI 提示层非常成熟。
- 缺点：只提示「有新版本」，不下载、不安装、不回滚。
- 结论：可借鉴「检查节流、跳过版本、snooze」的交互，不作为更新内核。

**npm-check-updates**

- 优点：依赖版本解析成熟。
- 缺点：只改 manifest 范围，不执行安装，不做健康检查/回滚；会把「解析」误当成「更新」。
- 结论：不选。

### 2.4 dsh 专用方案逐项评估

**dsh-plugin-gating-hub（最接近「升级安全」）**

- 能力：升级前契约预检（消息契约、依赖 API、配置 schema、移除 API、loader 契约）→ 配置备份 + 全树回滚点 → 在线安装 → 版本校验 → 自动重启；失败自动回滚；升级后「回滚到上一版」；不适配插件强制禁用（服务端 409，不能绕过）；环境指纹可发现「别的更新通道改了框架」；`engines.dsh` / `dsh.engines.framework` 门控；证据式自动禁用。
- 适配度：非常高，几乎是本方案的「社区版参考实现」。
- 风险：
  - 单体 `lib/index.js` 约 8,547 行，维护性差；作者自己在做分层重构预览，尚未验证真实升级/回滚。
  - 单人维护，发布极快（一天 5 个版本），API/行为可能随时变。
  - 「Managed 模式」会接管框架升级；与官方 Desktop updater 存在职责冲突。
  - 第三方代码在更新关键路径上，无法接受第一方签名/审计要求。
- 结论：**借鉴其契约规则库、回滚点、证据式禁用；不作为默认依赖。** 可作为高级用户的「升级安全增强插件」。

**dsh-update-checker（最接近「一键更新」）**

- 能力：核心版本检查（npm + GitHub 双源，stable-first，拒绝跨渠道预发布）→ dry-run 防误删 → 备份（package.json、lockfile、`@deepseek-ai` 全树快照）→ 布局自适应安装（原地或 `-g`）→ 安装后版本校验；插件临时目录安装 + 依赖协调 + 降级保护 + 原地同步；更新/回滚写回 profile `package.json` 与 lockfile；watchdog 重启（PID + 端口 + HTTP 200 + 新 instance id）；写路由要求 `{confirm:true}` + loopback；桌面端识别 Electron 并委托原生更新，拒绝 npm 改 `app.asar`。
- 适配度：非常高，覆盖 Web + Desktop、核心 + 插件。
- 风险：
  - 22 stars、1,235 周下载，用户基数小；单人维护。
  - 没有契约级预检（消息契约/移除 API/配置 schema），主要靠版本范围和安装后检查。
  - 桌面端不能回滚（`409 E_DESKTOP_OWNED`），只能重装旧版。
  - 需要自挂载（junction + profile 声明）才能在某些 dsh 版本上加载，安装门槛高。
- 结论：**借鉴其备份/回滚、watchdog、lockfile 持久化、桌面委托；不作为默认依赖。** 可作为 Web 端的快速 MVP 备选。

**其余 dsh 插件**

- `DSH-Plugins-Marketplace`：市场体验好，但更新只是附属；没有核心更新和回滚。
- `dsh-plugin-workshop`：安装/更新/卸载轻量，缺少兼容门控与回滚。
- `DshCockpit`：桌面驾驶舱，runtime 自动更新/回滚是附属能力，场景窄。
- `dsh-plugin-updates`：只更新插件，不更新核心。

### 2.5 调研结论

1. **端到端没有成熟方案。** 通用更新器不懂 Cordis 插件；dsh 专用插件懂插件，但都太年轻、太依赖单人维护。
2. **最接近的两个方案证明了三件事：** 契约预检必要；全树回滚点必要；桌面更新必须委托 Electron，不能用 npm 改 `app.asar`。
3. **正确做法是「成熟内核 + 产品层编排」：** electron-updater 负责桌面二进制，npm/pnpm 负责 CLI 与插件，产品层负责兼容解析、事务、回滚、提示。这样既不重复造下载器，也不把关键路径交给社区插件。

---

## 3. 选型：组合式一等公民更新器

### 3.1 架构

```
┌─────────────────────────────────────────────────────────────┐
│  UI：设置 → 关于 → 版本更新 / 侧栏状态 / 桌面菜单             │
│  一个按钮，状态机驱动；所有文案来自 message key               │
└───────────────────────────┬─────────────────────────────────┘
                            │ IPC / HTTP（loopback + confirm）
┌───────────────────────────▼─────────────────────────────────┐
│  Update Orchestrator（主进程 / Host 服务）                    │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐  │
│  │ Release      │  │ Plugin       │  │ Snapshot /       │  │
│  │ Resolver     │  │ Compatibility│  │ Journal          │  │
│  │ (semver)     │  │ Gate         │  │ (2-phase commit) │  │
│  └──────┬───────┘  └──────┬───────┘  └────────┬─────────┘  │
│         │                 │                   │            │
│  ┌──────▼─────────────────▼───────────────────▼─────────┐  │
│  │ Backend 适配层                                        │  │
│  │  DesktopBackend │ NpmGlobalBackend │ ProfileBackend   │  │
│  └──────┬─────────────────┬───────────────────┬─────────┘  │
└─────────┼─────────────────┼───────────────────┼────────────┘
          │                 │                   │
   electron-updater    npm / pnpm          profile dir swap
   （签名/差量）        （sha512/lock）      （rename/robocopy）
          │                 │                   │
          └─────────────────┴───────────────────┘
                            │
                  Health Probe + Watchdog
                  （独立进程，主进程死了也能回滚）
```

### 3.2 为什么是 electron-updater + npm/pnpm

| 理由 | 说明 |
|---|---|
| 已经被验证 | dsh Desktop 生产使用 `electron-updater`，有渠道、签名、差量、任务排空、Host 恢复；不需要重新证明 |
| 分发渠道原生 | `@deepseek-ai/dsh` 周下载 82.6 万，通过 npm 分发；插件也是 npm/git/pnpm，更新器不应引入第二套包管理器 |
| 兼容规则现成 | dsh 启动器已经在安装和启动时检查 `engines.dsh`，没有时检查 `@deepseek-ai/dsh*` peer；更新器只需复用同一套规则 |
| 可复现 | `package.json` + `pnpm-lock.yaml` + `--frozen-lockfile` 能精确还原插件图；这是回滚的基础 |
| 供应链可控 | npm `dist.integrity`（sha512）+ 可选 provenance；桌面端 Authenticode/公证；不需要自建二进制仓库 |
| 不重复造轮子 | 下载、差量、签名校验、安装器交接交给成熟组件；产品层只做编排和插件门控 |

### 3.3 为什么不直接采用社区插件

| 维度 | gating-hub | update-checker | 第一方组合方案 |
|---|---|---|---|
| Stars / 周下载 | 124 / 6,737 | 22 / 1,235 | 随产品分发 |
| 维护者 | 单人 | 单人 | 产品团队 |
| 发布节奏 | 极快（日更多版） | 周更 | 随产品版本 |
| 契约预检 | 强 | 弱 | 强（可扩展规则库） |
| 桌面更新 | 接管/冲突风险 | 委托 Electron | 委托 Electron |
| 关键路径风险 | 高 | 高 | 可控 |
| 可审计/签名 | 社区签名 | 社区签名 | 第一方签名 |

**结论：** 社区插件适合做「高级模式」或「参考实现」，不适合做默认更新内核。默认路径必须由第一方代码、第一方签名和第一方回滚策略控制。

### 3.4 适用理由总结

- **对用户：** 一个按钮，不需要理解 pnpm、profile、`engines.dsh`；升级前能看到「会发生什么」，失败能看到「已经回滚」。
- **对插件作者：** 兼容规则不变，仍然是 `engines.dsh` / peer；更新器不会静默卸载插件，只会禁用并给出恢复路径。
- **对产品团队：** 复用成熟组件，控制关键路径；可以逐步增加契约规则、灰度、企业镜像，而不锁定某个社区插件。

---

## 4. 按钮设计

### 4.1 位置与入口

| 入口 | 形态 | 说明 |
|---|---|---|
| 设置 → 关于 → 版本更新 | 主按钮 + 版本信息 + 插件兼容列表 | 完整信息，主要操作 |
| 侧栏/账户行 | 紧凑状态条：`有更新` / `下载 42%` / `重启完成` | 不打断工作，点击打开主面板 |
| 桌面菜单「检查更新…」 | 现有入口 | 复用同一状态机，不新开一套逻辑 |
| 命令面板 | `检查更新` / `更新 Harness` | 键盘用户 |
| 强制更新页 | 不可关闭的阻塞页 | 由服务端策略触发，按钮为「立即更新（必需）」 |

### 4.2 按钮状态机

| 状态 | 按钮文案 | 可点 | 辅助说明 | 下一步 |
|---|---|---|---|---|
| `idle` | 检查更新 | 是 | 上次检查：2 分钟前 | 手动检查 |
| `checking` | 正在检查… | 否 | 旋转指示 | 自动进入结果 |
| `up-to-date` | 已是最新 | 否（3 秒后恢复） | 当前 0.2.2-rc.1 | 可查看更新说明 |
| `available` | 更新到 0.2.3 | 是 | 含 12 个插件适配，约 38 MB | 打开确认弹窗 |
| `available-incompatible` | 更新（将禁用 2 个插件） | 是 | 点击查看清单 | 确认后继续 |
| `mandatory` | 立即更新（必需） | 是 | 服务端要求，不可跳过 | 直接进入下载 |
| `preparing` | 正在准备… | 否 | 校验兼容性/磁盘/权限 | 自动进入下载 |
| `downloading` | 下载中 42% | 可取消 | 进度条 + 速度 | 取消则清理暂存 |
| `verifying` | 正在验证… | 否 | 校验签名/完整性 | 自动进入排空 |
| `staged` | 重启并完成更新 | 是 | 运行中任务：3 | 打开重启确认 |
| `draining` | 等待任务结束… | 可强制 | 列出任务；超时说明 | 自动或强制切换 |
| `activating` | 正在更新，请勿关闭 | 否 | 全屏/模态遮罩 | 自动进入自检 |
| `succeeded` | 已更新到 0.2.3 | 否 | 12 个插件已适配 | 查看说明/回滚 |
| `rolled-back` | 已回滚，重试 | 是 | 显示失败原因 | 重试/查看日志 |
| `failed` | 重试 | 是 | 错误码 + 下一步 | 重试/诊断 |
| `blocked` | 暂不可更新 | 否 | tooltip 说明原因 | 修复后重试 |
| `safe-mode` | 以安全模式启动 | 是 | 自动回滚失败 | 打开恢复向导 |

> 原型 `prototype.html` 已实现上表全部 17 个状态；`succeeded` 另含「部分成功（插件被禁用）」分支，可在右下角工具条切换。

### 4.3 触发条件

**自动检查**

- 应用启动 30 秒后一次；之后每 6 小时一次。桌面端可沿用现有 10 分钟轮询作为底层探测，但用户可见的结果与提示按 6 小时节流，不另起一套调度。
- 网络从离线恢复、窗口回到前台、系统从睡眠恢复时，若已过下次检查时间则检查。
- 手动检查绕过节流，但合并进行中的请求。
- 检查失败指数退避：10 分钟 → 20 分钟 → 40 分钟，上限 1 小时；成功后重置。

**执行更新的前置条件**

| 条件 | 不满足时的行为 |
|---|---|
| 存在比当前更高的兼容版本 | 按钮显示「已是最新」或「当前渠道暂无适用更新」 |
| 安装形态受支持（Desktop / 全局 npm） | `npx` 显示「临时运行」+ 复制命令；源码显示 dev 模式说明 |
| 渠道有效且不跨渠道 | 稳定版只升稳定版；预发布只在已处于该预发布渠道时提供 |
| 没有其他实例持有 profile 写锁 | `E_BUSY`，按钮可点但只打开现有进度 |
| 可用磁盘 ≥ 2.5 × 包体 + 快照 | `E_DISK`，禁用并显示所需空间 |
| 兼容计划无硬阻断 | `E_NO_COMPATIBLE`，列出阻断插件；提供「保留当前版本」 |
| 强制更新策略未要求更高版本 | 强制状态下按钮不可取消，插件修改被锁定 |
| 更新未在进行 | 单飞；重复点击只聚焦现有进度 |

**运行中任务的处理**

- 默认：允许更新，但确认弹窗列出「将被中断的 agent / 排队消息 / 后台任务」，用户可选择「等待任务结束」或「立即更新」。
- 强制更新：必须更新；若任务无法排空，显示「更新将在任务结束后自动继续」，不强行杀任务。
- 无人值守模式：仅当没有运行中任务、没有不兼容插件、没有强制策略时，跳过确认直接更新；否则仍弹确认。

### 4.4 确认弹窗内容

```
更新到 0.2.3

当前版本   0.2.2-rc.1
目标版本   0.2.3（正式版）
下载大小   38.4 MB
更新内容   [查看完整说明]

插件变更
  ✓ 12 个插件将同步更新
  ✓ 3 个插件已兼容，保持不变
  ! 2 个插件暂不兼容，将被禁用（可恢复）
      dsh-plugin-foo 1.2.0 → 无兼容版本
      dsh-plugin-bar 0.4.1 → 无兼容版本

运行中任务
  2 个 agent 正在运行，1 个后台任务
  更新会中断这些任务。 [等待任务结束] [立即更新]

[取消]  [开始更新]
```

- 不兼容插件默认勾选「我了解将禁用 2 个插件」，否则主按钮禁用。
- 强制更新不显示「取消」，只显示「立即更新」和「稍后（保留阻断）」。
- 所有版本号原样展示，不加 `v` 前缀（与 dsh 桌面现有文案一致）。

### 4.5 一键与安全的平衡

- **默认：** 一次点击 → 确认弹窗 → 之后全自动。确认只发生在「可能中断任务/禁用插件/重启」之前，不在每个阶段反复打扰。
- **无人值守：** 设置项「无任务时自动更新」开启后，满足条件可跳过确认；失败仍然回滚并通知。
- **强制更新：** 一次点击直接进入下载；只在安装重启前提示「将中断任务」。
- **绝不静默：** 自动检查从不下载、不安装、不弹窗；只有用户点击或强制策略才进入安装流程。

### 4.6 可访问性与国际化

- 进度用 `role="progressbar"` + `aria-valuenow`；不确定阶段用 `aria-valuetext="正在验证"`。
- 状态变化用 `aria-live="polite"`；错误用 `role="alert"`。
- 按钮 `aria-busy` / `aria-disabled`，禁用原因通过 `aria-describedby` 关联。
- 弹窗焦点陷阱；关闭后焦点回到触发按钮；Esc 只在安装前可取消。
- 尊重 `prefers-reduced-motion`；不做庆祝动画。
- 8 种内置语言；文案用 message key，不拼字符串；插件数量用复数规则。

---

## 5. 更新流程

### 5.1 总览

```
idle
  │ 手动/自动检查
  ▼
checking ──► up-to-date
  │
  ▼
available
  │ 用户点击
  ▼
preparing（解析更新集 + 契约预检 + 快照）
  │
  ├── 硬阻断 ──► blocked（保留当前版本，零改动）
  ▼
downloading ──► verifying ──► staged
  │
  ▼
draining（准入锁 + 等待任务）
  │
  ▼
activating（原子切换）
  │
  ▼
verifying-install（健康检查）
  │
  ├── 通过 ──► committed / succeeded
  └── 失败 ──► rolling-back ──► rolled-back
                              └── 回滚失败 ──► safe-mode
```

### 5.2 阶段 0：识别安装形态

```ts
type InstallMode =
  | { kind: 'desktop'; appVersion: string; channel: 'stable' | 'nightly' }
  | { kind: 'npm-global'; prefix: string; dshRoot: string }
  | { kind: 'npx'; cacheRoot: string }
  | { kind: 'source'; repoRoot: string }
  | { kind: 'sdk'; host: string }
```

判定优先级：Electron 运行时 → `app-update.yml` / `profiles/desktop` → `npm root -g` → `_npx` 缓存 → git 工作区。判定失败时不要猜，显示「无法识别安装方式」并给出 `dsh --version` / `npm root -g` 的诊断命令。

### 5.3 阶段 1：检查与解析更新集

**目标：** 选出一个「核心 + 插件」都自洽的更新集，而不是只选一个核心版本。

```ts
async function resolvePlan(input: {
  current: string
  channel: Channel
  plugins: InstalledPlugin[]
}): Promise<UpdatePlan> {
  const cores = await releaseSource.list(channel)          // semver desc, 过滤当前渠道
  for (const core of cores) {
    if (!semver.gt(core.version, input.current)) continue
    const pluginPlan = await gate.plan(core.version, input.plugins)
    if (pluginPlan.hardBlocked) continue
    return { core, plugins: pluginPlan, score: score(core, pluginPlan) }
  }
  return { blocked: 'E_NO_COMPATIBLE' }
}
```

**选择规则：**

1. 稳定渠道优先；预发布只在当前已处于同一预发布渠道时提供，禁止 `rc → alpha` 跨渠道晋升。
2. 核心版本从高到低尝试；第一个「无硬阻断」的版本即为目标。
3. 插件版本取「满足目标核心范围、未废弃、非预发布优先」的最高版本；没有非预发布时才取预发布。
4. 若多个核心版本都可行，优先「需要禁用插件更少」的方案；再优先「插件更新更少」的方案，降低变更面。
5. 任何降级都不在正常更新路径中；只有用户显式「回滚」才允许降级。

**输出示例：**

```json
{
  "core": { "from": "0.2.2-rc.1", "to": "0.2.3", "channel": "stable" },
  "plugins": [
    { "name": "dsh-plugin-a", "from": "1.2.0", "to": "1.4.1", "action": "update" },
    { "name": "dsh-plugin-b", "from": "0.9.0", "to": "0.9.0", "action": "keep" },
    { "name": "dsh-plugin-foo", "from": "1.2.0", "to": null, "action": "disable", "reason": "no-compatible-version" }
  ],
  "warnings": ["dsh-plugin-bar 未声明 engines.dsh，将在沙箱启动中验证"],
  "estimatedBytes": 40265318
}
```

### 5.4 阶段 2：预检与契约检查

预检不修改任何文件；失败时零改动。

| 检查 | 方法 | 失败处理 |
|---|---|---|
| 磁盘 | `statfs` / `GetDiskFreeSpaceEx`；需要 2.5× 包体 + 快照 | `E_DISK`，显示所需空间 |
| 权限 | 尝试在目标目录创建临时文件 | `E_PERMISSION`，显示路径 |
| profile 锁 | `update.lock` 的 PID/心跳 | `E_BUSY`，聚焦现有进度 |
| Node/OS/Arch | `process.version`、`process.platform`、`process.arch` | `E_UNSUPPORTED` |
| 包完整性 | npm `dist.integrity` / 桌面 feed `sha512` | `E_INTEGRITY`，丢弃下载 |
| 签名 | Windows Authenticode / 安装器签名 | `E_SIGNATURE`，不执行 |
| 插件版本范围 | `engines.dsh` 优先；否则 `@deepseek-ai/dsh*` peer；预发布参与匹配 | 硬阻断或禁用 |
| bundle patch | `dsh.bundle.patch` 存在、YAML 可解析、`name` 可解析 | 硬阻断或禁用 |
| client 注入 | `dsh.client.inject` 的包在目标核心中存在 | 硬阻断或禁用 |
| 配置 schema | `dsh --profile <name> --dump-config-schema` + JSON Schema 校验 | 警告/阻断，视严重度 |
| 组合预览 | 在 staging `DSH_HOME` 中 `dsh --profile <name> --dump-config` | 硬阻断 |
| 原生模块 | 检查 `node-pty` / `koffi` 等 ABI，staging 中 `pnpm rebuild` | 硬阻断，提示工具链 |
| 会话格式 | 读取 `SESSION_FORMAT_VERSION` / 发布记录 | 跨 major 时要求备份与确认 |

**契约规则库**（可扩展，参考 gating-hub 的做法）：

```json
[
  {
    "id": "client-slot-renamed",
    "since": "0.2.0",
    "detect": ["dsh.client.slots", "settings.plugins.tab"],
    "message": "客户端 slot 已改名，旧插件不会显示入口",
    "action": "disable-with-recovery"
  },
  {
    "id": "llm-error-class-moved",
    "since": "0.2.1",
    "detect": ["@deepseek-ai/dsh-llm/errors"],
    "message": "LLM 错误类路径变更，插件 import 会失败",
    "action": "block"
  }
]
```

规则库的价值：把「上次升级踩过的坑」变成可回归的检查，而不是每次靠用户反馈。

### 5.5 阶段 3：建立回滚点

| 层级 | 内容 | 何时创建 | 保留 |
|---|---|---|---|
| L0 配置 | `package.json`、`pnpm-lock.yaml`、`pnpm-workspace.yaml`、`cordis.patch.yml`、`compatibility.json` | 每次更新前 | 最近 3 次 |
| L1 profile | 整个 `profiles/<name>`（硬链接/复制的 `node_modules` 可排除，靠 lockfile 还原） | 每次更新前 | 最近 1 次 |
| L2 运行时 | CLI 全局树或版本化 runtime 目录 | 全局 npm 更新前 | 上一版 |
| L3 会话 | 仅在会话格式跨版本时做增量备份 | 格式升级前 | 直到下次成功启动 |
| L4 桌面 | 上一版安装包缓存 / 下载 URL | 桌面更新前 | 上一版 |

回滚点写入 `update-journal.json`，包含哈希、版本、时间、路径。写入用「临时文件 + fsync + rename」，避免半写。

### 5.6 阶段 4：下载、校验、暂存

**npm/CLI 后端**

- `npm pack @deepseek-ai/dsh@<version>` 或直接下载 registry tarball 到 `$DSH_HOME/updates/<planId>/`。
- 校验 `dist.integrity`（sha512）；可选校验 provenance attestation。
- 解包到 `$DSH_HOME/runtime/<version>/`（版本化目录），不要原地覆盖 `node_modules`。
- 在 staging 中执行 `npm install --omit=dev --ignore-scripts`，再按 `allowBuilds` 白名单执行必要的构建脚本。
- 对 profile：克隆 profile 到 `$DSH_HOME/profiles/.staging/<name>-<planId>`，写入精确版本，执行 `pnpm install --frozen-lockfile`（优先 `--offline`）。

**Desktop 后端**

- `autoUpdater.autoDownload = false`；用户确认后 `downloadUpdate()`。
- electron-updater 负责差量下载与 `sha512` 校验；dsh 现有 `DesktopUpdateCoordinator` 已经有 `downloading → verifying → ready` 状态。
- 不把安装包解包到 `app.asar`；安装交给 `quitAndInstall`。

**暂存目录布局**

```
$DSH_HOME/
  updates/
    <planId>/
      plan.json
      packages/
      logs/
  runtime/
    <version>/            # CLI 版本化运行时
  profiles/
    .staging/
      <name>-<planId>/    # profile 克隆
    .backup/
      <name>-<timestamp>/
```

### 5.7 阶段 5：任务排空

- 获取「更新准入锁」：新的 agent 回合、工具调用、后台任务不再被接纳。
- 统计运行中任务：agent 回合、排队消息、运行中/停止中的后台任务、等待审批的回合。
- 默认等待 120 秒；超时后让用户选择「继续等待」/「强制更新」。
- 强制更新只停止「可中断」任务；不可中断的写操作要等完成，避免数据损坏。
- 桌面端复用现有 `beforeRestart()`：锁定 API 准入、等待已接收请求结束、确认 Host 退出；失败则拒绝安装并恢复 Host。
- Web 端新增 `/api/update/drain`，返回任务清单和可中断性。

### 5.8 阶段 6：原子切换

**Profile（Web/CLI）**

1. staging 通过 `--dump-config` 和启动自检后，停止旧 Host。
2. `profiles/<name>` → `profiles/.backup/<name>-<timestamp>`。
3. `profiles/.staging/<name>-<planId>` → `profiles/<name>`。
4. Windows 上若 rename 被文件句柄阻止：先停止所有 dsh 进程，重试；仍失败则用 `robocopy /MIR` 镜像 + 备份，或逐文件同步（参考 update-checker 的 `swapDirectoryInPlace`）。
5. 写入 `update-journal.json` 的 `applying` 状态后再 rename；rename 成功后写 `verifying`。

**CLI 全局 npm**

- 优先方案：版本化 runtime + `current` junction/symlink；`PATH` 指向 `current`。这是 nvm/volta 的模式，回滚是改链接，最快。
- 兼容方案：备份全局 `node_modules/@deepseek-ai` 树 + `package.json`，执行 `npm install -g @deepseek-ai/dsh@<version>`，健康检查失败则还原备份。
- 不在 `npx` 缓存中原地更新。

**Desktop**

- `quitAndInstall(true, true)` 交给 electron-updater；安装器负责替换应用。
- 安装前已经完成任务排空与 Host 退出；安装失败由现有 Host 恢复路径处理。
- 安装成功后首次启动做健康检查；连续 2 次启动失败进入原生恢复对话框，提供「回滚到上一版」。

### 5.9 阶段 7：健康检查与提交

**健康检查必须独立于新版本自身。** 如果新版本连路由都加载不了，它自己的健康端点也不可用。

| 检查 | 超时 | 通过条件 |
|---|---|---|
| 进程存活 | 5 s | PID 存在，未退出 |
| 端口监听 | 30 s | TCP connect 成功 |
| HTTP 根路径 | 60 s | 200/3xx |
| 版本匹配 | 60 s | `/api/update/health` 返回的 `version === target` |
| 插件加载 | 60 s | `plugins.failed === 0`（被禁用的不算失败） |
| 启动日志 | 60 s | 不含 `ERR_MODULE_NOT_FOUND`、`failed to import`、`EADDRINUSE`、`plugin tree failed to load` |
| 稳定性 | 10 s | 连续 3 次探针成功，进程未重启 |

`/api/update/health` 建议返回：

```json
{
  "version": "0.2.3",
  "pid": 12345,
  "profile": "web",
  "startedAt": "2026-11-07T15:00:00Z",
  "plugins": { "loaded": 42, "failed": 0, "disabled": 2 },
  "bootErrors": []
}
```

该端点只绑定 loopback，并要求 watchdog 持有的一次性 token；不要暴露给局域网。

**提交：** 健康检查通过后，`journal.state = committed`，`lastGood = target`，清理 staging，保留回滚点 24 小时或 3 次成功启动。

### 5.10 阶段 8：清理与遥测

- 删除超过保留策略的 staging / 旧版本；不删除 `lastGood` 和用户标记的回滚点。
- 写审计日志：时间、从/到版本、渠道、安装形态、插件变更、结果、耗时、错误码。
- 发遥测：只发聚合字段，不发插件名/配置内容（插件名可哈希）。
- 成功后 24 小时内保留「回滚」入口；超过后只保留「重新安装上一版」的说明。

---

## 6. 插件兼容处理

### 6.1 四层契约

| 层 | 契约 | 检查方式 | 失败后果 |
|---|---|---|---|
| 版本 | `engines.dsh`，否则 `@deepseek-ai/dsh*` peer 范围 | `semver.satisfies`，预发布参与匹配 | 启动器拒绝加载；更新器硬阻断/禁用 |
| 模块 | `dsh.bundle.patch` 可解析；入口可 import；`inject` 服务存在；client `inject` 包存在 | `--dump-config` + staging 启动 | 插件 FAILED；禁用或回滚 |
| 配置 | Config schema 兼容；patch 行 id 仍存在；用户覆盖仍有效 | `--dump-config-schema` + JSON Schema | 启动失败或配置失效；阻断/迁移 |
| 数据 | Session 格式、插件自有存储 schema | `SESSION_FORMAT_VERSION` + 插件迁移声明 | 旧核心读不回；禁止跨格式回滚 |

### 6.2 兼容性判定算法

**优先级（与 dsh 启动器一致）：**

1. 清单声明了 `engines.dsh`：**只由该范围决定**，忽略 `peerDependencies`。
2. 否则检查 `peerDependencies` 中每个 `@deepseek-ai/dsh` / `@deepseek-ai/dsh-*` 的范围；`workspace:^` / `workspace:~` / `workspace:*` 视为指向同一运行时。
3. 两者都没有：不施加版本约束（unknown），但必须通过 staging 启动自检。
4. 空范围、非法范围、`engines.dsh` 中的 `workspace:` 值：视为不兼容。
5. 预发布版本参与范围匹配；`semver.satisfies(target, range, { includePrerelease: true })`。
6. `engines` 不是对象、`engines.dsh` 不是字符串：清单格式错误，直接拒绝。

**插件版本选择：**

```ts
function pickPluginVersion(versions: Version[], targetCore: string) {
  return versions
    .filter(v => !v.deprecated && !v.yanked)
    .filter(v => compatible(v, targetCore))
    .sort((a, b) => {
      if (a.prerelease !== b.prerelease) return a.prerelease ? 1 : -1
      return semver.rcompare(a.version, b.version)
    })[0]
}
```

**硬阻断 vs 软阻断：**

- **硬阻断：** `@deepseek-ai/*` 包、profile 的 core 行、native 模块 ABI 不匹配、必需的 bundle patch 无法解析、会话格式跨代且用户拒绝备份。
- **软阻断：** 可选第三方插件没有兼容版本；可以禁用后继续，但必须让用户确认。
- **警告：** 插件没有声明任何范围；允许，但 staging 启动必须通过，并在结果里标记「未声明兼容范围」。

### 6.3 五种处置动作

| 动作 | 适用 | 行为 | 用户可见 |
|---|---|---|---|
| `update` | 有兼容的新版本 | 在同一个事务中安装精确版本，写回 `package.json` + lockfile | 「将更新 12 个插件」 |
| `keep` | 当前版本已兼容 | 不动 | 「3 个插件保持不变」 |
| `disable` | 可选插件无兼容版本 | 在 profile patch 写 `disabled: true`；保留文件；记录恢复命令 | 「2 个插件已禁用（可恢复）」 |
| `manual` | `link:` / `file:` / git dirty | 不自动改；提示用户手动更新；不兼容则阻断或禁用 | 「本地插件需手动处理」 |
| `block` | 核心插件不兼容 | 中止整个更新，零改动 | 「核心插件不兼容，已阻止更新」 |

**禁用不是卸载：**

- 只写 `disabled: true`，不删 `node_modules`，不删配置。
- 生成 `restore.json`：`{ plugin, version, patchPath, rowId, disabledAt, reason }`。
- UI 提供「恢复」按钮；插件发布兼容版本后，点「检查更新 → 更新并适配」自动解除。
- `@deepseek-ai/*` 与 protected/core 行永不禁用。

### 6.4 证据式自动禁用

只有满足以下**硬证据**之一才自动禁用：

1. 包在所有解析基准上都不可解析（`ERR_MODULE_NOT_FOUND`）。
2. `file://` / `link:` 目标确实不存在。
3. 启动日志点名该行（row id / 包名）导致 `plugin tree failed to load`。

规则：

- 先写安全快照，再写 `disabled: true`；没有证据不写一个字节。
- 每次自动禁用写审计记录：时间、行 id、证据、恢复命令。
- 不禁用 `@deepseek-ai/*`，不禁用 protected/core 行。
- 自动禁用后仍无法启动 → 进入安全模式，而不是继续猜。

**兼容豁免 `compatibility.json`：**

- dsh 支持在 profile 的 `compatibility.json` 中写「精确 `package@version` → 精确运行时版本」的豁免。
- 更新器可以提供「临时兼容豁免」高级选项，但必须：
  - 只对精确版本生效；
  - 明确提示「不继承到下一次升级」；
  - 记录风险确认；
  - 默认关闭，不推荐普通用户使用。

### 6.5 配置迁移

- patch 按 id 替换整段 `config`，不做深合并；所以升级后必须重述所有需要的键。
- 预检：`dsh --profile <name> --dump-config-schema` 生成 JSON Schema，校验用户 patch。
- 迁移钩子：插件可在 `package.json` 声明 `dsh.migrations`，例如：

```json
{
  "dsh": {
    "migrations": {
      "1.2.0": "./migrations/1.2.0.js",
      "2.0.0": "./migrations/2.0.0.js"
    }
  }
}
```

- 迁移按版本顺序执行，每步前写配置快照；失败则停止并回滚配置。
- 没有迁移声明的插件：保留配置，schema 校验失败则禁用并提示，不静默删除用户配置。
- 用户 patch 优先级最高：更新器只改 bundle 层，不改用户的 `cordis.patch.yml`；需要改用户配置时，必须显式确认。

### 6.6 数据格式与会话

- 当前 Session 格式 V4；发布记录 `latestReleasedVersion: 4`，证据标签 `dsh-v0.2.0-rc.2`。
- 旧读取器可能拒绝新载荷版本；**跨格式回滚不能只还原代码**。
- 更新器必须：
  - 读取目标版本的 `SESSION_FORMAT_VERSION`；
  - 如果高于当前，要求「备份会话」确认，或拒绝一键更新，改为引导手动；
  - 回滚时如果代码已回旧版但会话已写新格式，进入「只读恢复」模式，提示用户从备份恢复；
  - 不自动删除/截断会话日志。
- 插件自有存储：插件应在 `dsh.migrations` 中声明 schema 迁移；没有声明的，更新器只做备份，不做自动迁移。

### 6.7 兼容性 UI

- 插件列表三态：`已适配`（绿）、`将更新`（蓝）、`不兼容`（琥珀/红）。
- 不兼容插件展开显示：当前版本、原因（无兼容版本/范围不匹配/模块不可解析）、可选动作（禁用/手动更新/查看仓库）。
- 「待适配」状态：插件被禁用后，卡片显示「检查更新 → 更新并适配」，而不是只显示「已禁用」。
- 更新结果里区分「已更新」「已禁用」「未声明范围，已通过启动验证」。

---

## 7. 失败回滚

### 7.1 回滚点分级

| 级别 | 回滚内容 | 成本 | 可靠性 |
|---|---|---|---|
| L0 配置 | package.json / lockfile / patch / compatibility.json | 毫秒 | 高 |
| L1 profile | 整个 profile 目录 | 秒 | 高 |
| L2 运行时 | CLI 版本目录 / 全局树 | 秒 | 高（版本化）/ 中（原地） |
| L3 会话 | 会话增量备份 | 分钟 | 中（取决于备份时机） |
| L4 桌面 | 上一版安装包 | 分钟 | 中（需保留安装包/下载源） |

**原则：** 能在 L0/L1 解决的，不要动 L3/L4；能用版本化目录的，不要原地覆盖。

### 7.2 Journal 与双阶段提交

`$DSH_HOME/updates/update-journal.json`：

```json
{
  "schema": 1,
  "id": "20261107T150000Z-7f3a",
  "from": "0.2.2-rc.1",
  "to": "0.2.3",
  "channel": "stable",
  "backend": "profile",
  "state": "prepared",
  "plan": { "pluginsUpdated": 12, "pluginsDisabled": 2 },
  "snapshot": "$DSH_HOME/profiles/.backup/web-20261107T150000Z",
  "staging": "$DSH_HOME/profiles/.staging/web-20261107T150000Z",
  "pid": 12345,
  "startedAt": "2026-11-07T15:00:00Z",
  "updatedAt": "2026-11-07T15:00:00Z",
  "health": null
}
```

状态机：

```
prepared → applying → verifying → committed
                │           │
                └───────────┴──► rolling-back → rolled-back
                                              └──► failed（需人工）
```

- 每个状态变更都原子写盘。
- 启动时 `UpdateRecovery` 读取 journal：
  - `applying` / `verifying` 且 `to !== current` → 自动回滚。
  - `rolling-back` → 继续回滚。
  - `committed` → 清理 staging，保留回滚点。
- 回滚完成后写 `rolled-back`，保留日志和原因，不立即删除。

### 7.3 独立 watchdog

```
dsh-update-helper --journal <path> --profile <name> --port <port> --timeout 90000
```

- 在切换前 `spawn({ detached: true, stdio: 'ignore' }).unref()`，helper 不依赖主进程事件循环。
- helper 负责：等待旧 PID 退出 → 启动新版本 → 捕获 stdout/stderr → 轮询健康 → 成功写 `committed` / 失败执行回滚 → 启动旧版本 → 写 `rolled-back`。
- helper 自身崩溃：下次启动由 `UpdateRecovery` 兜底。
- Windows：detached 进程 + PID 文件；企业环境可选计划任务/systemd user service。
- 安全：helper 只接受 journal 中记录的路径和版本，不接受命令行任意 URL；健康 token 一次性。

### 7.4 回滚触发条件

| 阶段 | 触发 | 是否回滚 |
|---|---|---|
| 预检 | 磁盘/权限/锁/签名/硬阻断 | 否（零改动，直接失败） |
| 下载 | 网络失败、校验失败 | 否（丢弃 staging） |
| 排空 | 用户取消 | 否（零改动） |
| 切换 | rename/链接失败 | 是（还原 snapshot） |
| 启动 | 进程退出、端口不监听、超时 | 是 |
| 自检 | 版本不匹配、插件失败、启动日志错误 | 是 |
| 稳定期 | 10 秒内崩溃/重启 | 是 |
| 提交后 | 用户手动回滚 | 是（保留回滚点 24h） |

### 7.5 回滚流程

**Profile**

1. 停止新进程（SIGTERM，10 秒后 SIGKILL）。
2. 删除/移走失败的 `profiles/<name>`。
3. 从 `.backup/<name>-<timestamp>` 还原。
4. 还原 `package.json`、lockfile、patch、`compatibility.json`。
5. 启动旧版本，跑同一套健康检查。
6. 写 `rolled-back`，保留失败日志。

**全局 npm**

1. 停止进程。
2. 还原全局 `node_modules/@deepseek-ai` 树 + `package.json` / lockfile。
3. 启动旧版本，健康检查。
4. 如果版本化 runtime + `current` 链接，只改链接，秒级回滚。

**Desktop**

1. 安装失败：现有 `DesktopUpdateCoordinator` 恢复当前 Host，重新加载 UI。
2. 安装成功但启动失败：原生恢复对话框提供「回滚到上一版」；从缓存/官方 feed 下载上一版，校验签名后安装。
3. 不在 `app.asar` 内做任何原地修改。

### 7.6 回滚失败与安全模式

- **CLI/Web：** `dsh rescue --from-default-profile web` 从随附模板重建 rescue profile 并启动；或调用 `sanitizeProfile` 备份 patch 并恢复 bundle 列表。先备份，再执行。
- **Desktop：** 原生致命错误恢复对话框：退出 / 重启 / 禁用第三方插件并备份 patch 后重启 / 获取诊断报告。
- **安全模式规则：** 只加载 `@deepseek-ai/*` 与 core 行；第三方插件全部禁用；不自动重新启用；给出一键恢复上一版和导出诊断。
- **回滚失败是 P0：** 必须显示「自动回滚失败」而不是「更新失败」；提供可复制的修复命令、日志路径、profile 路径。

### 7.7 不可回滚边界

| 边界 | 说明 | 处理 |
|---|---|---|
| 会话格式跨代 | 新格式可能不被旧核心读取 | 升级前备份；回滚进入只读恢复；不自动截断 |
| 插件数据 schema 升级 | 插件自己改了存储格式 | 要求插件声明迁移/回滚；否则只备份，不自动迁移 |
| 外部服务/模型 API | 新版本依赖新端点 | 健康检查覆盖；失败回滚 |
| 桌面安装器 | 已替换应用 | 保留上一版安装包/下载 URL；不能热回滚 |
| 原生模块 ABI | 新 Node/Electron ABI | staging 重建；失败在预检阻断 |

---

## 8. 结果与异常提示

### 8.1 提示层级

| 层级 | 使用场景 | 形态 | 持续时间 |
|---|---|---|---|
| Toast | 成功、已是最新、已取消 | 右下角/顶部轻提示 | 3–5 秒 |
| Inline banner | 有更新、可恢复错误 | 卡片内横幅 | 直到状态变化 |
| Modal | 安装确认、重启确认、强制更新 | 居中对话框 | 阻塞直到选择 |
| Native dialog | 回滚失败、无法启动 | 系统对话框 | 阻塞 |
| Log | 所有阶段 | `$DSH_HOME/logs/update.log` | 保留 30 天 |
| Telemetry | 聚合结果 | 事件 | 采样 |

### 8.2 成功与部分成功

- `已更新到 0.2.3。12 个插件已同步适配。`
- `已更新到 0.2.3。3 个插件暂不兼容，已禁用；插件更新后可一键恢复。 [查看列表]`
- `已是最新（0.2.2-rc.1）。`
- `已回滚到 0.2.2-rc.1。未做任何更改。`
- `已回滚到 0.2.2-rc.1。原因：新版本启动自检失败。 [查看日志]`

### 8.3 错误码表

| 错误码 | 阶段 | 用户文案 | 主操作 | 自动回滚 |
|---|---|---|---|---|
| `UPD-101` | 检查 | 无法连接更新源，请检查网络或代理 | 重试 / 更换镜像 | 否 |
| `UPD-102` | 检查 | 更新源返回了无效信息 | 重试 / 查看日志 | 否 |
| `UPD-103` | 解析 | 当前渠道没有兼容版本 | 切换渠道 / 查看原因 | 否 |
| `UPD-201` | 门控 | 有 2 个插件与新版本不兼容 | 查看清单 / 仍要更新 | 否 |
| `UPD-202` | 门控 | 核心插件不兼容，已阻止更新 | 查看插件 / 反馈 | 否 |
| `UPD-301` | 预检 | 磁盘空间不足，还需要 1.2 GB | 清理空间 / 更改位置 | 否 |
| `UPD-302` | 预检 | 没有写入权限 | 打开目录 / 修复权限 | 否 |
| `UPD-303` | 预检 | 另一个实例正在更新 | 查看进度 | 否 |
| `UPD-401` | 下载 | 下载失败，已保留当前版本 | 重试 | 否 |
| `UPD-402` | 校验 | 完整性校验失败，下载已丢弃 | 重试 | 否 |
| `UPD-501` | 安装 | 安装失败 | 重试 / 查看日志 | 是（若已切换） |
| `UPD-502` | 自检 | 新版本自检未通过 | 查看日志 / 重试 | 是 |
| `UPD-503` | 自检 | 插件加载失败超过阈值 | 查看插件 | 是 |
| `UPD-601` | 回滚 | 自动回滚失败 | 安全模式 / 复制修复命令 | 已尝试 |
| `UPD-701` | 策略 | 需要更新到更高版本才能继续 | 立即更新 / 官网下载 | 否 |
| `UPD-702` | 形态 | 当前为临时运行，无法原地更新 | 复制命令 / 安装正式版 | 否 |

预检内部原因码与用户可见错误码的映射：`E_DISK → UPD-301`、`E_PERMISSION → UPD-302`、`E_BUSY → UPD-303`、`E_NO_COMPATIBLE → UPD-201/202`、`E_INTEGRITY` / `E_SIGNATURE → UPD-402`、`E_UNSUPPORTED → UPD-702`。内部码只写日志，不直接展示。

**文案规范：**

1. 先说「发生了什么」，再说「是否已回滚」，最后说「下一步」。
2. 不显示原始堆栈；「技术详情」折叠展示错误码、退出码、路径、最后 20 行日志。
3. 不把「检查失败」写成「更新失败」；不把「已回滚」写成「更新失败」。
4. 版本号原样展示；不拼接句子，使用 ICU message。
5. 所有错误都带一个可执行的下一步，不能只有「确定」。

### 8.4 异常提示示例

**下载失败（未改动）**

```
更新未开始
无法下载 0.2.3：连接 npm registry 超时。
当前版本 0.2.2-rc.1 未做任何更改。
[重试] [更换镜像] [查看日志]
```

**自检失败（已回滚）**

```
已回滚到 0.2.2-rc.1
新版本 0.2.3 启动时插件 dsh-plugin-foo 加载失败。
已自动恢复更新前的配置和插件，未丢失数据。
[查看日志] [重试] [暂时跳过此版本]
```

**回滚失败（P0）**

```
自动回滚失败
Harness 可能无法启动。请先备份 $DSH_HOME，然后尝试：
  dsh rescue --from-default-profile web
[以安全模式启动] [打开日志] [复制修复命令]
```

### 8.5 遥测

| 事件 | 字段 |
|---|---|
| `update_check` | `result`, `channel`, `install_mode`, `duration_ms` |
| `update_available` | `from`, `to`, `plugin_total`, `plugin_incompatible` |
| `update_start` | `plan_id`, `backend`, `plugin_updates`, `plugin_disables` |
| `update_stage` | `stage`, `duration_ms`, `result` |
| `update_success` | `from`, `to`, `duration_ms`, `rollback_available` |
| `update_failure` | `stage`, `error_code`, `rolled_back`, `plugin_failed` |
| `update_rollback` | `reason`, `stage`, `duration_ms`, `success` |

- 不采集 profile 内容、配置值、会话内容。
- 插件名默认哈希；企业版可关闭遥测。
- 成功采样 10%，失败 100%。

---

## 9. 安全、并发与权限

| 项 | 要求 |
|---|---|
| 单飞 | 每个 `DSH_HOME` 一个 `update.lock`（PID + 心跳）；重复请求聚焦现有进度 |
| 陈旧锁 | 心跳超过 10 分钟视为陈旧；接管前写审计日志 |
| 写路由 | 仅 loopback；要求 `{ confirm: true }`；CSRF token；渲染进程不能选择 URL/版本 |
| 版本来源 | 只接受 npm registry / 官方桌面 feed / 配置的企业镜像；HTTPS；拒绝 URL 中的凭据 |
| 完整性 | npm `dist.integrity` sha512；桌面 feed sha512；安装器签名 |
| 签名 | Windows Authenticode；安装器与主程序均须验证 |
| 防降级 | 正常路径拒绝降级；回滚只允许 journal 中记录的目标版本 |
| 安装脚本 | 不自动授权 `prepare` / postinstall；遵守 pnpm `allowBuilds`；显示风险 |
| 权限 | 以当前用户运行；需要管理员时交给安装器，不自行提权 |
| 审计 | `update.log` + `audit.jsonl`；保留 30 天；包含操作者、版本、结果、错误码 |
| 供应链 | 可选 npm provenance；企业镜像需签名/校验策略；不跳过 TLS |

**为什么不用渲染进程直接调 npm：** Electron 渲染进程不应该有文件系统/子进程权限；所有更新操作在主进程/Host 服务中执行，渲染进程只发意图。dsh 现有安全模型也是这么做的。

---

## 10. 实施计划

### 10.1 分期

| 阶段 | 范围 | 产出 | 退出标准 |
|---|---|---|---|
| Phase 0（MVP） | Web/CLI 全局 npm + profile；检查、解析、预检、下载、切换、回滚、按钮状态 | 可用的一键更新；错误码；日志 | 10 个真实插件升级通过；失败注入全部回滚 |
| Phase 1 | Desktop 统一入口；委托 electron-updater；安装后恢复 | 一个按钮覆盖桌面/Web；桌面菜单复用 | Windows NSIS 安装/回滚验收 |
| Phase 2 | 契约规则库、自动禁用、配置迁移、兼容豁免 | 插件兼容门控 | Top 100 插件兼容矩阵；启动失败自动恢复 |
| Phase 3 | 灰度、企业镜像、离线包、遥测看板 | 规模化运营 | 灰度可回退；企业离线可用 |

### 10.2 核心接口

```ts
export interface UpdateBackend {
  readonly kind: 'desktop' | 'npm-global' | 'profile' | 'npx' | 'source'
  check(channel: Channel): Promise<ReleaseInfo[]>
  prepare(plan: UpdatePlan): Promise<StagedUpdate>
  activate(staged: StagedUpdate): Promise<ActivationHandle>
  health(handle: ActivationHandle): Promise<HealthReport>
  rollback(journal: UpdateJournal): Promise<RollbackReport>
}

export interface PluginGate {
  plan(targetCore: string, plugins: InstalledPlugin[]): Promise<PluginPlan>
  verify(plan: PluginPlan): Promise<GateResult>
  disable(plugin: InstalledPlugin, reason: string): Promise<RestoreHandle>
  restore(handle: RestoreHandle): Promise<void>
}

export interface UpdateOrchestrator {
  check(opts: { manual: boolean }): Promise<UpdateState>
  start(planId: string): Promise<UpdateState>
  cancel(): Promise<void>
  rollback(): Promise<UpdateState>
  subscribe(listener: (state: UpdateState) => void): () => void
}
```

### 10.3 测试矩阵

| 维度 | 用例 |
|---|---|
| 安装形态 | Desktop / 全局 npm / `npx` / 源码 / SDK |
| 平台 | Windows x64 |
| 渠道 | stable、nightly、预发布不跨渠道 |
| 插件 | 兼容、需更新、无兼容、`link:`、native、未声明范围、core 行 |
| 失败注入 | 网络断开、sha512 错误、磁盘满、权限拒绝、端口占用、进程崩溃、启动超时、插件 import 失败 |
| 回滚 | 切换前失败、切换后失败、自检失败、回滚中崩溃、回滚失败进安全模式 |
| 并发 | 两个窗口同时点、CLI 与 Desktop 同时操作、任务运行中更新 |
| 数据 | 会话格式 V4 升级、插件存储迁移、回滚后只读恢复 |
| 兼容性 | Top 100 dsh 插件 + 20 个 native/客户端插件 |

### 10.4 验收标准

- 一键更新成功率 ≥ 99%（排除用户取消/网络中断）。
- 失败自动回滚成功率 ≥ 99.5%；回滚失败必须进入安全模式并可恢复。
- 更新后插件加载失败率 < 0.5%；所有禁用都有证据和恢复路径。
- 用户从点击到看到结果 ≤ 3 次交互（默认确认 1 次；无人值守 0 次）。
- 所有失败都有稳定错误码、可执行下一步、可复制诊断。
- 不出现「更新成功但版本没变」「插件消失但没有提示」「回滚后配置丢失」。

---

## 11. 风险与取舍

| 风险 | 影响 | 缓解 |
|---|---|---|
| npm registry 不可达 | 无法检查/下载 | 镜像、缓存 packument、指数退避、离线包 |
| 原生模块 ABI 不匹配 | 启动失败 | staging `pnpm rebuild` + 预检阻断 |
| 桌面端无法真正回滚 | 新版本崩溃后恢复慢 | 保留上一版安装包 + 原生恢复对话框 + 官方 feed 下载旧版 |
| 会话格式单向升级 | 回滚后读不回会话 | 升级前备份；跨代需确认；只读恢复 |
| 第三方插件质量差 | 更新后大量 FAILED | 证据式禁用、安全模式、兼容矩阵、金丝雀 |
| 社区方案单维护者 | 关键路径不可控 | 不默认依赖；参考实现；可选插件 |
| 供应链攻击 | 恶意包 | 签名、sha512、provenance、allowBuilds、企业镜像 |
| 用户跳过版本 | 错过安全更新 | 强制更新策略、安全公告、不可跳过的 critical |
| 更新器自身缺陷 | 全体用户受影响 | 灰度、kill switch、两阶段提交、独立 watchdog |

**取舍：**

- 选择「更新核心时同步更新插件」而不是「先升核心再修插件」，因为混合版本状态的故障面更大；代价是更新耗时更长、需要更多插件版本查询。
- 选择「默认禁用不兼容插件」而不是「阻止所有更新」，因为后者会让用户长期停留在旧版本；代价是用户可能暂时失去功能，但可恢复。
- 选择「桌面端委托 electron-updater」而不是「统一自研安装器」，因为桌面签名/安装器复杂度高；代价是桌面回滚能力受限于 Electron 更新器。
- 选择「第一方组合」而不是「直接集成社区插件」，因为 82 万周下载量的产品不能把更新关键路径交给单人项目；代价是前期开发量更大。

---

## 12. 附录

### 12.1 关键参考

- dsh 仓库：https://github.com/deepseek-ai/deepseek-harness
- Desktop 更新协调器：`apps/desktop/src/update-coordinator.ts`
- Desktop 更新说明：`apps/desktop/README.zh.md#updates`
- 插件发布与 `engines.dsh`：`docs/user/develop/basic/publish.zh.md`
- 插件索引与版本兼容：`docs/user/guide/plugin-market.zh.md`
- Profile 兼容规则：`packages/boot/app-boot/README.zh.md#profiles`
- 会话格式：`docs/session-format-status.zh.md`
- 持久化兼容规则：`docs/persistence-changes/README.zh.md#compatibility-rules`
- electron-updater：https://github.com/electron-userland/electron-builder
- dsh-plugin-gating-hub：https://github.com/Noob-stupid/dsh-plugin-gating-hub
- dsh-update-checker：https://github.com/Airmetro/dsh-update-checker

### 12.2 术语

| 术语 | 含义 |
|---|---|
| bundle | 带 `dsh.bundle.patch` 的 npm 包，向 profile 贡献一个配置层 |
| profile | `$DSH_HOME/profiles/<name>`，由 bundle 列表 + 用户 patch 组成 |
| patch | `cordis.patch.yml` 的条目列表；按 id 替换整段 config |
| Fiber | Cordis 插件的作用域/生命周期状态机 |
| 硬阻断 | 不允许继续更新，必须保留当前版本 |
| 软阻断 | 允许继续，但需禁用不兼容插件并确认 |
| 原子更新集 | 核心与插件在同一事务中解析、安装、切换的版本集合 |
| 双阶段提交 | prepared → applying → verifying → committed；中途崩溃可回滚 |

### 12.3 版本记录

| 日期 | 变更 |
|---|---|
| 2026-11-07 | 初版：调研、选型、按钮状态机、更新流程、兼容门控、回滚、提示 |
| 2026-11-07 | 1.1：原型补齐 17 个状态与部分成功分支；修正自检失败分支图；统一错误码映射与自动检查间隔表述 |
| 2026-11-08 | 1.2：新增 Node 参考实现（Orchestrator / Journal / watchdog / 门控 / npm 与 electron 适配 / i18n / 遥测）、CLI 与完整测试 |
| 2026-11-09 | 2.0：`0.2.0` 产品化。真实 patch 禁用/staging 门控、watchdog helper、Windows 进程与原子切换、跨平台路径、默认关闭遥测、pnpm/allowBuilds、真实 registry 冒烟、live 原型与发布治理；测试 112 项 |
| 2026-11-09 | 2.1：`0.2.1`。Node 24.22.2 + 真实 dsh 0.2.2-rc.1 staging 验收通过；冷安装 652 包将默认超时从 3 分钟修正为 10 分钟并开放 `installTimeoutMs`；记录 Windows Desktop EV 签名与启动证据 |
| 2026-11-09 | 2.2：`0.2.2`。真实失败路径验证通过；staging 错误改为具体命令标签并保留 `UPD-*` 与 stderr 证据；新增回归用例，测试 113 项 |
| 2026-11-09 | 2.3：`0.2.3`。Windows-only；真实失败插件在 Host 存活时正确判失败并可禁用恢复；独立 watchdog 进程回滚通过；测试 114 项 |
