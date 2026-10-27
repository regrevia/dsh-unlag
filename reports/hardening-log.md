# 加固日志（Lead）

窗口：2026-10-27T00:58 CST 起，目标 ≥8 小时连续迭代，产物 1.11.x → 1.12.0。
基线：v1.11.0（commit d76a95f），`node scripts/test.mjs` 37 文件全绿，116.7 s。

## 进度

| 时间 (CST) | 事件 | 证据 |
| --- | --- | --- |
| 08:04 | 线上只读巡检：`/state` 报 1.11.0、plugins/page true、agentRefresh false、operation null | curl `/dsh-unlag/state` |
| 08:17 | 405 路由行为符合预期（GET `/boot` `/verify` `/report` 返回 `{"status":"method"}`） | curl |
| 08:20 | 发现 P0：apply 半途抛错被吞，Agent 工具从未注册，且 dispose/实例/shim 收尾未执行 | `~/.dsh/unlag-reload.log` 每次加载都打印 `plugin reload did not start: cannot get property "tools" without inject` |
| 08:24 | 本机复现 P0（类 Cordis 的 ctx：未注入服务属性访问即 throw）：`instance-set:false`、`routes-set:false`、日志命中 `plugin reload did not start` | `/tmp/unlag-probe/probe.mjs` |

## P0 明细

- 现象：1.11.0 在真实 app 中 `apply()` 于 `registerAgentTool()` 第一行抛错（`ctx.tools` 未声明 inject ⇒ Cordis 拒绝访问），异常冒到 apply 外层 catch 后只记一行日志。
- 影响：`globalThis[Symbol.for('dsh-unlag.instance')]` 未赋值、`ctx.on('dispose')` 未注册、启动时 `syncBundles()` 未执行、`own.routes` 未记录。即：每次换代旧副本不会自行清理（跨按压累积泄漏），所有权判断失效，Agent 侧刷新入口不存在。
- 修法（交给 host-hardening，index.js）：用 `ctx.inject(['tools'], scope => …)` 动态注入作用域挂工具；取服务永不抛；把工具注册放到 apply 收尾最后一步且失败不影响其它收尾。
- 复现命令：`node /tmp/unlag-probe/probe.mjs`（假 ctx 访问未注入属性即抛错）。

## 团队

- `host-hardening` → task-3（index.js）：已完成计时器卫生（3 处泄漏）、并发（26 断言）；进行敌意 HTTP、损坏状态、生命周期、种子长跑。
- `client-stability` → task-4（client.js）。
- `chaos-lab` → task-5（只加混沌/soak 测试与报告）。

## 第二轮：1.13.0「该刷时能刷，不该刷时说实话」

窗口：2026-10-27 傍晚起。基线 v1.12.4（commit `1c874a8`），51 个测试文件全绿。

产品承诺拆成三条，先修能直接说谎或卡住的五处：

1. **可信的「允许刷新」** —— `/verify` 只核这一页的启动脚本，`require.async` 的分块坏了也算 `ok`。
   现在按每条启动脚本自己那一版地址读它要的分块（每批最多 24 个），404/空内容判 `blocked` 并点名分块；`ok` 回包补回 `lazy` 字段。
2. **异常不卡住宿主** —— 日志目标若是 FIFO、符号链接或目录，原来的同步写会挂住按压线程。
   现在只对小体积普通文件追加，非普通文件/超大文件当作不可写，失败后 1 秒内不再重试，全程不抛给调用方。
3. **结果说实话** —— 两处：工具忽略 `exec.signal`，被停掉的调用仍会换插件；同一 `requestId` 撞上 `applying` 后会把「还在刷新」当成终态缓存。
   现在排队前/等最小间隔时被取消回 `cancelled` 且不落记录、不动插件；加入进行中更新的请求记下加入的是哪个操作，等它落地后用同一 `requestId` 读到那次更新的真实终态。

验收场景（8 个）与证据：

| 场景 | 断言的机器事实 | 测试文件 |
| --- | --- | --- |
| 1–3 分块/`verify` 正确性 | 分块 404 判 `blocked` 并点名；`ok` 带 `lazy`；未变化的插件不被误判 | `test/chunk-availability.test.mjs`（4 断言） |
| 4 日志目标异常不卡宿主 | FIFO/符号链接/目录/写失败四种目标各自在百毫秒级返回；恢复后普通文件重新写成功 | `test/log-target.test.mjs`（5 断言） |
| 5 排队中被取消 | 预取消、等间隔中取消均回 `cancelled`、`reconcileProfile` 调用 0 次、无操作记录；取消不烧掉下一次的间隔 | `test/agent-tool.test.mjs`（新增 9 断言） |
| 6 并发 `requestId` 各读真实终态 | B 撞上 A 的更新回 `applying`；A 结束后 B 重试读到 A 的 `done`（另测 `failed` 分支），且只组合一次插件 | `test/agent-tool.test.mjs`（新增 11 断言） |
| 7 异常超过展示上限仍判完整 | 48 个插件停 40 个：`/state.operation.failed=40`、`rebuild=unsafe`、重试同一句 | `test/anomaly-cap.test.mjs`（11 断言） |
| 8 真机刷新 | 对真实桌面宿主（`127.0.0.1:50937`）跑 `scripts/live-smoke.mjs`：`verdict=true`、`holdReason=null`、`verify.sound=ok`、`verify.broken=blocked`、403/405 契约全部成立；脚本只读、不代按 | `scripts/live-smoke.mjs` 输出 |

门禁（全零）：`node scripts/test.mjs`（51 文件）、`npm run audit`、`ui-copy-lint`、`style-lint`、`zh-lint`。

已知边界（本轮不承诺）：页面重开这一下只能由人在页面上按，脚本不代按；启动列表里被卸掉的插件仍按设计拒绝重建（重建会让桌面壳退出、杀掉正在跑的回合）；`next`/`latest` dist-tag 与打包校验留到下一轮。
