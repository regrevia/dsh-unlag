# DSH 插件在 Windows 上的验收

一个 DSH 插件的跨平台验证分三层，复用成本完全不同。仓库里每一层都有可直接抄的现成件。

| 层 | 验的是什么 | 谁能复用 | 成本 |
| --- | --- | --- | --- |
| 一、仓库套件 | 插件代码在 Windows 的 Node 上跑不跑得动：路径分隔符、`spawn` 的 `.cmd` 规则、大小写敏感、换行、权限 | 任何插件 | 零，GitHub 托管机 |
| 二、真运行时 | 真 Host + 真 Chromium 加载插件 bundle，页面真的起来 | 装了 DSH 桌面端的 Windows 机器，装一次所有插件共用 | 一台机器 + 一次安装 |
| 三、壳里真按钮 | `dsh-app://` 页面里按下按钮、启动清单与 IPC 注入 | 目前谁都不行 | 等上游给调试入口 |

## 一、仓库套件

托管机就够，30 行 YAML：

```yaml
- uses: actions/checkout@v4
- uses: actions/setup-node@v4
  with:
    node-version: ${{ matrix.node }}
- run: npm install --no-audit --no-fund
- run: npm test
```

矩阵取 `[20, 22, 24]`。这层挡的是「只在 macOS 上开发、路径写死、`spawn('dsh')` 在 Windows 上 EINVAL」这类问题——本插件就是被它挡下来的。

## 二、真运行时

一台 Windows 机器上装好官方桌面端之后，运行时固定在
`%LOCALAPPDATA%\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh`，
探针会自己找到它，**该机器上所有 DSH 插件共用这一份**，不需要每个项目装一次。

复制三个文件过去（纯 Node、无第三方依赖）：

- `scripts/lib/desktop-paths.mjs` —— 按平台找 App、运行时、可用 Chromium，环境变量可覆盖
- `scripts/desktop-e2e.mjs` —— 探针，只报结果不判失败
- `scripts/loader-contract.mjs` —— 起真 Host、真 Chromium，断言插件 bundle 被服务、页面 boot 出界面；断言部分按自己插件改

机器侧要求：Node ≥ 20、Chrome 或 Edge、已安装桌面端。**不要用 `npm i -g @deepseek-ai/dsh`**：公开包里依赖私有包 `@deepseek-ai/dsh-desktop-host`，装出来的壳启动会静默退出。

自托管 runner 两种复用方式：注册到自己的仓库；或由机器主人建成组织级 runner group，多仓库按组引用。

## 三、壳里真按钮

打包的 Electron 启动器不接受 `--remote-debugging-port`（`bad option`），没有 CDP 或任何受支持的自动化入口，启动清单冻结和 boot 注入都在壳进程内部。所以「在 `dsh-app://` 里真的点一下刷新」目前只能人手按一次，换任何插件都一样。这是跨项目共同的阻塞点，不是单个插件的欠账。

## 现成模板

`templates/plugin-windows-desktop-ci.yml`：托管矩阵 + 自托管真运行时两步都在里面，改 `runs-on` 标签即可。
