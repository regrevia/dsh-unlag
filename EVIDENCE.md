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
```

演练输出里的每一项含义见 README「改完后让运行中的 App 用上」。

## 还没证到的两件事

- **人手按下的那一下**：只有人按才会真的换插件代码，这台机器上最后一次真按是 1.9.30。`pressPath.ready` 证明的是「此刻按下去会被接受」，不是「按过了」。
- **日志轮转在真实 App 里发生**：真实日志还不到上限的一半，轮转只有离线测试（`log-cap.test.mjs`）证过，没在现场触发过。
