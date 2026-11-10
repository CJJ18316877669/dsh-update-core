# 暂停交接：Desktop 插件问题定位与补全

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
  6. 最后手动恢复到 `0.83.1`，清理测试回滚点和忽略状态。
- **结论**：忽略/取消忽略、真实插件更新、静态健康检查、启动心跳、手动插件回滚均已实机通过。

### 2.3 定时检查只刷新状态，不会静默安装

- **根因**：这是原先刻意采用的安全默认值，避免后台自动关闭应用。
- **修复**：新增 `autoApply` 配置，默认 `false`。`autoCheckHours > 0` 时定时执行 `status(true)`；若 `autoApply: true` 且发现更新，则调用与按钮相同的 `startUpdate()`。UI 元信息显示“自动安装已开启/关闭”。
- **验证**：API 状态返回 `autoApply: false`，设置页显示“自动检查每 6 小时 · 自动安装关闭”。为安全起见，没有在用户主 profile 上开启 `true`。
- **继续时**：应在隔离 profile 或可中断环境验证 `autoApply: true`，不要在默认 Desktop profile 直接开启。

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

## 5. 继续时的建议顺序

1. 正常启动 Desktop，进入 `设置 → 一键更新`，确认 0 更新 / 15 保持、回滚按钮禁用、历史 6 条。
2. 构造一个明确的测试回滚点：
   - `core-state.json` 指向已验签的 `old.exe`；
   - `rollbackPackage` 指向当前 profile 清单备份；
   - 通过 UI 点击“回滚上一版本”；
   - 预期结果 `rolled-back`、`coreRolledBack: true`、`appHealthy: true`。
3. 验证后立刻运行 `new.exe /S --updated` 恢复 `0.2.2-rc.1`，并确认注册表 `DisplayVersion` 为 `0.2.2-rc.1`。
4. 在隔离环境验证 `autoApply: true` 与 GitHub 304 缓存分支。
5. 若继续修改插件代码，先递增 `plugin/package.json` 版本，再运行 `npm run plugin:install`。
6. 最后删除 `.acceptance/core-rollback/*.exe` 或归档到外部位置。

## 6. 已知非回归项

- `dsh-workbuddy-connect@0.7.9` 仍与当前 DSH 不兼容；DSH 自身会警告并拒绝加载。更新器按需求保持其版本不动，没有删除或禁用。
- 应用当前关闭；下次由用户正常启动即可。
- 未发布 npm，未修改 CI，未启用 `autoApply`，未删除 `.workbuddy`。
