# C-004 profile 原子切换与回滚

状态：待实现
依赖：C-003（进程不杀干净，rename 必失败，测不出真实问题）
阻塞：—

## 现状

`activate()`（`src/backends/npm.mjs:395-428`）用两次 rename 交换目录：

```js
if (await exists(this.profileDir)) { await rename(this.profileDir, previous); moved = true; }
await rename(staged.path, this.profileDir);
```

`rollback()`（`:419-425`）先 `rename(profile → .failed).catch(() => {})`，再 `rename(previous → profile)`。

**问题**：第一次 rename 的错误被 `.catch(() => {})` 吞掉，紧接着的第二次 rename 必然因为目标仍存在而失败。异常抛出后 orchestrator 进 `safe-mode`。这是"更新失败也回滚不了"的最短路径。

在 Windows 上，目录被占用（dsh 正在运行 / 杀软扫描 / 句柄未释放）是常态而非异常，所以这条路径很容易真实触发。

## 对外接口

不改。`activate(staged)` 仍返回 `{id, plan, commit, rollback}`。

## 不变量

1. **完整性**：任一时刻 `profiles/<name>` 要么是完整旧版、要么是完整新版，不存在"半个 profile"。
2. **失败可回**：交换失败必须回到旧版，且 journal 停在可恢复状态（`applying` 之前失败 → `failed`；之后 → `rolling-back`）。
3. **不吞异常**：任何影响正确性的 `rename` 不得用 `.catch(() => {})` 静默。清理类操作（删 `.old-*`）可以吞，交换类不可以。
4. **重试有边界**：只对 `EPERM` / `EBUSY` / `EACCES` / `ENOTEMPTY` 重试，退避 50 / 150 / 400ms，最多 3 次。
5. **跨卷降级**：`EXDEV` 不重试，改走"复制到目标卷 → 校验 → 切换"，并在 journal 标记降级模式。
6. **回滚终局**：旧版拿不回来 → `safe-mode`，journal `failed` + `safeMode: true`，并且必须把 `.failed-*` 目录的绝对路径写进 journal，供人工恢复。
7. **路径边界**：所有 rename / cp 的源与目标都在 `$DSH_HOME/updates` 或 `$DSH_HOME/profiles` 下。现有前缀校验（`:464-467`）不得移除。

## 待确认

- `dsh` 运行时是否会持有 profile 目录内的文件句柄？如果会，"先排空再切换"（`drain`）就要覆盖到所有常驻进程，而不只是任务队列。
- Windows 上是否需要在 rename 前显式清空该目录的只读属性？npm 安装出来的部分文件可能带只读位。

## 禁止

- 不得把"复制整个 profile"作为默认路径（慢且耗盘），只能作 EXDEV 降级
- 不得在 `activate` 里做清理（清理属 `commit`）
- 不得在 `commit` 成功前删除 `.old-*`
- 不得为了"看起来通过"把 rename 失败改成 `console.warn`

## 验收

用注入式失败模拟，四条：

| 注入 | 期望 |
|---|---|
| 前两次 `EPERM`，第三次成功 | 最终 `succeeded`，无残留目录 |
| 持续 `EPERM`（3 次全失败） | 回滚成功，版本回到旧版，journal `rolled-back` |
| 交换成功但 `rollback` 也失败 | `safe-mode`，journal `failed` + `safeMode:true`，journal 含 `.failed-*` 路径 |
| 模拟 `EXDEV` | 走复制降级且成功，journal 标记降级 |

补充：`rm -rf` 式的"先删后换"方案不予接受——它把"可回滚"降级成"不可回滚"，违反不变量 2。

## 交付物

- `src/backends/npm.mjs`：`activate` / `rollback` 重写交换逻辑
- `src/platform/fs.mjs`（新增）：`renameWithRetry`、`copyFallback`、`isRetryable`
- `test/npm-backend.test.mjs`：4 个注入场景
