<div align="center">

# DeepSeek Harness Desktop

> [English](README.md) · [升级指南](UPGRADE.md)

**在原生桌面窗口中运行 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) —— 界面与行为和它的 Web 应用完全一致，无需打开浏览器，也无需反复登录。**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Electron](https://img.shields.io/badge/Electron-33-47848F?logo=electron&logoColor=white)](https://www.electronjs.org/)
[![Node](https://img.shields.io/badge/Node-%3E%3D22-brightgreen?logo=node.js&logoColor=white)](https://nodejs.org/)
[![Platform](https://img.shields.io/badge/Platform-Windows-0078D6?logo=windows&logoColor=white)]()
[![Built with DeepSeek Harness](https://img.shields.io/badge/Built%20with-DeepSeek%20Harness-4D6BFE)]()

</div>

---

## 为什么

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 自带一个基于浏览器的界面（`dsh web`）。本项目把**同一套**界面装进一个 Electron 窗口，让你能像使用普通桌面应用一样使用它：

- **像素级一致** —— 加载的是官方前端产物，没有重写任何界面。
- **无需浏览器** —— 原生窗口、任务栏/Dock 图标；没有标签页、没有地址栏。
- **无需反复登录** —— 会话和 API Key 都在你已有的 `~/.dsh` 里，跨重启持久保留。

## 工作原理

```
 ┌────────────────────────────────┐
 │            Electron            │
 │  ┌──────────────────────────┐  │
 │  │  BrowserWindow           │  │
 │  │  （官方 Harness 界面）     │◄─┼──── 加载 http://127.0.0.1:<port>
 │  └──────────────────────────┘  │
 └───────────────┬────────────────┘
                 │ 按需 spawn `node`
 ┌───────────────▼────────────────┐
 │  node @deepseek-ai/dsh web     │
 │  （官方后端，端口 3080）         │
 └────────────────────────────────┘
```

Electron 主进程的启动流程：

1. 解析一个 Node 可执行文件；
2. 探测 `127.0.0.1:<port>`（默认 `3080`），如果已经有一个 Harness 在跑就**直接复用它**；
3. 否则在该端口启动 `@deepseek-ai/dsh` 的 `web` profile（若端口被非 Harness 进程占用，则回退到 `--port 0` 由系统分配）；
4. 从后端的 `dsh web: http://127.0.0.1:<port>` 一行解析出实际地址；
5. 在 `BrowserWindow` 中加载该地址。

由于界面和后端就是**浏览器所使用的那套包**，行为天然完全一致。

## 特性

- ✅ **与 `dsh web` 的界面 / 功能 1:1 一致**
- 🚀 **自带后端** —— 替你启动和关闭后端
- 🔐 **无需重新登录** —— 复用 `~/.dsh` 的会话与 `~/.dsh/.credentials.yaml`
- 🧭 **复用已运行的后端** —— 优先连接到已有的 `dsh web`，而不是再起一个（避免两个后端共享 `~/.dsh` 导致会话日志损坏）
- 🪟 **单实例锁** —— 重复启动会聚焦到已有窗口
- 🧹 **干净退出** —— 关闭窗口时一并结束后端及其工具子进程
- 🔗 **外部链接交给系统浏览器打开**
- 📦 **无需构建** —— 前端产物已随 npm 包发布

## 环境要求

- **Node.js ≥ 22**（在 25 上测试通过）—— 后端运行在你的系统 Node 上。
- **Windows**（主要 / 已测试）。外壳也提供 POSIX 关闭路径，但经验证的是 Windows 上的 `taskkill` 清理。

## 安装

```bash
git clone https://github.com/<your-name>/dsh-desktop.git
cd dsh-desktop
npm install
```

## 使用

```bash
npm start
```

在 Windows 上也可以直接双击 **`start.cmd`**（首次运行时若缺少依赖会自动安装）。

## 配置

可选 —— 在 `main.js` 旁边新建 `dsh-desktop.config.json`：

```json
{
  "node": "C:\\Program Files\\nodejs\\node.exe",
  "workspace": "C:\\Users\\you\\Projects",
  "dshHome": "C:\\Users\\you\\.dsh",
  "port": 3080
}
```

| 键 | 默认值 | 含义 |
| --- | --- | --- |
| `node` | 自动从 `PATH` 查找 | 运行后端的 Node 可执行文件 |
| `workspace` | 用户主目录 | 后端的工作目录（即 agent 的 workspace 根目录） |
| `dshHome` | `~/.dsh` | Harness 主目录（会话、凭据、设置） |
| `port` | `3080` | 首选端口 —— 应用会复用该端口上已有的 Harness，或在此启动一个 |

所有键都可省略。对应的环境变量分别是 `DSH_DESKTOP_NODE`、`DSH_DESKTOP_WORKSPACE`、`DSH_DESKTOP_PORT` 和 `DSH_HOME`。

## 调试

- **日志** —— 后端输出写入 `<userData>/backend.log`（通常是 `%APPDATA%\dsh-desktop\backend.log`）。
- **截图** —— 设置 `DSH_DESKTOP_SCREENSHOT=<path.png>` 可在页面加载后自动截图（便于调试 / CI）。
- **便携模式** —— 设置 `DSH_DESKTOP_USERDATA=<dir>` 可重定向 Electron 的 `userData`（localStorage、日志）。

## 常见问题

| 症状 | 处理 |
| --- | --- |
| `找不到后端入口` | 运行 `npm install` —— 依赖尚未安装。 |
| 后端立刻退出 | 查看 `<userData>/backend.log`；确认 `PATH` 里有 Node ≥ 22。 |
| 端口 `3080` 被非 Harness 进程占用 | 应用会自动回退到系统分配的端口。 |

## 全程使用 DeepSeek Harness 构建

本项目**全程使用 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 本身**开发完成 —— 每一个设计决策、代码修改、依赖安装与验证步骤（后端启动测试、Electron 外壳、以及本文档），都由运行在 DeepSeek Harness 内部的 agent 完成。

## 作者

由运行在 DeepSeek Harness 上的 AI 编码 agent —— **deepseek-v4-pro** —— 编写。

## 版本关系与升级

DeepSeek Harness 目前是公测预览版（本项目锁定 `0.1.0-rc.6`）。已打包的 zip 不受官方后续更新影响；如需升级到新版，请按 [UPGRADE.md](UPGRADE.md) 操作（重点是重新扫描 peer 依赖 + 隔离验证）。

## 许可证

[MIT](LICENSE)。DeepSeek Harness 及 `@deepseek-ai/*` 各包版权归其各自所有者所有。

## 免责声明

这是一个非官方的社区封装，与 DeepSeek 无关，亦未获 DeepSeek 背书。
