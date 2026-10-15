# dsh-mole-tool

DeepSeek Harness 插件：把 [Mole](https://github.com/tw93/Mole)（`mo`）命令行接成 agent 工具 + 设置面板。

## 为什么是 CLI 而不是付费 App

Mole 有两个东西，只有一个是收费的：

| | 许可 | 说明 |
| --- | --- | --- |
| **CLI `mo`** | GPL-3.0，**免费** | Windows 在 [`windows` 分支](https://github.com/tw93/Mole/tree/windows)，Scoop main bucket 有 |
| **原生 App** | $15.20 买断 | mole.fit 上的 C# 图形程序，与本插件无关 |

本插件**只驱动免费的 CLI**，以外部进程方式调用，不 vendor、不复制、不链接 Mole 源码，所以 GPL 对本插件不产生任何义务。

## 安装

```powershell
scoop install mole          # 或参考上游 README 用脚本安装
dsh plugin --profile desktop add E:\GitHubWorkspace\own\opensource\dsh-mole-tool
```

装完重启桌面端。

## 能力与边界

插件的设计由**实测**的 Mole 行为决定，不是猜测。三条关键事实：

### 1. `mo clean` 没有任何确认提示，且永久删除

`uninstall` 和 `purge` 结尾都有 `Read-Host "Continue? (y/N)"`，但 `clean` **没有** —— 扫描完直接删，而且不进回收站（只有 `mo analyze` 走回收站）。

因此：

- `mole_clean` **默认只预览**，必须显式传 `execute: true` 才真删；
- 真删前会经 DSH 审批通道向用户确认，**失败即关闭**（没有审批者就不删）；
- 只有 `allowed-once` 算授权，`rejected` / `cancelled` / `unavailable` 一律不删。

### 2. `uninstall` 和 `analyze` 是纯 TUI，agent 驱动不了

两者都用 `[Console]::ReadKey` / bubbletea 画全屏界面。重定向 stdio 后**不会**退化成可脚本模式：

- `mo uninstall --dry-run` 实测报错：`使用"1"个参数调用"ReadKey"时发生异常: 应用程序没有控制台…无法读取输入`
- `mo analyze` 会一直画界面，永不返回

所以这两个不做自动化：`mole_uninstall` / `mole_analyze` 在**独立终端窗口**里为用户打开，工具如实说明这一点。

`uninstall` 里对 agent 有用的那半 —— "装了什么、占多大" —— 通过读它自己维护的清单缓存 `~/.cache/mole/app_scan_cache_v3.json` 提供（`mole_inventory`）。

### 3. `mo` 的输出是 GBK，不是 UTF-8

`mo.exe` 转发给 `mole.ps1`，由 Windows PowerShell 执行，写出的是**控制台代码页**。在 zh-CN 机器上就是 GBK：按 UTF-8 解码会得到 `ʹ�á�1��������`。

本机实测 `[Console]::OutputEncoding = UTF8` **无效** —— WDAC 策略把 PowerShell 锁在 ConstrainedLanguage，赋值被拒。所以按 GBK 解码，Node 的 `TextDecoder('gbk')` 可用（full-ICU）。

副作用：`➤`（U+27A4）在 GBK 里没有映射，PowerShell 输出字面 `?`。**解析器因此完全不依赖图标**，改用缩进结构判定分类与条目。

## 工具

| 工具 | 作用 | 安全性 |
| --- | --- | --- |
| `mole_status` | CPU/内存/磁盘/网络/电池/进程快照 | 只读 |
| `mole_clean_preview` | 清理预览：可回收总量 + 分类明细 + 导出路径 | 只读 |
| `mole_clean` | 执行清理 | **默认预览**；`execute: true` 走审批 |
| `mole_optimize_preview` | 维护报告（DNS/图标缓存/磁盘健康/启动项） | 只读 |
| `mole_purge_preview` | 构建产物清理预览 | 只读 |
| `mole_inventory` | 已安装应用清单（含体积） | 只读 |
| `mole_uninstall` | 打开交互式卸载器 | 用户操作 |
| `mole_analyze` | 打开交互式磁盘分析器 | 用户操作 |
| `mole_info` | 安装状态、可执行文件路径、编码 | 只读 |

`optimize` 只提供预览：真实执行会改系统状态，且提权后会阻塞在 `Read-Host` 询问 SCF。

## Web 面板

设置 → 插件 → **Mole 清理**，五个卡片：

- **系统状态** —— 健康分、CPU、内存、磁盘条
- **清理预览** —— 一键扫描，分类明细
- **已安装应用** —— 体积降序
- **交互工具** —— 打开卸载器 / 磁盘分析器
- **安装信息** —— 可执行文件路径、解析方式、编码

面板**没有任何会删文件的动作**（有测试守着）。删除只能经 `mole_clean` 工具 + 审批。

面板经插件自己的同源路由 `/plugins/dsh-mole-tool/rpc` 读数据，做同源校验、方法校验与体积上限。

## 配置

`cordis.patch.yml` 里可选：

```yaml
- insert:
    - id: mole-tool
      name: '@local/dsh-mole-tool'
      config:
        molePath: C:/Users/me/scoop/shims/mo.exe   # 省略则自动探测
        outputEncoding: gbk                         # 代码页已是 UTF-8 时改 utf-8
        timeoutMs: 120000
```

省略 `molePath` 时会探测 Scoop shim、脚本安装目录与 PATH（本机实测可自动找到）。

## 测试

```bash
node test-harness.mjs
```

32 项检查，跑真实 `mo`，无需 DSH 进程。重点覆盖**失败即关闭**：无审批通道、审批被拒、审批抛异常，三条路径都必须不删文件。

## 结构

```
dsh-mole-tool/
├── entry.js              # 缓存击穿入口（Node 按 URL 缓存 ESM）
├── index.js              # 插件入口：工具注册 + 面板路由 + 审批接线
├── client.js             # 浏览器侧设置面板
├── lib/
│   ├── mole.js           # 进程层：探测、解码、解析、交互窗口
│   ├── service.js        # 服务层：工具与面板共用同一份操作
│   └── tools.js          # 9 个 agent 工具定义
├── locale/{en,zh}.json   # 插件卡片文案
├── icon.svg
└── test-harness.mjs
```

`entry.js` 的存在是因为 Node 按解析后的 URL 永久缓存 ES 模块，而本插件源码在 profile 之外、不在 HMR 监视范围内。它用 `?t=<timestamp>` 强制每次激活重新导入，所以改完 `index.js` 或 `lib/*.js` 切换插件开关即可生效，无需重启。

`index.js` 用普通 JS 校验配置而非 schemastery：插件是从 `E:` 符号链接进 profile 的，Node 会把符号链接解析到真实路径，`@deepseek-ai/schemastery` 这类裸导入会 `ERR_MODULE_NOT_FOUND`。参考实现 `dsh-gitbash-tool` 出于同样原因也是这么做的。
