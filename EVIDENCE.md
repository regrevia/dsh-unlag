# 凭什么信这个插件

每一类说法都跟着能自己重跑的证据：先看哪条测试、再看运行中的 App 上哪个输出。运行中的证据用 `npm run live-smoke` 拿，它不按按钮，也从不换代码。

## 按下去真的会生效

| 说法 | 测试 | 现场 |
| --- | --- | --- |
| 一次按下只请求一次重建，连按只算一次 | `press.test.mjs`（99）、`reload-answer.test.mjs`（26） | `pressPath.ready` 为 `true` 表示此刻放行 |
| 重建后新文档能起来：清单里每个脚本都能加载、每个插件都注册 | `bundle-shim.test.mjs`（76）、`host-verify.test.mjs`（45） | `verify.sound=ok`、`rehearsal.ok=true` |
| 坏清单会被拒，不会带着坏字节去开新文档 | `host-verify.test.mjs`（45）、`verify-deadline.test.mjs`（7）、`url-fuzz.test.mjs`（5） | `verify.broken=blocked`、`verify.refuses=true` |
| 冻结清单里的旧 revision 仍然拿得到现在的字节 | `bundle-shim.test.mjs`（76） | `shim.staleRev` 为 200 且字节数 > 0 |
| 按钮不会装作在工作：挡住时提示写的是真实原因 | `reason-copy.test.mjs`（6）、`copy.test.mjs`（8）、`client-guard.test.mjs`（123） | 每次拦下都在日志里留一行，带原因与地址 |

## 不会把 App 弄崩

| 说法 | 测试 |
| --- | --- |
| 任何插件、任何服务、任何路由抛错都只丢一个答案，不往上冒 | `hostile-services.test.mjs`（20）、`route-hostile.test.mjs`（30）、`route-guard.test.mjs`（16）、`hostile-host.test.mjs`（12）、`safety.test.mjs`（22） |
| 文件监听器出错、日志写不出去、日志爆量都只是少一行记录 | `watch-faults.test.mjs`（11）、`log-faults.test.mjs`（17）、`log-burst.test.mjs`（3）、`log-cap.test.mjs`（9） |
| 慢插件、卡住的读取、并发按下都不会拖住页面或进程 | `reload-late.test.mjs`（10）、`verify-deadline.test.mjs`（7）、`verify-route.test.mjs`（19） |
| 卸载插件时半开的定时器、监听、路由全部关掉，且不误关别人的 | `button.test.mjs`（89）、`client-guard.test.mjs`（123） |
| 8 个历史版本的页面（旧代码）对着新宿主按，都不抛、都只请求一次重建、都不留失败提示 | `old-page.test.mjs`（5） |

## 别人不能替你按

| 说法 | 测试 | 现场 |
| --- | --- | --- |
| 别的源的页面按不动这个按钮 | `button-origin.test.mjs`（25）、`request-shape.test.mjs`（6） | `contract` 里三条外来源请求全部 403 |
| 读路由只认读，写路由要那个页面才能带的头 | `report-route.test.mjs`（8）、`route-hostile.test.mjs`（30） | `contract` 里缺头、乱方法全部 403/405 |
| 域名重绑（Host 与 Origin 一致但都是公网名）不能用，公网名的页面一律 403 | `button-origin.test.mjs`（25） | 手工 curl 复核过一次：403 |

## 证据怎么重跑

```sh
npm test                     # 726 项，全绿才算数
npm run audit                # 静态检查
npm run live-smoke           # 对着运行中的 App 复核；输出里 verdict 为 true 才算数
./scripts/release.sh         # 发布并回查 registry 是否真的列出这个版本
```

发布物本身也核对过：`dsh-unlag-1.9.122.tgz` 里的 `index.js` 与仓库同文件 sha256 相同（`851386c9…`），包里没有 `test/`。

演练输出里的每一项含义见 README「改完后让运行中的 App 用上」。


## 1.12.x 的证据

| 说法 | 证据 | 怎么重跑 |
| --- | --- | --- |
| 读未声明的服务会打断启动，1.12.0 之后不会 | `test/stability-host-agent-tool.test.mjs`：假 ctx 对 inject/effect/reflect 与所有未声明服务一律抛错，仍能挂路由、记实例、注册 dispose | `node test/stability-host-agent-tool.test.mjs` |
| Agent 工具确实注册了，且只注册一份 | 同文件的六种上下文（无服务、服务在、服务晚到、属性读抛错、routes 抛错、inject 拒绝）；关闭开关时 execute 答 `blocked` | 同上 |
| 按压不额外等 1.5 秒 | `scripts/soak.mjs` 在 `DSH_UNLAG_ANSWER_MS=20`、`minIntervalMs=0` 下单种子 792 步：p99 23.3 ms、max 26.0 ms（修复前同场景第二次更新要等约 1.47 s） | `DSH_UNLAG_SOAK_MS=6000 DSH_UNLAG_SOAK_SEEDS=1 DSH_UNLAG_ANSWER_MS=20 node scripts/soak.mjs` |
| 计时器不残留 | `test/stability-host-timers.test.mjs`：每次按压后无残留 timeout，dispose 清空；soak 里 `timers 0→23→0` | `node test/stability-host-timers.test.mjs` |
| 一次按压只落一个结果 | `test/stability-host-concurrency.test.mjs`、`test/chaos-core.test.mjs` | 两个文件都可单跑 |
| 页面不会有第二个按钮、不会在不该关的时候留着菜单 | `test/stability-client-mount.test.mjs`（19）、`test/stability-client-menu.test.mjs`（21）、`test/stability-client-button.test.mjs`（22）、`test/stability-client-guard.test.mjs`（23） | 四个文件都可单跑 |
| npm 渠道 | `dsh-unlag@1.12.3` 已发布，registry `dist-tags.latest = 1.12.3`（158 个版本，最新三个 1.10.1 / 1.11.0 / 1.12.3）；发布前 `--dry-run` 文件清单 11 个、85.3 kB | `curl -s https://registry.npmjs.org/dsh-unlag \| python3 -c "import json,sys; print(json.load(sys.stdin)['dist-tags'])"` |
| 每一种回答下按钮都能再按 | `test/stability-client-health.test.mjs`：10 种替换回答（含没有回答、health 读不到、要重启）×「不抛、导航次数与回答一致、只剩一个可按按钮、提示一行」；再加 3 个种子 × 60 次交互（按、连按、改回答、开菜单、推进时钟）后仍是一颗可按按钮，卸载后监听器与定时器归零 | `node test/stability-client-health.test.mjs` |
| 设置文件读不完也不卡 App | `test/switches-route.test.mjs` 末尾：把 `unlag-switches.json` 换成管道，`/state` 在 1.5 秒内照常作答（`saved:false`，用设置行的值） | `node test/switches-route.test.mjs` |
| 打包路由不会吊住页面 | `test/bundle-shim.test.mjs` 新增两条：路由拿着请求不回话时页面在 60 ms 内拿到 503，日志写出「the route that owns bundles did not answer in time」 | `node test/bundle-shim.test.mjs` |
| 1.12.1 全量 | 46 个测试文件全过，0 FAIL；`npm run audit` 0 错；三条 lint 0 error | `npm test` |

已知未修：打包转发（`/plugins/<id>`）没有自己的超时，模块表卡住时会一直挂着；`applying` 一个词同时表示「槽位被占」和「自己的更新超时未回」。见 `reports/chaos-findings.md`。

## 还没证到的两件事

- **人手按下的那一下**：只有人按才会真的换插件代码，这台机器上最后一次真按是 1.9.30。`pressPath.ready` 证明的是「此刻按下去会被接受」，不是「按过了」。
- **日志轮转在真实 App 里发生**：真实日志还不到上限的一半，轮转只有离线测试（`log-cap.test.mjs`）证过，没在现场触发过。

## 1.14.8 补丁：按钮在「已经坏了一个插件」的机器上还能用

五件事一起改的，每件都有可重跑的判据。全部用例 61 个文件、1397 项检查点全绿（`npm test`，2026-10-29 本机实测，EXIT 0）。

| 说法 | 证据 | 怎么重跑 |
| --- | --- | --- |
| 一个之前就停掉的插件不再把每次按压判成失败 | `test/health-memory.test.mjs`、`test/press-final.test.mjs`：早就停掉的条目仍出现在 `carriedEntries`，但 `status` 是 `done`、`rebuild` 是 `safe`、`failedEntries` 为空 | `node test/health-memory.test.mjs; node test/press-final.test.mjs` |
| 页面启动时上报的那份冻结清单，能被按压后新加载的那份插件读到 | `test/boot-survives-reload.test.mjs`：同一进程里先挂一份、POST `/boot`、再挂第二份（按压换的就是这份），第二份读 `/state` 仍拿到 `rev: page-1` 和同一份冻结行；清单存在 `Symbol.for('dsh-unlag.boot')` 上，不随插件副本消失 | `node test/boot-survives-reload.test.mjs` |
| 老宿主按 `dsh-unlag/package.json` 找清单时不再 `ERR_PACKAGE_PATH_NOT_EXPORTED` | `test/package-discovery.test.mjs`：把 `package.json` 声明的文件按 `files` 复制成真包目录，用真的 `createRequire(...).resolve('dsh-unlag/package.json')` 走两条路径；删掉 `exports['./package.json']` 这条会复现 `ERR_PACKAGE_PATH_NOT_EXPORTED` | `node test/package-discovery.test.mjs` |
| 一句话的提示框不再是一条长框 | `client.js` 的 `PILL_STYLE`：`maxWidth: 'min(340px, 82vw)'` + `alignSelf: 'flex-end'`，没有固定 `width`；`test/reason-copy.test.mjs` 钉住这三条 | `node test/reason-copy.test.mjs` |
| 真机上按下去确实是 done | 本机 `/state` 三次记录的 `operation`：`{id:154,status:done,rebuild:safe}`、`{id:155,…done…}`、`{id:156,…done…}`；同一个 profile 里 `adb (dsh-mobile-use)`、`crash-lore (dsh-crash-lore)` 从上一轮起就没起来，日志如实写「still stopped from an earlier press: crash-lore, adb」，但不再出现「a plugin stopped running with this update」 | `curl -s http://127.0.0.1:62741/dsh-unlag/state`；`tail -30 ~/.dsh/unlag-reload.log` |
| 「没有按钮」这件事有可核对的读数，不只在日志里 | `/state.served`：`{status:'served'|'missing'|'unknown', entries, id}`；`test/served-report.test.mjs` 11 项覆盖在、不在、空集、读不了四种情况，并要求这条日志每进程只写一次 | `node test/served-report.test.mjs`；真机 `curl -s http://127.0.0.1:62741/dsh-unlag/state` 现在是 `{"status":"served","entries":90,"id":"dsh-unlag"}` |
| 真机上的按钮契约与启动校验 | `DSH_UNLAG_HOST=http://127.0.0.1:62741 npm run smoke` EXIT 0：`verdict: true`、`shimWrapped: true`、`ready: true`、九条写路由的 403/405 契约全对，它读的正是这台机器上 90 个插件的真插件图 | 上面这条命令 |
| 宿主看到的是「安装出来的包」，不是仓库 | `test/packed-install.test.mjs` 12 项：`npm pack` 出 tarball → 装进一次性 profile 的 `node_modules` → 用真 `createRequire` 按包名解析到 manifest、逐个核对 export 指向的文件都在、client 脚本 103,088 字节；把 `./package.json` 从 export 里拿掉后，**子进程**按包名解析立刻回到 `ERR_PACKAGE_PATH_NOT_EXPORTED`（同进程会被 Node 的包映射缓存挡住，所以必须在子进程里问） | `node test/packed-install.test.mjs` |
| 四条 lint 仍然干净 | `style-lint` 0 error；`ui-copy-lint` 0 error（7 warning）；`zh-lint` 0 error（7 warning，都是 `reports/` 里的旧文档） | `node ~/.dsh/tools/style-lint.mjs .; node ~/.dsh/skills/ui-restraint/scripts/ui-copy-lint.mjs .; node ~/.agents/skills/zh-ui-type-lint/scripts/zh-lint.mjs .` |

还没证的：

- **页面自己上报一次之后** `boot` 字段才有值：这次改动把记录搬到 `globalThis`，但页面只在文档启动时 POST 一次，当前这份页面是在改动之前起的，所以 `/state` 里还是 `boot: null`。等下一次页面重建或重开窗口后应出现 `rev`，再用下一次按压核对。
- **Windows 自托管机器的真实安装→插件图→按钮** 还没跑：`dsh-unlag` 仓库在这台 Windows 上还没注册 runner（`gh api repos/regrevia/dsh-unlag/actions/runners` 是 0 个），Linux 三档由 GitHub 托管跑，Windows 那档要等注册后用 `workflow_dispatch` 的 `windows: true` 触发。
