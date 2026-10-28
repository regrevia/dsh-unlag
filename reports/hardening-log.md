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

## 第三轮：1.13.0 线上的两类投诉（→ 1.13.1）

真机（DSH 桌面 App）上按过一次刷新之后，页面出现「插件已更新，页面未重开：插件刚被换过，再按一次刷新」，
再按还是同一句；后面的「详情」点了没反应。查到三件事，都在 1.13.1 修掉：

1. **那句「再按一次」是错的。** 桌面壳在应用启动时冻结插件清单（`host.start()` 只跑一次，注入列表整进程复用），
   页面重建后按旧的 rev 去要懒加载分块，404 是必然的——从页面代码里没有任何办法换掉冻结的清单。原来这类拒绝
   借用 `generation`（「刚被换过，再按一次」），于是按钮承诺了它做不到的事。现在单独一个理由 `boot`，
   提示写「重启应用后用上新代码」；真正读脚本途中撞上的版本切换仍是 `generation`。
2. **循环的尽头是同一句，不会变成成功，也不会变成崩溃。** 反复按只重复同一条终态判断，不再累积操作、
   不再改页面，也不再给下一次按留下「也许这次能成」的暗示。
3. **「详情」被自己的布局挡住了。** 提示是一行 `nowrap` 的窄条（绝对定位、无层叠顺序），详情是另一个
   绝对定位框（`top: 58`），落在窄条外面、被后面的界面盖住；按下确实执行了，但展开的那块看不见。
   现在提示是一张列布局卡片：句子行（含「详情/收起」）+ 详情块，详情在当前流里展开、有 `zIndex`；
   详情开着时提示不会到点自动消失（收起后重新计时）。另修：绝对定位窄条会按按钮宽度收缩，长句变竖排——
   卡片现在自带宽度 `min(340px, 82vw)`，正常横排换行，文案也缩短。

证据：`test/chunk-availability.test.mjs`（冻结清单的分块 404 判 `blocked`/`boot`）、
`test/button.test.mjs`（重命名懒加载分块判 `boot`）、`test/copy.test.mjs`、
`test/reason-copy.test.mjs`（新增 6 断言：`boot` 文案不许写「再按/再刷新」、必须点名「重启/重开应用」；
`generation` 仍可重按；卡片可换行且有宽度；详情在流内；详情展开时提示不被定时清掉）。

## 第四轮：用户问「这句提示大部分时间看不到吧」（→ 1.13.2）

- 结论先摆清：`boot` 那句不是「unlag 自己更新了才显示」，条件是**这一页的冻结清单已经供不出自己的脚本**，任何插件换过都可能触发；但它只出现在「按下去、重建被拒」的路径上，没人按就永远不出现——用户看不到是实情，不是错觉。
- 真正缺的那一环：冻结清单坏掉时，页面是静默缺插件的。文档已经用旧清单启动，缺的那个脚本 404 发生在页面加载期，按钮还没参与，屏幕上没有任何字。
- 做法：开机报告（`/boot`）时宿主本来就会把清单里每个地址的字节读一遍做快照，`captureBootSnapshot` 现在把「答案是 404 还是读失败」分开记（`code`）；页面启动 1.2 秒后读一次 `/state.bootSnapshot`，**只有数字状态码**才算「这个地址没了」，读失败、清单超长、快照还没写完都不算，一次页面最多问三次。
- 文案与形态：这不是某次刷新的结论，所以不套「插件已更新，页面未重开」前缀，单独一句「缺插件，重启应用后恢复」；页面一直缺，所以这句不受 8 秒自动消失约束，按下一次、拿到新结果后由新结果接替。
- 证据：`test/boot-gaps.test.mjs`（14 条）从源码层钉住「只认错误应答」「不用 complete 标志」「一次页面一次检查」「不被自动清除」「不套更新前缀」；全量 53 个测试文件通过。

## 第五轮：用户问「为什么大部分时候按不了」（→ 1.14.0）

- 先回答事实：按下去不会变成白屏，是**整个应用退出**——重建是导航到同一个地址，桌面壳把启动时冻结的注入脚本再发一遍，其中任何一个地址答 404，壳就 `exit(1)`，连正在跑的会话和终端一起结束。所以「强行刷」等于崩溃加重启，不是一条可选的快路径。
- 也承认按钮为什么老是拒绝：实机日志 `a startup check refused the page: boot (.../client.frontmatter-fields.js?rev=feaa9d72151f answers 404 ...)`。分块是按**插件集合的版本号**要的，模块表却只按**这个插件自己条目那一版**答；插件一换，页面手里的旧编号就 404，检查判「冻结清单供不出脚本」，于是永远「重启应用后用上新代码」。可文件还在，问题只是编号。
- 改法落在两处，说同一句话：路由收到旧编号的分块地址时，按该插件当前的条目版本再要一次（同一份文件，不是替身），200 且非空才答，附 `no-store` 与 `x-dsh-unlag-served-rev/graph-rev/body-sha256`；文件真没了仍把表自己的 404 交回去。按下前的 `verifyStartupRows` 同样：旧地址 404 时先按条目版本读一遍，读出来照常 `ok`，两边都读不出才 `boot` 并点名文件，替补读超时判 `slow`。
- 为什么这不算放宽安全：整份文档早就是这样替补的（`entryRevisionFor`），重建后的文档本来就是新代码，唯一漏掉的是它后面要的分块——那些分块以前必然 404，而 404 正是让应用退出的那一步。替补之后文档与文件来自同一版，反而少了一处跨版本。
- 测试：`test/bundle-shim.test.mjs` 原先钉住「旧分块不重写」，本轮按新决定改成「按条目版本答、文件没了才 404、source map 不当分块、资源形状也答、带 no-store」；`test/chunk-availability.test.mjs` 加 4 条（能读出来就放行并保留 `lazy` 文件名、读不出仍 `boot` 且点名）；全量 53 个测试文件 1273 条通过。

**实机追加（1.14.1）**：这台机器上真实卡住的那一页，旧清单记的 `client.frontmatter-fields.js` 在新版本里已经并进主文档——磁盘上没有、旧版本号答 404、新版本号也答 404。1.14.0 的替补读仍然 404，于是照样拒；但重建后的页面跑的是新主文档（`require.async` 出现 0 次），根本不会问这个文件。所以 1.14.1 加最后一道判断：两道都读不出时，读这个插件当前的主文档，它不再加载这个文件名就放行并记日志；它仍然加载才继续拒。拒绝句也分开，不把「读不到新主文档」说成「文件没了」。

## 第六轮：用户问「还有哪里稳定性、可用性要优化，原理自洽吗，真能缓解卡顿吗」（→ 1.14.2）

- 先钉住一个实机症状：按下后 45 秒没有任何回应，屏幕上连一句「正在刷新」都没有，日志里也没有这一笔——「每一次结果都能被用户核对」当场不成立。改法是三处：按下即写「正在刷新」；45 秒没等到终局就自己收尾并记 `stalled`；导航前只清自己写的那行，不擦别人的话。
- 第二处是可用性里最伤的一种：重建等于「换掉整个文档」，新文档起不来就只剩空白。现在导航前由页面自己请求一次目标地址，200 且带 `__DSH_BOOT__` 才走；答不出来就留在当前页并说明原因。这条把「刷新失败」的上限从「没有页面」压到「这页没动」。
- 第三处是宿主记录的正确性：`unansweredPress` 原来用 `lastPageReportAt > at` 判断「页面报过没有」，同一毫秒内的报告与应答会判反，日志凭空写「the page never said what it did」。改成单调计数器 `pageReportSeq`，按次序比，不按时钟比。`test/press-deadline.test.mjs`（18 条）钉住这三件事，其中「页面报过的按下留给页面」这条正是靠这个计数器才由红转绿。
- 原理自洽的边界，写在这里以免以后被当成已经解决：重建只换渲染进程的文档、JS 堆、React 树、DOM、监听器和页面缓存，宿主进程的会话、正在跑的 turn、终端、事件循环阻塞和内存都不动。所以它对**客户端**卡顿（长会话把 DOM/堆撑大、插件 HMR 越堆越多）有效，对**宿主侧**卡顿（一次大工具调用、终端刷屏、Node 堆涨）无效。审计里还剩几条没落地的：`newer === 'no'` 放行的分块没按「重建后页面真正拿到的那份 body」再核一次（P0）、分块读取到 24 个静默截断而 `/verify` 仍答 ok、9 秒共享预算被逐项扣成 0 后把「没轮到」写成 `slow`、`/boot` 先答 `done` 再冻结快照、队列请求不落地时 `operation.state` 永远停在 `applying`。这些都不影响本轮结论，但「整体自洽」现在还不能说满。
- 证据：`node scripts/test.mjs` → 54 个测试文件、1359 条通过；`npm run audit`、`ui-copy-lint`（0 error）、`style-lint`、`zh-lint` 通过。
## 第七轮：用户问「为什么没办法刷新，保护机制应该只在真没法刷新时出现」（→ 1.14.4）

- 先承认实情：1.14.2 的按下前检查是**全有或全无**——目标地址只要有一次没答成「200 且带启动数据」，就判 `applied:document` 并返回，第二次按还是同一句，屏幕上也不说反了什么。用户看到的正是这个：能刷的时候也刷不了，而且说不清为什么。
- 改成三档判断，不是放宽，是把「不知道」和「确定不行」分开：
  - 页面能读（200 且带 `__DSH_BOOT__`）→ 照常换代码、重建。
  - 应用**确定**说没这一页（`http:4xx/5xx`、`noboot`）→ 仍然不导航。理由是这条不能放宽：导航进一个供不出页面的地址，桌面壳会把冻结的注入脚本再发一遍，其中任何一个 404 就 `exit(1)`，整个应用连同会话一起退出——「刷失败」的上限是崩溃，不是这页没动。
  - 读不到（超时、没有应答）→ 这页保持不动并写清「这次没能确认新页面可用，再按一次仍会重建」；60 秒内再按一次就照说的走，日志记 `unchecked:timeout` / `unchecked:noanswer`。
- `401/403` 单独算一类：`GET` 目标地址被拒是**这次检查没带上会话**，同一来源的页面自己读自己是通的（实机验证：不带 cookie 访问 `http://127.0.0.1:53344/` 直接 401，页面里 `fetch` 却一直是 200）。所以这一类放行并写 `refused:http:401`，不留一句「新页面没准备好」去掩盖真正的会话问题。残余风险写在 CHANGELOG 里：会话真过期时可能落到登录页，而不是停在这一页。
- 附件那道闸门同样不该是墙：原句只让人「先发出去再按」，按多少次都停在原地。现在句子把代价写在明处——「先发出去再按；再按一次会丢掉这些附件」——60 秒内再按一次就带着这个代价重建。写这条时新测试抓到一个真 bug：早期闸门放行后，导航前那次「再看一眼输入框」又把同一批附件当成拒绝，第二次按仍不动；现在这次按的决定（`filesGivenUp`）一直带到最后一道检查。
- 稳定性那一半：重建成功后写 `dsh-unlag:rebuilt`，新文档启动时据此开 15 秒静默窗，窗内再按只回答「刚重建过，页面已经是新的」——一次手动刷新最多产生一次重载，不会按一下就雪崩成连续重载。静默窗只在**启动数据版本没变**时成立（插件代码换过，版本号就变，窗口不生效），所以它不会挡住真正需要的重建。
- 日志写真实原因：`applied:document:http:404`、`:noboot`、`:timeout`、`:noanswer`、`refused:http:401`、`attachments:picker`、`unchecked:timeout`。以后任何一次「按了没成」都能在 `~/.dsh/unlag-reload.log` 里查到是哪一档。
- 证据：新增 `test/reload-unchecked.test.mjs`（18 条：读不到→保留+再按可走、确定没有→两次都不走、401→放行且不写「没准备好」、刚重建→静默）；`test/press.test.mjs` 加 2 条（附件第二次按会重建、日志记 `attachments`）；`test/press-deadline.test.mjs` 的旧块改成「目标地址与当前地址不同」的假服务（它原来用同一个地址，新服务对当前地址照常答 200，测的就不是那个意思了）。全量 `node scripts/test.mjs`：55 个测试文件通过（1312 条 PASS）；`npm run audit`、`ui-copy-lint`（0 error）、`style-lint`、`zh-lint` 通过。
- 没解决的，写在这里：`timeout` 那一档仍然是「未确认就导航」，导航后如果落空，这页会没有任何字（壳已 `exit(1)`）——这是全有或全无换来的代价，换来的是「能刷的时候一定刷得成」。要彻底消掉它，得让壳在启动脚本 404 时不退出，那是宿主侧改动，不在本插件里。

## 第八轮：评审判 1.14.4 有四个发布阻断项（→ 1.14.5）

- 评审结论是「先暂停新增功能，四项作为下一版阻断项」。逐条核对属实，没有一条是误报：
  1. 附件第二次按的同意成了通行证：`prepareInterface({ discardAttachments })` 在附件一项放行后**没有继续**跑焦点提交、别的插件的保存、插件自己的 `dsh-unlag:before` 拒绝和发送检查——为了丢附件，把整轮准备都跳过了。而且「同意」只比对内容签名，换一个会话、换一批同名附件也能复用。
  2. 发送保护漏了官方阶段 `sending`（只认 `adjudicating`/`submitting`），并且最后一次检查发生在 `await askAddress(target)` **之前**：地址检查等待期间开始发送、选文件，页面照样导航。
  3. 一次启动清单可以带多个插件（`plugins/??@local/a,@local/b/client.js`），分块却一律按清单里第一个插件要（`plugins/@local/a/x.js`）：B 的分块可能被 A 的同名文件证明，`/verify` 答 ok，页面起来仍报 `helper.legacyFunction is not a function`；这个问题不按按钮也会出现。
  4. 桌面端正常 HTML 被误判「没有启动数据」：检查只认字面 `__DSH_BOOT__`，而桌面静态 HTML 注入的是 `globalThis.__DSH_BOOT_READY__ = Promise.withResolvers()`，启动数据随后由 `dshDesktopBoot.ready()` 送进来；第一次按被判 `noboot`，第二次才重建。
- 修法按评审要求落在合同层，不去改句子：
  - 附件同意只豁免附件这一项，其余检查照跑；同意绑定到「这一份文档、这个会话、这组附件编号」，签名对不上就重新问。
  - `sendHold()` 认 `sending` 并扫描**所有保留的会话**；地址检查之后加一道同步终检（对话框、发送、附件），这一眼和导航之间没有 `await`，看到变化就停在原地。
  - 分块按「这一行自己的 bundle」要：多插件行把主文件名替换成同 bundle 里的分块文件（`??@local/a,@local/b/x.js`），不再借用任何单个条目的地址；单插件行保持原来的条目地址与旧版本号替补读。读不到就拒绝，拒绝句点名页面真正要的地址。
  - 启动数据两种形状分开认：字面 `__DSH_BOOT__`，或 `__DSH_BOOT_READY__` + `id="root"`（桌面静态 HTML 的启动标记），不再把正常桌面页面拒成 `noboot`。
- 测试转向真实合同：桌面那一条原来和当前地址相同，假宿主走「就是这一页」分支，测的根本不是文档形状——改成另一个地址后才真正走到检查；新增 `sending` 阶段用例（真 `sending` → 不导航，去掉 `sending` → 导航）；新增多插件 bundle 用例：分块必须问 `??@local/a,@local/b/chunk-1.js`，问单条目地址一律不算数，A 的同名文件答 200 也不能让 B 的分块通过。
- 证据：`node scripts/test.mjs` 全量通过（55 个测试文件，1333 条 PASS）；`test/host-verify.test.mjs` 52/52；`test/press.test.mjs` 187 条。`npm run audit`、`ui-copy-lint`、`style-lint`、`zh-lint` 均 0 error。
- 仍未做、也不假装做了的：评审要求的「真实官方启动响应 / 真实 Loader 执行」合同测试还只有本机假表；HMR 取消入队后的复检、agent 工具在自己 HMR 完成前返回、joined `requestId` 重放不重复执行，这三项留到第三批，不在本版。

## 第九轮：用户问「这个做出来吧」——把官方加载器真的跑起来的合同测试（→ 1.14.6）

- 做之前先按 1.14.5 的判决跑了一遍真的应用：`verifyStartupRows` 对一份官方自己渲染出来的正常启动文档答 `blocked/boot`，理由是被它自己点名的地址答 404——也就是说上一版刚修好的「多插件行」在真机上把每一次刷新都挡住了。先抓住这个误拦，再谈合同测试，否则测试只是把一个错答案写成合同。
- 根因不是地址拼错，而是**归属读错**：`lazyChunkFiles(body)` 把一整行（可含 14 个插件）当成一个 owner，又把分块地址拼成 `plugins/??…`。官方 `client-modules` 运行时的 `chunkUrl(row, fileName, rev)` 是：取该模块自己那条 row 的 url，截掉 `/??` 之后的部分，再拼 `${行首}/${moduleId}/${fileName}?${rev 段}`——线上每个分块都落在**发起 `require.async` 的那个模块**自己的 `plugins/<id>/<file>?rev=<该插件当前版本>`，组合地址只用于主文档，不用于分块。本机实测：9 MB 那条启动清单里的四个懒加载文件分别归 `dsh-client-ui-sidebar-documentpreview`（`client.frontmatter-fields.js`、`client.pdf.js`、`client.excel.js`，rev `1ba5c4b0fcaa`）与 `dsh-client-ui-sidebar-terminal`（`client.terminal.js`，rev `efba91a5f17e`）；按各自地址读 200，按 `??` 组合地址读 404。
- 修法：`lazyChunksByOwner(body)` 按 `__ModuleLoader__.load({ id: … })` 把一行切成各模块自己的段，`require.async` 归到它所在段的模块；段外、且整行只有一个模块时仍归这个模块，一行有多个模块又找不到归属就不猜地址（交给 entries/register 两步报）。地址一律走 `chunkAddress(entry.url, ownerId, file)`，用 owner 的条目版本；删掉 `chunkAddressFor` 与那套组合地址分支。真机复跑：同一份文档由 `blocked/boot` 变成 `ok`，并按加载器自己会问的四条地址各读一次，全 200。
- 合同测试 `scripts/loader-contract.mjs`（不进 `npm test`，需要本机应用和浏览器）：一次性 `HOME` 起真的 `dsh web`（`--profile web --no-open --port 0`），读应用自己渲染的启动文档，取其中真实的 `__DSH_BOOT__` 与三条启动行，先让 `verifyStartupRows` 对真地址判一次；再用真 Chromium（Playwright 自带 chromium，`--use-mock-keychain`）走 CDP 跑官方加载器：`Fetch.fulfillRequest` 把指定的那一行改成 404、或换成本文档里另一条启动行的正文，并 `Network.setCacheDisabled` 防止第二次导航吃到缓存。三份场景逐条对判决：
  - 原样送达：检查 `ok`，加载器的页面有输入框、没有 `Failed to load plugins`、没有 `client-modules:` 报错。
  - 把加载器自己的启动包（`plugins/??@deepseek-ai/dsh-client-modules/client.js`）改成 404：检查 `blocked/missing` 且点名这个地址；页面只剩 `HARNESS` 与 `Failed to load plugins`，控制台是 `client-modules: HTML did not preload …`，没有任何应用界面。
  - 把 shell 那条启动包换成本文档里 client-modules 那条的正文：检查 `blocked`；加载器自己报 `client-modules: duplicate factory registration`。这一档要老实说：界面**可能照常画出来**（这次实测输入框在），所以判据只能是加载器自己的拒绝，不能等像素——这也正是检查必须在导航前拒绝、而不是「重开再说」的理由。
  - 有一次换的是最末那条启动包，界面仍完整启动：那条只带晚加载的面板，换掉它不影响启动。换成 shell 那条才复现「另一代正文」的错误，测试按后者写。
- 证据：`node scripts/loader-contract.mjs` 退出码 0，19/19 通过，输出三行对照（`served: ok · loader booted · composer true` / `missing: blocked/missing · loader failed` / `replaced: blocked/network · loader booted`），并打印当次 `revision`、启动行数、条目数。`test/host-verify.test.mjs` 改成新语义后 54/54（多插件行必须问发起模块自己的地址、绝不问 `??` 组合地址、同名文件不得替另一个插件作答、一行里第二个插件按它自己的版本问）。全量 `node scripts/test.mjs` 通过；`npm run audit`、`ui-copy-lint`、`style-lint`、`zh-lint` 0 error。
- 没做的、也不假装做了的：`legacyFunction` 那条症状收回——装好的 0.2.1 构建里 0 处匹配，1.14.5 CHANGELOG 里那句是按调用顺序推的样例，不是实测；1.14.6 起这条规则的依据换成加载器源码与实测地址。真实 Electron 桌面端重装后的表现仍未验（不重启应用、不刷新页面）；HMR 三项仍在第三批；版本号固定的回放夹具（sha256 + 抓取脚本）留作后续。

## 第十轮：用户报「现在又刷不了了」——`mixed` 误拦（→ 1.14.7）

- 现象：升级到 1.14.6 后每一次按都答「插件更新过，页面留在原样：下一张页面会混着新旧两代插件代码，先重开应用」，日志里每次按三行同一条 `a startup check refused the page: mixed (… answers at ed58424113bd, while the script it belongs to answers at d13c73eba3a5)`，再一行 `rebuild held back: applied then blocked then mixed`。也就是插件代码已经换好、页面却再也重建不了。
- 先看它凭什么判：`mixed` 由 `mixesGenerations(mainRev, chunkRev, revisionAtStart)` 给出，条件只是「两串版本号不等、且都不等于整张表的 `graph.rev`」。而 `mainRev` 在「清单点名的地址已经 404、改由当前这一版作答」这条路上取的是 `currentBundleAnswer` 给的 `servedRev = revisionInUrl(target)`，target 是**某个组合行/某个插件条目**的地址；`chunkRev` 是分块地址里的版本，分块按**发起 `require.async` 的那个模块自己**那条 row 的版本问。同一代里组合行版本、条目版本各成一套（实测组合行 `bf456991cccd,023852472753,f2afdf945d25`，条目版本另一组，`graph.rev` 又是第三组），所以只要走了替补，这两串必然不等——**判据本身把「同一代」写成了「两代」**。1.14.5 之前没有这条比较（当时只查可读性），所以那时能刷。
- 修法：不再比较跨命名空间的版本号，改看这份主脚本的字节从哪来。`readStartupScript` 原样答回时给响应打 `servedFromAsked: true`，替补答回时打 `false`；`verifyStartupRows` 由此得到 `mainStale`——**只有原样答回的字节才算旧侧**，且要再确认这个地址的版本已经不是当前清单认的那一版（新增 `staleBundleAddress`，判法与路由替换前问的 `currentBundleUrls` 成员判断同一套，检查与路由对「旧地址」的定义因此一致）。替补答回的正文按构造是当前代，不参与比较，`mixed` 只在「原样旧字节 + 当前分块」时成立，拒绝句仍点名地址与两个版本号。
- 回归证据（先红后绿）：新加的两条单测在 1.14.6 的 `index.js` 上直接退 1，`58/60 passed`，失败句与线上同形（`answers at entry-new, while the script it belongs to answers at batch-new`）；在新 `index.js` 上 `60/60`、退出码 0。合同测试 `node scripts/loader-contract.mjs` 加一档真应用用例（把真启动清单的版本号全换成应用不再认的版本，模拟页面停在上一代冻结清单，走 `verifyStartup` → `readStartupScript` 真 404 + 真替补 200）：拿 1.14.6 的 `index.js` 跑这档会拒，`20/21 passed`，失败句 `…/client.frontmatter-fields.js?rev=8c8f845b736f answers at 8c8f845b736f, while the script it belongs to answers at abfb834e563c`（两串都属当前这一代，只是来自两套命名空间）；新代码 `21/21`，另两档（原样送达 `ok`、缺加载器包 `blocked/missing`）不变。
- 线上同时验了：本机 `~/.dsh/unlag-reload.log` 里最后一次 `refused the page: mixed` 在 10:03:08（三行同一条 + `rebuild held back: applied then blocked then mixed`）；修好的代码在 10:09 那次按压里被换上后，10:09–10:18 的六次按压没有一次被拒，10:16:28 新页面带着 `dsh-unlag 1.14.6 loaded (code 10:14:55.912Z)` 重新上线——「该刷时能刷」在这台机器上是实测结果，不是推断。
- 顺带修掉测试自己的说明力漏洞：`test/host-verify.test.mjs` 的汇总原先写在文件中间，末尾追加的 6 条判失败也不影响退出码（日志里照样 `60/60 passed`）。汇总移到末尾重算，回退版 `index.js` 现在会真正退 1。
- 证据：`test/host-verify.test.mjs` 60/60；`node scripts/loader-contract.mjs` 21/21 退出码 0；`node scripts/test.mjs` 全量通过；`npm run audit`、`ui-copy-lint`、`style-lint`、`zh-lint` 0 error。
- 没做的、也不假装做了的：线上那次按下的日志只能证明「判据把同一代读成两代」，不能证明宿主对旧地址一定 404（若宿主仍原样答旧字节，新判据会照旧拒绝，这正是保留的那一档真阳性）；真实 Electron 桌面端重装后的表现仍未验（不重启应用、不刷新页面）；HMR 三项仍在第三批。

## 第十一轮：外部评审判 1.14.7「主流程变好、稳定性没收敛」（→ 1.14.8）

- 评审的判决语被当成验收标准：「该刷时能刷，不能刷时明确保留当前页面，每一次结果都能被用户核对」；同时要求这一轮不再加刷新模式或自动化入口——本版一个都没加。
- 第一批四项逐条核对，全部属实：
  1. 分块身份写成了 `Map<fileName, ownerId>`，一行里两个插件有同名文件时，B 的分块会被 A 的地址「已经读过」顶掉，判 `ok` 实则缺件。改成 `(owner, fileName)` 对，按完整分块地址去重，两个 owner 各自问、各算一次读取预算；`freezeStartup` 行里仍只记文件名（与冻结清单交叉核对 `frozenChunks` 用的是名字），只有逐地址核验才用 owner 对。
  2. 保存协议的缺口：地址检查是网络等待，最长数秒，而它是**在**准备流程（提交焦点、让别的插件保存）之后跑的，这一等里新输入的字和插件触发的保存都没人再看一眼。改成先问地址（只读网络），过了再进保存循环，用草稿指纹（每会话 `draftRev|draft|附件数`）判断「保存的是不是当前这一版」，两轮仍在变就判 `unsaved` 保住页面。
  3. 旧宿主兼容回归：1.14.4 拦「有文字没回到输入框的失败消息」，1.14.7 的条件写成「记录里有附件就不看文字」，于是一起带过附件的失败消息被放行。改成文字、附件分开判；纯附件才进「再按一次丢掉」的确认。`test/press.test.mjs` 里原先把旧优先级钉死的那条按新合同改写，并补一条纯附件对照，两个方向都有断言。
  4. 合同测试假阴性：`verdict({...})` 漏传 `blocked`，`blocked !== null` 对 `undefined` 为真，`undefined.startsWith()` 抛错被外层 catch 成 `{reason:'network'}`——「换正文必须被拒」这条其实是测试自己崩了，而传 `blocked: null` 的对照会 `ok`。修在判据函数（`matchRow`/`chooseStandIn`，缺省 null + 类型守卫），错误正文档加「非 network + 正文不含 startsWith/Cannot read + 替换分支确实被访问」三条断言，再加一条同正文健康对照必须 `ok`。红证据：HEAD 版 `verdict` 对同一输入答 `{"status":"blocked","reason":"network","detail":"...Cannot read properties of undefined (reading 'startsWith')"}`、`answered: []`。新 `test/loader-contract-selftest.test.mjs`（`--self-check` 5/5）进 `npm test`；真应用 25/25，`replaced: blocked/register`。
- 顺带收掉评审列在第二批、但和本批同一条调用链的两项（不新增开关，只改已有路径的收尾）：45 秒超时后 `pressInFlight` 还压着 ~7 秒，再按只说「还在应用」——现在按下记 `{requestId, operationId, stalled}`，超时只标 `stalled`，下一次按拿这次更新的 operation/请求名去问真实终态并按终态说话，`pressInFlight` 只在 finally 清；附件签名并入 `File` 对象编号，同名同大小换文件会重新问，放弃授权仍只认上一次问过的那组。
- 团队分工与写范围：Lead 改 `index.js` 与两份宿主测试（分块身份、`newerLoadsFile`、逐地址核验）；`client-gates` 只改 `client.js` 与 `test/client-gates.test.mjs`（A1–A4）；`contract-check` 只改 `scripts/loader-contract.mjs` 与新增的 `test/loader-contract-selftest.test.mjs`。评审要求的「每加一个拒绝条件就带一条相邻的通过场景」按此落在各自测试文件里。
- 证据：`node scripts/test.mjs` → 57 个测试文件全过（新增 `test/client-gates.test.mjs` 12 条、`test/loader-contract-selftest.test.mjs` 4 条）；分块修复先红后绿：1.14.7 的 `index.js` 跑新用例退 5 条（含 `a same-named chunk missing under the second owner holds the press` → `{"status":"ok"}`），修好后全过；`node scripts/loader-contract.mjs --self-check` 5/5 且不启应用；真应用合同测试 25/25；`npm run audit`、`ui-copy-lint`（0 error / 7 warn，与基线同）、`zh-lint`（0 error / 3 warn，与基线同）、`style-lint` 通过；`node --check index.js client.js scripts/loader-contract.mjs` 均 ok；用户可见文案字面零改动（`ui-copy-ignore` 131 → 131）。
- 没有做的、也不假装做了的：评审 P2 的三项（同一批里别的插件改版导致字节相同仍可能 `mixed` 误判、附件授权 1 分钟时限、HMR 三项）本版未动；合同测试仍不在 CI（脚本是 top-level CLI，已把命令体收进 `runAsCommand` 守卫的 `main()`，导入不再启动应用，`--self-check` 可在 CI 跑，但真实 App/Chromium 那一层仍需本机）；**真实 Electron 桌面端验收**（`dsh-app://`、IPC 启动清单、真按钮重建、失败恢复、消息/任务保留）仍没有记录，本版只做到本机 `dsh web` 合同测试；桌面端每版至少一条验收记录这条门禁仍未建立。
