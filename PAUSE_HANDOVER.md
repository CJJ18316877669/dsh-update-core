# 暂停交接：Desktop 插件问题定位与补全

> **2026-11-11 09:35 手动测试状态**：当前为手动测试，已安装旧核心 `0.2.1-rc.5` 到自定义目录 `C:\Users\18316\Desktop\hao`；插件 `0.2.7` 已修复“找不到 Desktop”并实测设置页显示 `0.2.1-rc.5 → 0.2.2-rc.1`。旧版应用请从安装目录或开始菜单手动启动。
>
> **2026-11-11 09:10 续作完成**：核心回滚已通过插件 API 端到端实测，Desktop 已恢复 `0.2.2-rc.1`，测试包已清理。以第 0 节为准；第 1-6 节保留为暂停时的历史记录。

## 0. 续作结果（覆盖下文旧状态）

| 项 | 结果 |
|---|---|
| 最终 Desktop | exe `0.2.2.0`，注册表 `0.2.2-rc.1`，应用关闭 |
| 更新插件 | `dsh-update-core-plugin@0.2.6` |
| 项目版本 | `0.3.7` |
| 列表插件 | `dsh-context@0.83.1`，`dsh-skill-mcp-panel@2.3.12` |
| 当前计划 | 0 个更新 / 15 个保持 |
| 更新历史 | 12 条 |
| 测试 | 123/123 |
| 核心回滚端到端 | ✓ 运行 `2026-11-11T00-50-17-385Z` |
| 回滚结果 | `coreRolledBack: true`，`coreVersion: 0.2.1.0`，`profileRestored: true`，`appHealthy: true` |
| 回滚后恢复 | 已用 `new.exe /S --updated` 恢复 `0.2.2.0` / `0.2.2-rc.1` |
| GitHub 304 | ✓ 带缓存的 ETag 请求返回 `304` |
| `autoApply: true` | ✓ 隔离 profile 中自动触发更新（无人工点击） |
| 自动触发证据 | 运行 `2026-11-11T01-07-07-413Z`，自动识别 `dsh-context 0.81.0 → 0.83.1` |
| 测试安装包 | 557 MB 的 `old.exe` / `new.exe` 已删除 |
| `core-state.json` | 已删除，回滚按钮回到禁用 |
| 无效历史 | 已删除卡在 `starting` 的 00:46 运行 |

### 核心回滚失败过的真正原因

前几次 `/api/rollback` 都返回 `installer-exit-2`。根因不是安装包损坏，也不是版本降级被禁止：

1. helper 最初以 `DeepSeek Harness.exe` 映像运行；
2. 官方 NSIS 安装器启动时检查到“仍有 `DeepSeek Harness.exe` 在运行”（实际是 helper 自己），于是以 exit 2 退出；
3. 手动用 `node.exe` 运行同一个 helper 时能成功降级，验证了这个判断；
4. 最终修复：helper 改用 Desktop 自带的
   `resources/runtime/primary-runtime/dependencies/node/bin/node.exe` 运行；同时 `closeDesktop()` 改为按 PID 逐个 `taskkill`，不再依赖 PowerShell 的进程 Path 判断。

修复后，插件 UI → `/api/rollback` → 关闭 Desktop → 旧安装包降级到 `0.2.1.0` → 恢复 profile → 启动并心跳确认，全链路成功。

### autoApply 隔离验证

已使用独立 `DSH_HOME`、独立 `autotest` profile 和替身 Desktop 可执行文件验证：

- 配置 `autoApply: true`、`autoCheckHours: 1`；
- 等待后台 tick 后，无需点击任何按钮，自动创建运行目录并启动更新；
- 自动检测目标：`dsh-context 0.81.0 → 0.83.1`；
- 运行 ID：`2026-11-11T01-07-07-413Z`；
- 该合成 profile 不包含 pnpm runtime，helper 在安装阶段因 `pnpm.cjs` 缺失而按设计进入回滚；这证明自动触发链路已执行，但不等同于在真实 profile 上完成一次自动安装。主 Desktop profile 全程未触碰。

默认 `autoApply` 仍保持 `false`；真实启用前应确认用户接受自动关闭/重启。

---

> 暂停时间：2026-11-10 11:40 GMT+8  
> 状态：**任务暂停，但当前机器已恢复到安全可启动状态**  
> 当前提交：`2724192 feat: harden plugin refresh, auto-apply and GitHub caching`  
> 分支：`main`；`2724192` 与本文档提交会一并推送到 GitHub。恢复工作前先执行 `git status --short --branch` 确认远端状态。

## 1. 当前机器状态（已复核）

| 项 | 值 |
|---|---|
| Desktop exe ProductVersion | `0.2.2.0` |
| 注册表 DisplayVersion | `0.2.2-rc.1` |
| Desktop 进程 | 0，应用当前关闭 |
| v2rayN/Xray 进程 | 0，代理已停止 |
| 已安装更新插件 | `dsh-update-core-plugin@0.2.1` |
| `dsh-context` | `0.83.1` |
| 插件状态 | 最近一次检查为 0 个更新 / 15 个保持 |
| 测试 | `npm test` 123/123 通过 |
| `ignored.json` | 不存在（测试后已清理） |
| `core-state.json` | 不存在（测试后已清理，回滚按钮应禁用） |
| 更新历史 | 6 条运行记录保留在 `~/.dsh/updates/dsh-update-plugin/` |

**重要**：上一轮被中断时，旧版官方安装包已经实际执行完毕，把 exe 降级到了 `0.2.1.0`，且注册表 `DisplayVersion` 一度为空。已立即使用同一批验签通过的 `0.2.2-rc.1` 安装包恢复；现在 exe `0.2.2.0`、注册表 `0.2.2-rc.1`，没有残留安装器进程。不要把这个短暂降级状态误解为当前状态。

## 2. 图中 5 个问题的根因、修复与验证

### 2.1 核心回滚未在真实核心更新中执行

- **根因**：当前官方 nightly feed 最新版就是本机 `0.2.2-rc.1`，没有可用的新版本可以触发“升级后回滚”；这是验证条件缺失，不是代码报错。
- **已做**：
  - 使用 v2rayN 代理下载官方旧版 `0.2.1-rc.5` 安装包（277 MB）和当前 `0.2.2-rc.1` 安装包（280 MB）。
  - 两者 Authenticode 均为 `Valid`，签名主体为 `Hangzhou DeepSeek Artificial Intelligence Co., Ltd.`。
  - 直连下载 300 秒只得到 1.4 MB；经 `127.0.0.1:10808` 代理后约 4 分钟下载完成，证明代理链路有效。
  - 实际运行旧版安装包 `/S --updated`：exe 确实降到 `0.2.1.0`，说明官方安装包允许这种降级路径；随后用新版安装包恢复到 `0.2.2.0`。
- **结论**：核心回滚所用“运行旧安装包”机制具备可行性。
- **未完成**：还没有通过插件 `/api/rollback` 端到端执行一次含 `coreRolledBack: true` 的回滚；该步应在继续时用一个明确的测试回滚点完成，完成后再次恢复 `0.2.2-rc.1`。

### 2.2 忽略按钮未在真实可更新插件上点击

- **根因**：当时所有插件均为最新版，没有可点击的更新项；属于验证覆盖不足。
- **验证过程**：
  1. 将 `dsh-context` 从 `0.83.1` 真实降级到 `0.81.0`；
  2. 设置页显示 `1 个更新 / 14 个保持`，并出现 `dsh-context 0.83.1` 的“忽略此版本”按钮；
  3. 点击忽略后变为 `0 个更新 / 15 个保持`，`ignored.json` 写入 `{ "dsh-context": "0.83.1" }`；
  4. 点击取消忽略后恢复 `1 个更新 / 14 个保持`；
  5. 随后执行真实一键更新，把 `dsh-context` 升回 `0.83.1`，结果 `succeeded`，应用启动心跳确认健康；
  6. 再执行“回滚上一版本”，恢复到 `0.81.0`，结果 `rolled-back`、`profileRestored: true`、`appHealthy: true`；
  7. 最后手动恢复到 `0.83.1`，清理测试回滚点和忽略状态。
- **结论**：忽略/取消忽略、真实插件更新、静态健康检查、启动心跳、手动插件回滚均已实机通过。

### 2.3 定时检查只刷新状态，不会静默安装

- **根因**：这是原先刻意采用的安全默认值，避免后台自动关闭应用。
- **修复**：新增 `autoApply` 配置，默认 `false`。`autoCheckHours > 0` 时定时执行 `status(true)`；若 `autoApply: true` 且发现更新，则调用与按钮相同的 `startUpdate()`。UI 元信息显示“自动安装已开启/关闭”。
- **验证**：API 状态返回 `autoApply: false`，设置页显示“自动检查每 6 小时 · 自动安装关闭”。为安全起见，没有在用户主 profile 上开启 `true`。
- **后续验证**：`autoApply: true` 已在隔离 profile 自动触发成功；真实 Desktop 默认仍保持关闭。

### 2.4 GitHub API 每小时 60 次限额

- **根因**：GitHub 来源解析每次状态刷新都可能请求 `releases`、`tags` 和 raw `package.json`；原先只有 5 分钟内存缓存。
- **修复**：
  - 增加持久化 `github-cache.json`；
  - 支持 ETag / `If-None-Match`，304 时复用缓存；
  - 403 限流时回退到上次已验证目录；
  - 支持 `config.githubToken`、`DSH_GITHUB_TOKEN` / `GITHUB_TOKEN`；
  - README 增加配置示例。
- **验证**：真实计划调用后生成 `~/.dsh/updates/dsh-update-plugin/github-cache.json`（约 15 KB）；`dsh-boot-animation` 被稳定解析为 `already-current`；计划仍为 0 更新 / 15 保持。
- **继续时**：可再验证第二次请求命中 304 的分支。

### 2.5 插件自身 `file:` 依赖陈旧

- **根因**：`dsh-update-core-plugin` 以 `file:` 依赖安装；pnpm 对同版本 `file:` 目录可能直接复用旧安装目录。代码新增 `store.mjs` 但插件版本仍为 `0.1.0` 时，安装副本缺少该文件，宿主 import 失败，设置页“一键更新”入口消失。
- **对比证据**：本地 Git 历史与 GitHub 对应提交一致：
  - `a6b5c9d`：`plugin/package.json` 为 `0.1.0`，没有 `plugin/lib/store.mjs`；
  - `87a1f0e`：插件升到 `0.2.0`，包含 `store.mjs`；
  - 当前工作副本：插件 `0.2.1`，包含完整 `lib/`。
  - 因仓库本地已有完整历史，未重复从 GitHub 下载 zip；v2rayN 代理实际用于下载官方 Desktop 旧版安装包。
- **修复**：
  - 新增 `scripts/install-plugin.mjs` 与 `npm run plugin:install`：先删除 `node_modules/dsh-update-core-plugin`，再调用 `dsh plugin add`，强制刷新；
  - 插件版本按代码变更递增到 `0.2.1`；
  - README 增加“更新插件自身后运行 `npm run plugin:install`”说明。
- **验证**：实际运行 `npm run plugin:install` 成功，安装副本版本 `0.2.1`，且 `lib/store.mjs` 存在；设置页入口恢复。

## 3. 本轮新增/修改文件

- 新增：`scripts/install-plugin.mjs`
- 修改：`plugin/lib/index.js`、`plugin/lib/plan.mjs`、`plugin/public/index.html`、`plugin/package.json`
- 修改：`package.json`、`package-lock.json`、`README.md`、`CHANGELOG.md`、`HANDOVER.md`
- 当前版本：项目 `0.3.2`，插件 `0.2.1`
- 测试：123/123

## 4. 本地证据文件

```text
.acceptance/core-rollback/old.exe   0.2.1-rc.5 官方安装包，已验签
.acceptance/core-rollback/new.exe   0.2.2-rc.1 官方安装包，已验签
~/.dsh/updates/dsh-update-plugin/   6 条运行记录 + github-cache.json + heartbeat.json
```

这两个 exe 合计约 557 MB，继续完成核心回滚端到端验证前不要删除；完成后可清理。

## 5. 后续仅剩事项

1. `autoApply: true` 已在隔离 profile 验证触发；默认 Desktop profile 保持 `false`。
2. 若继续修改插件代码，先递增 `plugin/package.json` 版本，再运行 `npm run plugin:install`。
3. GitHub ETag/304 已用真实缓存请求验证；无需重复。
4. `.acceptance/core-rollback/*.exe` 已清理，不要再下载旧安装包，除非重新做核心回滚演练。

## 6. 已知非回归项

- `dsh-workbuddy-connect@0.7.9` 仍与当前 DSH 不兼容；DSH 自身会警告并拒绝加载。更新器按需求保持其版本不动，没有删除或禁用。
- 应用当前关闭；下次由用户正常启动即可。
- 未发布 npm，未修改 CI，未启用 `autoApply`，未删除 `.workbuddy`。
