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
