# C-001 ProfileStore：让"禁用"在真实 dsh 中生效

状态：待实现
依赖：C-003（Windows 启动修好，否则本机跑不起来）
阻塞：C-002

## 现状

`JsonPluginStore`（`src/plugin-gate.mjs:296`）把禁用记录写进 `plugins.json`，但 dsh 不读这个文件。用户看到"已禁用 2 个插件"，重启后插件照常加载。

这是产品四条承诺里最硬的一条——"不兼容插件可禁用、不删除、可恢复"——目前是假的。

## 对外接口

必须与 `JsonPluginStore` 同形，可直接替换，不改调用方：

```js
disable(plugin: {name: string, version?: string}, reason: string) => Promise<handle>
enable(handle: {name: string} | string) => Promise<{name: string}>
```

`PluginGate.disable()`（`:262`）与 `PluginGate.restore()`（`:269`）已按此形状调用，**不要改 gate**。

## 不变量

1. **真值唯一**：`$DSH_HOME/profiles/<name>/cordis.patch.yml` 是唯一事实来源；`restore.json` 只是还原备份，任何代码不得把它读成当前状态。
2. **不碰 node_modules**：`disable` 只改配置文件，不移动、不删除、不重命名任何包目录。
3. **最小改动**：除目标插件对应条目外，其余字节完全保留——注释、空行、顺序、缩进、引号风格、行尾符。
4. **幂等**：同一插件连续 `disable` 两次，第二次执行后文件字节与第一次完全一致，不产生重复条目。
5. **可还原**：`enable` 后文件必须回到 `disable` 之前的字节状态；若原本没有该条目，则删除条目，而不是留 `disabled: false`。
6. **拒绝核心插件**：`isCorePlugin(plugin)` 为真时抛错，且文件不得被修改。
7. **原子写**：临时文件 + rename，崩溃不留半截 YAML。

## 待确认

**实现前必须先回答，答不出来就不要写代码。**

`cordis.patch.yml` 里"禁用某个插件"的准确写法是哪一种？

- a) 该插件条目下加 `disabled: true`
- b) 顶层维护一个 `disabled:` 列表
- c) 从 patch 中移除该条目
- d) 完全不同的结构

验证方法：拿一个真实 fixture profile，改一处，跑 `dsh --dump-config`，看该插件是否从配置中消失。**这一步没做，写出来的实现只是看起来对。**

## 禁止

- 不新增 YAML 依赖（零依赖是核心卖点）。必须解析就写最小行级扫描，且只处理本契约涉及的形状。
- 不改 `PluginGate` 的判定顺序、不改 `summarize()` 的字段。
- 不删除 `JsonPluginStore`——它作为测试后端保留。
- 不在 store 里做重试/回滚决策（那是 orchestrator 的事）。

## 验收

```
npm test -- --test-name-pattern profile-store
```

必须通过的五条：

1. fixture profile 上 `disable` → `dsh --dump-config` 输出不含该插件
2. 紧接 `enable` → `--dump-config` 恢复，且 patch 文件与原始 fixture 逐字节一致（`diff` 为空）
3. `disable` 两次 → 文件不变（幂等）
4. core 插件 → 抛错，且文件未变
5. 脏输入：CRLF、无结尾换行、中文注释、缩进为 2 空格与 4 空格混用 → 均正确处理，其余内容不变

## 交付物

- `src/profile-store.mjs`
- `test/profile-store.test.mjs`
- `test/fixtures/profile-min/`（含一个最小 `cordis.patch.yml`，带注释与中文）
