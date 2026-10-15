# DeepSeek Harness 版本关系与升级指南

> 相关文档：[README（英文）](README.md) · [README（中文）](README-zh.md)

> 适用背景：DeepSeek Harness 目前仍是公测预览版。本项目最后锁定的版本是 **`0.2.0-rc.2`**（更早的 1.0.0 锁定 rc.6，1.1.x 锁定 rc.7，1.2.0 锁定 0.1.5-rc.2）。本文说明官方更新对本项目的影响、如何升级，以及**归档事宜**。

---

## 归档说明（已停止维护）

**本项目已停止维护：仓库冻结在 `v1.2.1`，不再接受功能更新。**

### 一、为什么停止

本项目的核心目标只有一个：**给 DeepSeek Harness 套一个原生桌面窗口**（把 `dsh web` 装进 Electron 壳 —— 免浏览器、免重复登录，界面与官方 Web 端完全一致）。

**官方已在 `0.2.0-rc.2` 推出官方桌面端**（macOS / Windows），且原生具备：

| 官方桌面端能力 | 与本项目的关系 |
|---|---|
| 菜单栏一键**安装/管理 `dsh` 命令**（注册到系统 PATH） | 本项目从未实现 |
| **内置插件管理**（`dsh plugin` 的图形化，含版本兼容检查） | 本项目只能靠 CLI + 系统 pnpm |
| **无需另装 Node 或 pnpm**（运行时一并打包） | 本项目自带 Node 与 npm，但**未内嵌 pnpm** |

即：本项目赖以存在的目标已被官方原生满足，继续维护只是在"锁定版本的离线快照"这一细分价值上重复投入。故决定停止更新。

### 二、最后状态（冻结点）

| 项目 | 值 |
|---|---|
| 最后版本 | **v1.2.1** |
| 锁定后端 | dsh **`0.2.0-rc.2`**（cordis `4.0.4`，**288 个精确版本依赖**） |
| 构建产物 | `DeepSeek-Harness-1.2.1-win-x64.zip`（约 269 MB：自带 Node 运行时 + 完整 npm + 后端与前端产物） |
| 打包验证 | 产物复制到**项目目录之外**独立启动通过（后端就绪、token 认证流程正常、无插件/依赖错误） |
| 仓库内容 | 仅源码（`main.js` / `preload.js` / `package.json` / `build/afterPack.js` / 文档 / 图标）；`node_modules`、`release`、`vendor` 均被 .gitignore 排除 |

### 三、仍然可用的能力（冻结版）

以下能力在 v1.2.1 上可用且经过实测；**只要官方不改动 Web 端的对外接口**，这份快照就能持续使用：

- **桌面窗口运行**：免浏览器、复用 `~/.dsh`（会话与 API Key 不重复登录）
- **快速版本自检**：启动时并行检查官方源与镜像（2 秒超时），无更新则**不显示启动画面、直接进应用**
- **「更新后端」**：npx 式干净重装 + `--before`（dsh 发布时间 +1 天）锁定同时代依赖 + **冒烟自检** + 失败整体回滚 + registry 预探测（自动选可达源）
- **更新后自动重启**应用，无需手动
- **进程 token 认证**（新版 dsh 的 `?token=` 不再丢失）
- **单实例锁 / 复用已有后端**（避免两个后端同时写 `~/.dsh`）

### 四、推荐替代

👉 **请改用官方桌面端：** <https://github.com/deepseek-ai/deepseek-harness>

官方桌面端自带 Node 与 pnpm、可管理插件、可一键安装 `dsh` 命令，能力覆盖并超过本项目。

### 五、如果你想自行接手

本项目 MIT 许可，可自由 fork 继续维护。接手要点：

1. **升级依赖**：按本文"第三节：升级步骤"执行（重点是重新扫描 peer 依赖、隔离验证）
2. **注意 dsh 的破坏性变更**：`0.1.x → 0.2.x` 这类次版本跨越会让**插件的 `^0.1.x` peer 范围失效**，从而被 dsh 的兼容性门禁禁用（可用 `dsh plugin allow-version` 豁免，但有风险）
3. **建议补上的短板**（本项目未做）：
   - 把 **pnpm** 也随包携带（放进 `vendor/`，打包时拷到 `resources/pnpm`）——否则插件管理依赖用户预装 pnpm
   - 加回**菜单栏**入口（安装 `dsh` 命令 / 插件管理），对齐官方交互
4. **打包**：`npm run dist`（产物在 `release/`）

### 六、致谢

- 界面与后端全部来自官方 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)，本项目只提供外壳，未重写任何功能
- 感谢官方在 `0.2.0-rc.2` 提供了更完整的桌面端方案

---

## 一、打包好的 zip 不受官方更新影响

本项目把所有依赖都**锁定在精确版本**（`package.json` 里的 `@deepseek-ai/dsh` 以及全套 `@deepseek-ai/*` 依赖，由发布流程自动生成、无 `^`）。打包时更是把**后端代码 + 前端 UI + Node 运行时 + 完整 npm** 全部拷进了 zip，形成一份完整快照。

因此：

- 已打包好的 `DeepSeek-Harness-1.0.0-win-x64.zip` 是 rc.6 快照，`1.1.x` 系列是 rc.7 快照，`1.2.0` 是 `0.1.5-rc.2` 快照；
- 官方在 npm / GitHub 上以后发布什么版本，**对这份 zip 没有任何影响**；
- 「快速体验」用户下载这份 zip，永远是打包那一刻的版本，稳定不变。

## 二、需要留意的耦合点

这些点不是版本号直接决定，而是应用运行时与外部交互的地方，未来可能受 harness 更新影响：

| # | 耦合点 | 影响 | 触发条件 |
|---|---|---|---|
| 1 | **`~/.dsh` 数据目录** | 会话、API Key、设置都在这里。新版若改了会话日志格式（`SESSION_FORMAT_VERSION`），旧版打开新版会话会拒绝读取（提示"升级 harness"） | 用户**同时**用不同版本的 harness 跑同一个 `~/.dsh` |
| 2 | **DeepSeek 模型 API** | 后端直连 DeepSeek chat-completions API（用你的 API Key）。官方若破坏性改接口，rc.6 适配器可能失效 | 极少数，官方一般会提前通知并保持兼容 |
| 3 | **`dsh web` 命令行与输出格式** | `main.js` 依赖 `--port` 参数、以及后端打印的 `dsh web: http://127.0.0.1:<port>` 这一行来解析端口 | 官方改了参数名或输出格式 |
| 4 | **`__DSH_BOOT__` 注入标记** | 「复用已有后端」的探测靠识别首页 HTML 里的 `__DSH_BOOT__` | 官方改了这个标记名 |
| 5 | **前端 UI 是"冻结"的** | 你的 app 界面就是 rc.6 的 UI。官方出新的 UI/功能不会自动进入你的 app | 需要升级版本并重新打包 |

其中 **#1 最关键**：只要用户不同时混用两个版本的 harness，就没有格式兼容问题。

## 三、升级步骤（可重复执行）

> **自 1.2.0 起，运行时升级已内建**：应用启动画面里的「更新后端」按钮会按下面的逻辑自动完成——停止后端 → 依赖精简 → 删 lockfile → 以 `--before`（dsh 发布时间 +1 天）干净安装 → 版本校验 + 冒烟自检 → 依赖清单回写 → 任一步失败整体回滚（官方源不通时自动切国内镜像）。
> 因此**日常跟随官方更新只需点按钮**；本节的手工步骤用于**重新打包发布新版本**时（与运行时升级同样需要确保依赖树完整）。

每次官方发布新版，按下面步骤操作即可。

### 步骤 1：更新依赖版本号

编辑 `package.json`，把下面这些依赖改成新版（保持**精确版本**，不写 `^`）：

- `@deepseek-ai/dsh`
- `@deepseek-ai/cordis-plugin-group`
- 以及其余 18 个 `@deepseek-ai/dsh-*` 补充依赖

### 步骤 2：重新扫描 peer 依赖（关键）

这 19 个补充依赖是从 rc.6 的依赖树算出来的。**新版很可能增删包**，所以必须重新扫一遍，否则又会遇到"打包缺包、后端启动崩溃"的问题。

**方法 A：对比法（最可靠）**

1. `npm install` 安装新版依赖；
2. 打包一次；
3. 对比「项目 node_modules」与「打包产物 node_modules」，找出"项目有、打包没有"的**运行时**包：

```powershell
# 列出项目 node_modules 与打包 node_modules 的 @deepseek-ai/* 差异
$proj = Get-ChildItem "node_modules\@deepseek-ai" -Directory | Select-Object -ExpandProperty Name
$pkg  = Get-ChildItem "release\win-unpacked\resources\app\node_modules\@deepseek-ai" -Directory | Select-Object -ExpandProperty Name
$proj | Where-Object { $_ -notin $pkg }
```

4. 把列出的缺失包补进 `package.json` 的 `dependencies`（版本号对齐已安装版本）。

> 上面只对比了 `@deepseek-ai/*`。更稳妥是再全量对比顶层包，排除掉 `electron`、`electron-builder`、`@types/*`、`@electron/*` 等明显的开发期包，剩下可能就是漏掉的第三方运行时 peer 依赖。

**方法 B：扫描 peer 依赖**

把下面脚本存成文件运行，可列出所有 `peerDependencies`（已装/未装）：

```js
// peerdeps.cjs
const fs = require('fs'), path = require('path');
const root = path.resolve('node_modules');
const peers = new Map();
function walk(dir) {
  let es; try { es = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of es) {
    if (!e.isDirectory()) continue;
    const p = path.join(dir, e.name), pj = path.join(p, 'package.json');
    if (fs.existsSync(pj)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pj, 'utf8'));
        for (const n of Object.keys(pkg.peerDependencies || {})) {
          if (!peers.has(n)) peers.set(n, new Set());
          peers.get(n).add(pkg.peerDependencies[n]);
        }
      } catch {}
    }
    walk(p);
  }
}
walk(root);
for (const n of [...peers.keys()].sort()) {
  const installed = fs.existsSync(path.join(root, n, 'package.json'));
  console.log((installed ? '已装' : '未装') + '\t' + n + '\t[' + [...peers.get(n)].join(' | ') + ']');
}
```

运行 `node peerdeps.cjs`，把「已装」但可能漏打的包补进 `dependencies`；「未装」的多为可选依赖（如 `bufferutil`、`utf-8-validate`、`@types/*`），一般可忽略。

### 步骤 3：核对几处约定（对照第 2 节 #3、#4）

升级后从新版源码确认这些没变：

- `@deepseek-ai/dsh-web-app` 的 `lib/startup.js` —— 看 `--port` 参数是否仍是这个名字；
- `@deepseek-ai/dsh-web-app` 的 `lib/index.js` —— 看是否仍打印 `dsh web: http://127.0.0.1:<port>`；
- 前端首页是否仍注入 `window.__DSH_BOOT__`（在 `@deepseek-ai/dsh-host-frontend-static` / `dsh-client-modules` 里）。

若某处变了，同步修改 `main.js` 里对应的解析/探测逻辑。

### 步骤 4：隔离验证（必做）

打包后，把 `release\win-unpacked` 复制到**项目目录之外**（例如 `%TEMP%`），直接跑它的后端，确认能自启（这一步确保没有泄漏到项目 node_modules）：

```powershell
$node = "$env:TEMP\iso-win-unpacked\resources\app\vendor\node\node.exe"
$bin  = "$env:TEMP\iso-win-unpacked\resources\app\node_modules\@deepseek-ai\dsh\lib\bin.js"
& $node $bin web --port 43234
```

看到 `dsh web: http://127.0.0.1:43234` 即通过。

### 步骤 5：重新打包与发布

```bash
npm run dist
```

产物在 `release\DeepSeek-Harness-<version>-win-x64.zip`，上传 GitHub Release 即可。

> 小提示：打包前若本地正开着应用（`win-unpacked` 被占用），先完全关闭再打包。

## 四、建议

- **自用 / 小范围分享**：rc.6 足够，不用追版本，现有 zip 一直可用。
- **想持续跟随官方更新**：每次官方发版，按"第三节"走一遍（重点是重新扫 peer 依赖 + 隔离验证）。
- **最省心**：平时只用这个打包好的 app，不要在系统里同时装/跑另一个 harness 实例，即可完全避开 `~/.dsh` 格式兼容问题。

## 五、本项目版本号规范（semver）

本项目自身的版本号（`package.json` 的 `version`，即 zip 文件名里的版本）遵循**语义化版本**，由维护流程自动递增，**无需使用者手动指定**：

| 版本段 | 何时递增 | 示例 |
|---|---|---|
| 主版本 `x.0.0` | 破坏性变更（架构重写、行为不兼容） | `2.0.0` |
| 次版本 `x.y.0` | 新功能（向后兼容） | `1.2.0` |
| 修订版本 `x.y.z` | Bug 修复 / 小改进（向后兼容） | `1.1.2` |

维护规则：每次代码改动后，按改动性质递增对应版本段，**同步更新 `package.json` 与 `package-lock.json` 的根版本**，然后重新打包（zip 文件名自动带上新版本号）。若改动不影响发布产物（如仅文档），可不升版本。

已发布版本记录：

| 版本 | 内容 |
|---|---|
| 1.0.0 | 初版：Electron 壳 + 打包 zip（锁定 dsh rc.6） |
| 1.1.0 | v2 启动流程：无更新不显示启动画面、快速联网版本自检、「更新后端」按钮、随包携带完整 npm（锁定 dsh rc.7） |
| 1.1.2 | 修复：后端启动失败的友好提示（插件缺依赖时直接给出安装命令）；image-recognition 插件将 schemastery 从 peerDependencies 移入 dependencies |
| 1.2.0 | **「更新后端」重构 + 新版 dsh 适配**（锁定 `0.1.5-rc.2`）：<br>· 更新后端改为 npx 式干净重装：依赖精简→删 lockfile→完整安装→版本校验→**冒烟自检**→依赖回写，失败整体回滚<br>· 新增 `--before`（dsh 发布时间 +1 天）锁定"同时代、经验证"的依赖组合，避免 caret 拉到比 dsh 更新、尚未适配的版本<br>· 网络韧性（官方源失败自动切国内镜像）、依赖清单自动生成（不再手工维护）<br>· 新增 `--no-open`：禁止 dsh web 自动调起浏览器<br>· 修复：检测到新版本时误关唯一窗口导致应用退出；splash 窗口复用的竞态；`require` 缓存导致版本号显示错误<br>· 修复：新版 dsh 的进程 token 认证（URL 中的 `?token=` 不再被丢弃） |
| 1.2.1 | **适配 dsh 0.2.0-rc.2 + 更新流程加固**（锁定 `0.2.0-rc.2`）：<br>· 修复 `更新后端` 的 EPERM：不再重命名整个 node_modules（运行中的 electron 会锁住自身映像），改为只移走 `@deepseek-ai` scope<br>· 更新成功后**自动重启应用**（relaunch + quit，退出流程走完再启动新实例，单实例锁自然释放）<br>· 新增 registry 预探测：安装前并行探测官方源/国内镜像并直接使用可达者，避免 npm 在不可达源上长时间重试（实测从卡 5 分钟+降到 52 秒完成）<br>· 已是目标版本时短路（提示「已是最新版本」，不再重装）<br>· 插件兼容：image-recognition 的 peerDependencies 放宽至 `^0.1.0-rc.6 \|\| ^0.2.0-rc.2`（并已核对 `defineTool` 在 0.2.0 仍导出） |

> 注：1.1.1 曾作为 1.1.0 的重打包出现（无内容差异），未发布，故版本记录从 1.1.0 直接到 1.1.2。
