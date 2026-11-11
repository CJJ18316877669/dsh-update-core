# 新会话交接：DSH 一键更新插件

> 交接时间：2026-11-11 11:50 GMT+8  
> 工作区：`C:\Users\18316\Desktop\DeepSeek-Harness-一键更新方案`  
> Git：`main`，最新提交 `29a80c6`，已推送，工作区干净  
> 项目版本：`0.3.11`  
> 已安装插件：`dsh-update-core-plugin@0.2.10`

## 1. 先看这里：当前机器状态

| 项 | 当前值 |
|---|---|
| Desktop 版本 | `0.2.2-rc.1`，exe `0.2.2.0` |
| 安装目录 | `C:\Users\18316\Desktop\hao`（**自定义目录**） |
| Desktop 进程 | 正在运行（5 个进程） |
| 更新插件 | `0.2.10`（`file:` 依赖，指向本仓库 `plugin/`） |
| 插件计划 | `0 个更新 / 15 个保持` |
| 更新历史 | 10 条 |
| 最近一次更新 | `2026-11-11T03-31-07-054Z`，`succeeded` |
| 最近更新结果 | `coreVersion: 0.2.2.0`，`targetCore: 0.2.2-rc.1`，15 个插件保持 |
| 当前核心回滚点 | `core-state.json` 存在，但 **`rollbackInstaller: null`** |
| `active-run.json` | 存在，但已指向 `succeeded`，状态接口会忽略 |
| `ignored.json` | 不存在 |
| 测试 | `npm test` 123/123 |

**重要**：`core-state.rollbackInstaller` 为空，意味着这次从 `0.2.1-rc.5` 更新到 `0.2.2-rc.1` 后，**没有可用的核心回滚安装包**；当前“回滚上一版本”只能恢复 profile 插件，不能把核心降回旧版。旧的 `0.2.1-rc.5` 安装包仍在桌面测试目录，可手动降级。

桌面测试目录：`C:\Users\18316\Desktop\DSH-旧版手动测试`

- `1-安装旧版-0.2.1-rc.5.exe`
- `2-恢复新版-0.2.2-rc.1.exe`
- `手动测试说明.md`

## 2. 这个项目做什么

Windows 上给 DeepSeek Harness Desktop 提供“一键更新”DSH 插件：

1. 检查官方 Desktop 核心版本；
2. 读取 profile 内插件，按核心版本兼容性决定更新/保持；
3. 下载并验证官方安装包签名；
4. 关闭 Desktop，运行安装器更新核心；
5. 根据计划更新插件，恢复 profile；
6. 启动新版本并等待插件心跳确认健康；
7. 失败自动回滚 profile，手动可回滚核心/插件。

## 3. 代码地图

| 文件 | 职责 |
|---|---|
| `plugin/lib/index.js` | HTTP 路由、状态、计划、**异步启动更新**、下载进度、结果轮询 |
| `plugin/lib/helper.mjs` | 关闭 Desktop、运行安装器、pnpm 更新、启动应用、心跳、回滚 |
| `plugin/lib/plan.mjs` | semver、registry/GitHub 版本解析、插件计划、Desktop 定位、官方 feed |
| `plugin/lib/store.mjs` | 原子 JSON、history/core-state/ignored/heartbeat |
| `plugin/public/index.html` | 设置页 UI，**内置进度条**与历史表格 |
| `scripts/install-plugin.mjs` | `npm run plugin:install`，强制刷新 `file:` 插件；从自定义 Desktop 路径推导 CLI |
| `test/*.mjs` | 123 项测试 |

## 4. 本会话已完成并验证的内容

### 4.1 自定义安装目录定位

用户把旧版装到了 `C:\Users\18316\Desktop\hao`，注册表 DisplayName 是 `DeepSeek Harness 0.2.1-rc.5`。旧实现只认固定目录和精确 DisplayName，导致设置页报：

```text
检查失败：未找到已安装的 DeepSeek Harness Desktop
```

已修复 `findDesktopExe()` / `readDesktopVersion()`：

- 读取运行中的 `DeepSeek Harness.exe` 路径；
- 模糊匹配 `DisplayName -like 'DeepSeek Harness*'`；
- 读取 `InstallLocation` / `DisplayIcon`；
- 兼容旧注册表项；`npm run plugin:install` 也从识别到的路径推导 `dsh.cmd`。

实测返回：

```text
exe = C:\Users\18316\Desktop\hao\DeepSeek Harness.exe
version = 0.2.1-rc.5
```

### 4.2 核心回滚端到端验证

已通过 `/api/rollback` 成功跑通一次核心回滚：

- 运行：`2026-11-11T00-50-17-385Z`
- `state: rolled-back`
- `coreRolledBack: true`
- `coreVersion: 0.2.1.0`
- `profileRestored: true`
- `appHealthy: true`
- 之后已恢复 `0.2.2-rc.1`

关键坑：helper 最初以 `DeepSeek Harness.exe` 映像运行，官方 NSIS 安装器把 helper 当成“应用仍在运行”，以 `installer-exit-2` 拒绝降级。最终 helper 改用 Desktop 自带：

```text
resources/runtime/primary-runtime/dependencies/node/bin/node.exe
```

并且 `closeDesktop()` 改为按 PID 逐个 `taskkill`，不再依赖 PowerShell 的 `Path` 判断。

### 4.3 其他已实测项

- 忽略/取消忽略插件：真实降级 `dsh-context` 后验证；
- 插件更新 + 启动心跳 + 手动插件回滚：通过；
- GitHub ETag：真实请求返回 `304`；
- `npm run plugin:install`：同版本 `file:` 依赖强制刷新；
- `autoApply: true`：隔离 profile 中无人工点击自动触发更新（运行 `2026-11-11T01-07-07-413Z`，目标 `dsh-context 0.81.0 → 0.83.1`）；该合成 profile 缺 pnpm 运行时，安装阶段回滚，**只验证了触发，不是完整自动安装成功**；
- 用户手动从 `0.2.1-rc.5` 更新到 `0.2.2-rc.1`：最近运行 `succeeded`，但 **没有核心回滚安装包**。

### 4.4 更新进度内置到 UI

最新改动：

- `/api/update` 立即返回，不再等 280 MB 安装包下载完；
- 后台 `prepare()` 下载并用 `result.json` 写 `state/percent/received/total`；
- 设置页轮询 `/api/result`，显示阶段、百分比、大小、进度条；
- `active-run.json` 让 Desktop 重启后恢复进行中状态；
- 外部浏览器进度窗口已移除（`plugin/lib/progress-server.mjs` 删除）。

实测设置页显示：

```text
下载核心安装包 36% (280.0 MB)
```

进度条宽度 `35.7%`。

## 5. 关键实现注意事项

1. **helper 绝不能用 `DeepSeek Harness.exe` 映像运行安装器**，否则 NSIS 会把它当主程序并以 exit 2 退出；必须用内置 `node.exe`。
2. `closeDesktop()` 当前按 PID 强制 `taskkill`，没有优雅关闭；如果后续要减少未保存数据风险，可先尝试 `CloseMainWindow` 再强制。
3. `startUpdate()` 现在是“立即返回 + 后台 prepare”，错误会写 `result.json` 的 `failed`；不要再改回同步等待。
4. 设置页内联脚本里带连字符的 key 必须加引号（曾经 `downloading-core:` 导致整个 UI 脚本语法错误）。
5. `active-run.json` 即使指向终态也会保留；`status()` 只对非 `succeeded/failed/rolled-back` 显示 activeRun。
6. 当前 `core-state.rollbackInstaller=null`：这是本次更新的真实状态，不是显示 bug。若要让核心回滚可用，需要重新准备旧安装包并写入回滚点，或再次从旧核心升级。
7. **不要删除** `.workbuddy`；不要清理用户 profile；不要在没有确认时关闭正在运行的 Desktop。

## 6. 新会话建议的第一组命令

```powershell
cd 'C:\Users\18316\Desktop\DeepSeek-Harness-一键更新方案'
git status --short --branch
npm test
node -e "const p=require(process.env.USERPROFILE+'/.dsh/profiles/desktop/package.json'); console.log(p.dependencies['dsh-update-core-plugin'])"
```

查看当前运行状态：

```powershell
Get-ChildItem "$env:USERPROFILE\.dsh\updates\dsh-update-plugin" |
  Sort-Object LastWriteTime -Descending | Select-Object -First 8 Name,LastWriteTime
Get-Content "$env:USERPROFILE\.dsh\updates\dsh-update-plugin\core-state.json"
```

安装插件（**必须先退出 Desktop**）：

```powershell
Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue | Stop-Process -Force
npm run plugin:install
```

## 7. 仍未完成 / 建议下一步

1. **确认当前真实更新的进度显示效果**：用户已成功从 `0.2.1` 更新到 `0.2.2`，但没有截图确认设置页进度条在真实 280 MB 下载期间的表现。下次可再准备旧版，点击更新时观察设置页百分比。
2. **修复/补齐核心回滚点**：当前 `rollbackInstaller:null`。下一次核心更新前应确保回滚安装包下载成功；否则应在 UI 明确提示“本次没有核心回滚包”，不要只显示“可回滚”。
3. 如果用户要手动测试核心回滚，使用桌面测试目录的旧安装包重新降级，再执行一次更新；或直接重新生成 `core-state.json`。
4. 清理桌面测试目录的 556 MB 安装包（测试完成后）。
5. `dsh-workbuddy-connect@0.7.9` 仍与当前 DSH 不兼容，这是已知非回归项；更新器保持不动。
6. 正式发布前检查 README/CHANGELOG 是否已反映 0.3.11 / 插件 0.2.10。

## 8. 最近提交

```text
29a80c6 feat: embed live update progress in settings UI
2c749a5 feat: show live update progress during download and restart
a89fd5f fix: locate Desktop installed in custom directories
4800064 docs: record isolated autoApply validation
```

新会话请先读本文，再读 `README.md` 的插件章节。
