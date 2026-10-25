# 反馈：自动刷新应默认关闭，只留人手动刷

写于 2026-10-25 23:50。用户原话的要求：不要自动刷新（或给开关，默认关）；只有人能刷；agent 不能自己刷，但要知道「让用户点刷新」而不是重启 App。

## 现状

1. **安装即自动生效，用户没有选择**。仓库 `cordis.patch.yml` 把 shipped `hmr` 打开（注释：桌面启动器默认关，这里替它开），`apply()` 里再无条件调用 `syncWatching()`（`index.js:1291-1305`）。运行时日志 `watching 11 package dir(s)`，11 个包目录里包含 profile 按路径链接的开发仓库（`linkedRoots()`，`index.js:165`），所以 `~/Desktop/DSH/*` 任何一次保存都会触发一次全量插件重载。
2. **唯一的关闭方式是未文档化的字段** `config.plugins: 'off'`（`index.js:1292`、`index.js:1301`）。Settings 里没有这一行；两个开关 `reloadPlugins` / `reloadInterface` 只决定「按下之后做什么」，不是「要不要自动触发」。
3. **日志不区分来源**。自动触发的 `reloading after a change to index.js` 与人手点的 `reloading while turns are still running` 混在同一个 `~/.dsh/unlag-reload.log` 里，也不写是哪次会话、哪一层触发的。这次用户问「为什么自动刷了好几次」，只能靠文件 mtime 反推，这正是要补的。

## 建议改法（按优先级）

1. **新设置行「改动文件时自动刷新」，默认关**。内部沿用已有的 `plugins: 'off'` 语义，改成布尔 `autoReload`（默认 `false`）。`autoReload !== true` 时不调用 `startWatching()`，一个 watch 根都不装；Settings 里显示为第三行（`SCHEMA`/`FIELDS`，`index.js:70-85`）。
2. **`cordis.patch.yml` 的 `- id: hmr` 默认不启用**，或与 `autoReload` 联动。`hmr` 一旦开着，profile 模块和链接包还有一层独立触发源；默认关时 unlag 拿不到 `baseDir`，`linkedRoots()` 自然为空，两层触发同时消失。
3. **手动刷新是唯一入口**：右上角按钮保持现状。不要给 agent 注册 tool，也不要让 agent 能直接打刷新路由 —— 用户明确要「agent 不能自己刷」。
4. **但要给 agent 一条「知道」的路径**，让它在改完插件后主动提示用户，而不是建议重启 App：README 一段 + `package.json` description + `apply()` 启动日志一行，例如
   `plugin reload is manual: ask the user to press the refresh button; do not restart the app`。
   现在启动日志只有 `watching N package dir(s)`，agent 从里面读不到这件事。
5. **自动模式保留但默认关**；开启后仍用现有实现：1.5s 去抖（`MIN_INTERVAL_MS`）、指纹比对去重、`MAX_DEFERRALS`（`index.js:58-59`）。同时在日志里标来源与触发文件：`auto reload after a change to <file>` / `manual reload`，让下次追查不用猜。
6. **确认关掉后无副作用**：`serveButton` 的重建路径只由按钮按下驱动（状态接口 `{plugins, page, shim}`，`index.js:1196`），`client.js` 里没有 watch 相关逻辑，`/plugins` bundle shim 与 watcher 无关。关掉 watcher 只影响「自动触发」这一件事。

## 兼容性

- 默认行为变更（原来自动生效 → 现在要人点），CHANGELOG 必须写明；README 现在的主交互本来就写「改完插件点一下就生效」，文案不用动。
- 老配置里的 `plugins: 'off'` 继续有效，与新的 `autoReload: false` 等价，不必迁移。
