# C-002 staging 启动自检接线

状态：已合入（2026-11-09，本地；真机 24.x 验收待完成）
依赖：C-001（禁用通道打通后再验"禁用是否真的生效"）
阻塞：—

## 现状

两个问题叠加，导致"更新后插件仍可用"目前没有任何运行时证据：

1. **`PluginGate.verify()` 是死代码。** `src/plugin-gate.mjs:227` 实现了 verify，但 `src/orchestrator.mjs` 只在 `check()` 里调用了 `this.gate.plan()`（`:216`），**从未调用 `this.gate.verify()`**。全文件只有两处 `this.gate`，没有第三处。
2. **`backend.health()` 太弱。** 只比版本号和 `plugins.json`，插件 import 失败、启动日志报错都抓不到。

结果是：装上去一个坏插件，流程照样走到 `succeeded`。

## 对外接口

这里有两件事，签名不同，**不要混成一个**：

```js
// 1) 整 profile 启动自检：一次，由 backend 提供
stagingHealth(profilePath) => Promise<{ok: boolean, checks?: string[], reason?: string}>

// 2) 逐项回填：已有实现，签名不要改
PluginGate.verifier(item) => Promise<boolean | {ok: boolean, reason?: string}>
PluginGate.verify(plan) => Promise<plan>        // src/plugin-gate.mjs:227
```

- 注入点：`new PluginGate({ verifier })`（构造参数已支持）
- 调用点：`UpdateOrchestrator.start()` 内，`backend.prepare()` 成功之后、`journal.transition('applying')` 之前
- 顺序固定：**先整 profile 启动 → 通过后，若 plan 里仍有 `item.verify === true` 的项，再调 `gate.verify(plan)` 逐项回填**。反过来的话，staging 根本起不来，逐项验证没有意义。

## 不变量

1. **时机**：必须在 `applying` 之前。提前到 `check()` 会在还没安装时误禁用插件；拖到 `activate()` 之后则已经污染正式 profile，回滚成本陡增。
2. **零污染**：verify 失败时正式 profile 一个字节都不能变，journal 仍停在 `prepared`，staging 目录可清理。
3. **处置方向**：可选插件失败 → `disable`；core 插件失败 → `block`。该分支 `PluginGate.verify()`（`:243-253`）已实现，不得改顺序。
4. **超时可判定**：默认 30s，超时按失败处理，不得让流程挂起。
5. **证据落盘**：journal 或 audit 中留下 `--version`、`--dump-config` 的输出尾部与启动日志尾部各 200 行。
6. **幂等**：同输入连续两次 verify，结论一致。

## 已确认

- staging 目录重构为独立的 `<staging>/home/profiles/<name>`，命令为 `node <bin> --profile <name> --dump-config` 与 `node <bin> --profile <name>`，通过 `DSH_HOME` 指向 staging home。
- 成功判据：`--version` 与目标版本一致、`--dump-config` 退出 0、启动探测在就绪窗口内保持运行或退出 0。
- 端口冲突不重试：进程非 0 退出即失败；由可选插件/核心插件身份规则处置或安全中止。

## 禁止

- 不得把 verify 失败降级为 warning
- 不得在 `check()` 阶段调用
- 不得让 verifier 直接改 profile（它只读 + 报告，改动由 gate 决策）
- 不得在 verify 里 sleep 轮询超过 30s

## 验收

四场景，缺一不可：

| 场景 | 期望 |
|---|---|
| 正常插件 | verify 通过，流程走 `applying` |
| 坏插件（import 抛错） | 可选 → `disable`；core → `block`；**正式 profile 的 mtime 与内容 hash 均未变** |
| 超时（verifier 卡住 35s） | 按失败处理，30s 内返回，不挂起 |
| 端口占用 | 按契约里"待确认"的结论行事，且结果可复现 |

关键断言是第二条的"零污染"：不只是 journal 停在 `prepared`，还要比对正式 profile 目录树的 hash。

## 交付物

- `src/orchestrator.mjs` 中新增两处调用（约 15 行，位置在 `prepare` 与 `journal.transition('applying')` 之间）
- `src/backends/npm.mjs` 中新增 `stagingHealth`（启动 staging profile，抓 `--version`、`--dump-config`、日志尾部）
- `test/staging-verify.test.mjs`
