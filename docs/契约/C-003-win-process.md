# C-003 Windows 启动与进程树

状态：已合入（2026-11-09，本地；远端 Windows runner 待跑）
依赖：—
阻塞：C-001、C-002（本机跑不起来，后面都验不了）

## 现状

**问题一：Windows 上 npm 起不来。**
`src/backends/npm.mjs:118` 在 win32 下用 `npm.cmd`，而 `runCommand`（`:36-41`）是 `shell: false`。Node 20.12+ 的安全修复后，不经 shell 启动 `.cmd` / `.bat` 会被拒绝（EINVAL）。也就是说 Windows 侧 npm 后端是**完全不可用**，不是"偶尔失败"。

**问题二：超时不杀子进程。**
`:45` 与 `:49` 用 `child.kill('SIGTERM')`。Windows 没有信号语义，等价于 TerminateProcess，只杀 `npm.cmd` 本身。npm 派生的 node 进程成为孤儿，继续占用 profile 目录——直接导致 C-004 里的 `rename` 失败。

## 对外接口（内部，不对外导出）

```js
runCommand(command, args, {cwd, signal, timeoutMs}) => Promise<{stdout, stderr}>
killTree(child, {graceMs}) => Promise<void>
```

## 不变量

1. **能启动**：Windows 上必须能在 `shell: false` 下启动 npm。首选 `process.execPath` + 解析到的 `npm-cli.js` 路径；退路是受控 `shell: true`，且只允许 `npm` 一个命令名，参数走数组不拼字符串。
2. **杀干净**：超时或 abort 后，整棵进程树必须终止。结束判定不看 `child.on('exit')`，要看系统视角：Windows `tasklist` 无残留、POSIX `ps` 无残留。
3. **语义不变**：非 0 退出仍映射 `UPD-501`；`details.stderr` 仍是尾部 2000 字符；超时文案不变。
4. **幂等**：对已退出的子进程调用 `killTree` 不抛错。
5. **零依赖**：不引入 `tree-kill` / `cross-spawn` 之类。

## 平台实现约定

| 平台 | 启动 | 终止 |
|---|---|---|
| POSIX | 直接 spawn，`detached: true` 建进程组 | `process.kill(-child.pid, 'SIGTERM')`，graceMs 后 `SIGKILL` |
| Windows | 优先 `execPath + npm-cli.js`；否则 shell + 命令白名单 | `taskkill /pid <pid> /T /F`（`/T` 必须有） |

注意：`detached: true` 在 POSIX 上会脱离父进程组，必须显式 `unref` 之外的清理逻辑，否则测试进程会挂住。

## 已确认

- 更新器使用 Node ≥20；目标 dsh 自身的 `engines.node` 在 `check()` 阶段单独校验，不能用更新器的下限推断 dsh 可运行。
- Windows 优先解析 `npm-cli.js` / `pnpm.cjs` 并用 `process.execPath` 启动；只有解析失败才使用包管理器命令白名单的受控 shell 退路。

## 禁止

- 不得用 `shell: true` 拼字符串命令（注入风险，且路径含空格会碎）
- 不得在 `killTree` 里用固定 `setTimeout` 代替真实进程状态检查
- 不得改变 `runCommand` 的调用方签名（`prepare` 和 `snapshot` 都在用）

## 验收

```
npm test -- --test-name-pattern "npm backend"
```

- `windows-latest` 上 `test/npm-backend.test.mjs` 全部通过
- 超时用例：安装开始 3 秒后 abort，随后检查系统进程表无该树下残留
- 取消用例：`AbortController.abort()` 后，staging 目录可立即删除（证明没被占用）

## 交付物

- `src/backends/npm.mjs`：`runCommand` 重构 + `killTree`
- `src/platform/process.mjs`（新增，放平台分支，避免 npm.mjs 里散落 `process.platform` 判断）
- `test/npm-backend.test.mjs` 增补超时与残留检查
