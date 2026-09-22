// DeepSeek Harness 桌面应用 —— Electron 壳
//
// 设计原则：Electron 只负责「壳」。真正的界面与后端仍是 DeepSeek Harness 本身：
//   1. 用本机 Node 运行 @deepseek-ai/dsh 的 `web` profile（与 `dsh web` 完全等价）；
//   2. 用一个原生 BrowserWindow 加载后端在同一套 Web UI（http://127.0.0.1:<port>）。
// 因此界面与功能和浏览器里的 webui 100% 一致，同时 Electron 会把会话/界面状态
// 持久化到 userData 目录，密钥继续复用 ~/.dsh/.credentials.yaml，无需重复登录。
//
// 端口策略：默认使用 3080（与 `dsh web` 一致）。启动前先探测该端口是否已有一个
// harness 在跑：若在，则直接复用它（避免两个后端同时写同一个 ~/.dsh 而损坏会话日志）；
// 若不在，才自己启动一个。端口被非 harness 进程占用时，回退到 --port 0（系统分配）。
//
// 启动流程（v2）：
//   1. 并行执行「联网版本自检」与「后端启动」；版本自检限定短超时，失败按“无更新”处理，
//      绝不让用户明显感到启动变慢。
//   2. 后端就绪 + 版本结果齐备后决策：
//        - 无更新（或自检失败）→ 不显示启动画面，直接进入应用（加载 Web UI）。
//        - 有更新 → 只显示启动画面（「更新后端 / 直接进入应用」），用户选择后才加载 Web UI，
//          避免复用已有后端时启动画面被 Web UI 的加载页抢走。

const { app, BrowserWindow, Menu, dialog, shell, ipcMain } = require('electron');
const { spawn, spawnSync, execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const BACKEND_BIN = path.join(__dirname, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
const DEFAULT_DSH_HOME = path.join(os.homedir(), '.dsh');
const BOOT_TIMEOUT_MS = 90 * 1000;
// 版本自检超时：要求“尽可能快”，超时即视为无更新，直接进入应用。
const VERSION_CHECK_TIMEOUT_MS = 2000;
// 后端未就绪 / 版本未决时，延迟一段时间才显示启动画面，避免快速启动场景下画面闪现。
const BOOT_SPLASH_DELAY_MS = 400;

// 当前打包的 @deepseek-ai/dsh 版本（用于启动画面的“更新后端”对比）。
// 环境变量 DSH_DESKTOP_FAKE_VERSION 可临时覆盖（仅用于测试更新流程）。
const CURRENT_DSH_VERSION = process.env.DSH_DESKTOP_FAKE_VERSION || (() => {
  try {
    return require(path.join(__dirname, 'node_modules', '@deepseek-ai', 'dsh', 'package.json')).version;
  } catch {
    return 'unknown';
  }
})();
const APP_VERSION = (() => {
  try {
    return require(path.join(__dirname, 'package.json')).version;
  } catch {
    return 'unknown';
  }
})();
const GITHUB_RELEASES_URL = 'https://github.com/YaeAyako/DSH-Desktop/releases';

let backendProc = null;
let backendUrl = null;
let backendOrigin = null;
let mainWindow = null;
let bootTimer = null;
let stdoutBuf = '';
let stderrBuf = '';
let logStream = null;
let splashWindow = null;
// v2 启动状态机
let backendReady = false;
let updateResult = null; // { latest?, error? }；null 表示自检未完成
let decided = false;     // 是否已做出“进入应用 / 显示更新画面”的决策
let bootSplashTimer = null;

function log(...parts) {
  const line = `[${new Date().toISOString()}] ${parts.join(' ')}`;
  try {
    if (logStream) logStream.write(line + '\n');
  } catch {}
  console.log(line);
}

// 可选配置文件 dsh-desktop.config.json（与 main.js 同目录）：
//   { "node": "C:\\...\\node.exe", "workspace": "C:\\...", "dshHome": "C:\\...\\.dsh" }
// 三个键都可省略；省略时走默认值 / 环境变量。
function readConfig() {
  const p = path.join(__dirname, 'dsh-desktop.config.json');
  try {
    const raw = fs.readFileSync(p, 'utf8');
    const cfg = JSON.parse(raw);
    return cfg && typeof cfg === 'object' ? cfg : {};
  } catch {
    return {};
  }
}

function resolveNodeBinary() {
  const cfg = readConfig();
  const candidates = [
    process.env.DSH_DESKTOP_NODE,
    cfg.node,
    // 打包后：随包携带的独立 Node（开箱即用，无需用户装 Node）
    path.join(process.resourcesPath, 'node', 'node.exe'),
    // 开发期：项目内 vendor/node
    path.join(__dirname, 'vendor', 'node', 'node.exe'),
    process.env.npm_node_execpath,
  ].filter(Boolean);
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  for (const name of ['node', 'node.exe']) {
    try {
      const out = execFileSync('where.exe', [name], { encoding: 'utf8' });
      const first = out.split(/\r?\n/).map((s) => s.trim()).find(Boolean);
      if (first && fs.existsSync(first)) return first;
    } catch {}
  }
  return 'node';
}

// 定位 npm-cli.js（更新后端用）：
//   - 打包后：extraResources 拷到 resources/npm（不受依赖 prune 影响）；
//   - 开发期：项目内 vendor/node/node_modules/npm。
function resolveNpmCli() {
  const candidates = [
    path.join(process.resourcesPath, 'npm', 'bin', 'npm-cli.js'),
    path.join(__dirname, 'vendor', 'node', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

function resolveWorkspace() {
  const cfg = readConfig();
  const candidates = [process.env.DSH_DESKTOP_WORKSPACE, cfg.workspace].filter(Boolean);
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return os.homedir();
}

function resolveDshHome() {
  const cfg = readConfig();
  return process.env.DSH_HOME || cfg.dshHome || DEFAULT_DSH_HOME;
}

function resolvePort() {
  const cfg = readConfig();
  const raw = process.env.DSH_DESKTOP_PORT ?? cfg.port ?? 3080;
  const p = Number(raw);
  return Number.isInteger(p) && p >= 0 && p <= 65535 ? p : 3080;
}

// 探测某个端口上是否已经有一个 harness 在服务（返回它的 index 且带 __DSH_BOOT__ 注入）。
async function probeHarnessAt(port) {
  if (port === 0) return false;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2500);
    const res = await fetch(`http://127.0.0.1:${port}/`, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) return false;
    const text = await res.text();
    return text.includes('__DSH_BOOT__') || text.includes('DeepSeek Harness');
  } catch {
    return false;
  }
}

function adoptBackend(url) {
  backendUrl = url;
  backendOrigin = new URL(url).origin;
  log('reusing existing backend:', url);
  onBackendReady(url);
}

async function startBackend() {
  if (!fs.existsSync(BACKEND_BIN)) {
    onBackendFailure(
      `找不到后端入口：${BACKEND_BIN}\n请先在项目目录运行 npm install 安装依赖。`
    );
    return;
  }
  const port = resolvePort();
  // 已有后端就复用，绝不重复拉起 —— 两个后端同时写同一个 ~/.dsh 会损坏会话日志。
  if (await probeHarnessAt(port)) {
    adoptBackend(`http://127.0.0.1:${port}`);
    return;
  }
  spawnBackend(port, true);
}

function spawnBackend(port, fallbackOnBind) {
  const nodeBin = resolveNodeBinary();
  const workspace = resolveWorkspace();
  const dshHome = resolveDshHome();
  // --no-open：Web UI 由 Electron 主窗口承载，禁止 dsh web 自动调起默认浏览器。
  const args = [BACKEND_BIN, 'web', '--no-open', '--port', String(port)];

  const env = { ...process.env };
  env.DSH_HOME = dshHome;

  log('node binary :', nodeBin);
  log('backend bin :', BACKEND_BIN);
  log('workspace   :', workspace);
  log('DSH_HOME    :', dshHome);
  log('port        :', port);

  const proc = spawn(nodeBin, args, {
    cwd: workspace,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  backendProc = proc;

  proc.stdout.setEncoding('utf8');
  proc.stderr.setEncoding('utf8');

  proc.stdout.on('data', (chunk) => {
    stdoutBuf += chunk;
    log('[backend]', chunk.trimEnd());
    // 捕获完整 URL：新版 dsh 会输出 http://127.0.0.1:<port>/?token=<进程 token>，
    // 只取到端口会丢掉 token，导致窗口打开后被判定未认证（authentication required）。
    const m = stdoutBuf.match(/dsh web:\s*(http:\/\/127\.0\.0\.1:\d+\S*)/);
    if (m && !backendUrl) {
      backendUrl = m[1];
      backendOrigin = new URL(backendUrl).origin;
      onBackendReady(backendUrl);
    }
  });
  proc.stderr.on('data', (chunk) => {
    stderrBuf += chunk;
    log('[backend:err]', chunk.trimEnd());
  });
  proc.on('error', (err) => {
    if (proc !== backendProc) return;
    onBackendFailure('无法启动后端进程：' + err.message);
  });
  proc.on('exit', (code, signal) => {
    if (proc !== backendProc) return;
    log(`backend exited code=${code} signal=${signal}`);
    if (!backendUrl && code !== null && code !== 0) {
      // 端口被非 harness 进程占用：回退到 --port 0，让系统分配空闲端口。
      if (fallbackOnBind && /EADDRINUSE/i.test(stderrBuf)) {
        log('port in use by a non-harness process; retrying with --port 0');
        backendProc = null;
        stdoutBuf = '';
        stderrBuf = '';
        spawnBackend(0, false);
        return;
      }
      onBackendFailure(
        `后端进程启动失败（退出码 ${code}）。\n\n${stderrBuf.slice(-3000) || stdoutBuf.slice(-3000)}`
      );
    }
    backendProc = null;
  });
}

// v2：后端就绪。设置状态并尝试决策（等版本自检结果齐备）。
function onBackendReady(url) {
  log('backend ready:', url);
  if (bootTimer) {
    clearTimeout(bootTimer);
    bootTimer = null;
  }
  backendReady = true;
  backendUrl = url;
  backendOrigin = new URL(url).origin;
  if (bootSplashTimer) {
    clearTimeout(bootSplashTimer);
    bootSplashTimer = null;
  }
  // 后端已就绪但版本自检还没出结果：延迟显示一个短暂的等待画面（给用户反馈，避免“没反应”），
  // 快速场景（几百 ms 内完成自检）不会闪现。
  if (!updateResult && !decided) {
    bootSplashTimer = setTimeout(() => {
      if (!updateResult && !decided && !splashWindow) showSplash('正在检查更新…');
    }, BOOT_SPLASH_DELAY_MS);
  }
  maybeDecide();
}

// v2：后端就绪 + 版本结果齐备后，一次性决策。
function maybeDecide() {
  if (decided) return;
  if (!backendReady || !updateResult) return;
  decided = true;
  if (bootSplashTimer) {
    clearTimeout(bootSplashTimer);
    bootSplashTimer = null;
  }
  const latest = updateResult.latest;
  const hasUpdate = !!latest && latest !== CURRENT_DSH_VERSION;
  if (hasUpdate) {
    log('update available:', CURRENT_DSH_VERSION, '->', latest);
    // 注意：这里不能先 closeSplash() —— splash 可能是唯一窗口，一关就会触发
    // window-all-closed 导致应用退出。showSplash 会复用现有窗口直接换内容。
    showSplash(`检测到后端新版本 v${latest}\n当前版本 v${CURRENT_DSH_VERSION}`, {
      version: CURRENT_DSH_VERSION,
      withActions: true,
    });
  } else {
    log('no update (or check failed); entering app');
    closeSplash();
    enterApp();
  }
}

// v2：加载 Web UI（只有用户选择“直接进入应用”或“无更新直接进入”时才调用）。
function enterApp() {
  if (!backendUrl) return;
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.loadURL(backendUrl);
  } else {
    createWindow(backendUrl);
  }
}

// 把后端 stderr 里的常见失败翻译成友好提示（如插件缺依赖）；识别不到则返回 null。
function friendlyBackendError(raw) {
  const dep = raw.match(/Cannot find package '([^']+)' imported from ([^\n]+)/);
  if (dep) {
    return `缺少依赖：${dep[1]}\n来源：${dep[2]}\n\n请在该包目录执行：npm install ${dep[1]}\n（自定义插件缺依赖时，需在插件自己的目录安装，只装到应用目录无效）`;
  }
  const entry = raw.match(/failed to import loader entry\s+(\S+)\s*\(([^)]+)\)/);
  if (entry) {
    return `插件加载失败：${entry[1]}（${entry[2]}）\n请检查该插件依赖是否完整，详见下方日志。`;
  }
  return null;
}

function onBackendFailure(message) {
  log('backend failure:', message);
  const friendly = friendlyBackendError(message);
  closeSplash();
  if (mainWindow) mainWindow.destroy();
  const logPath = logStream && logStream.path ? logStream.path : '';
  const body = (friendly ? friendly + '\n\n————————————\n\n' : '') + message + (logPath ? `\n\n完整日志：${logPath}` : '');
  dialog.showErrorBox(
    'DeepSeek Harness 启动失败',
    body
  );
  app.quit();
}

function createWindow(url) {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 900,
    minHeight: 600,
    title: 'DeepSeek Harness',
    backgroundColor: '#0d1117',
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });

  mainWindow.loadURL(url);
  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    closeSplash();
  });
  mainWindow.webContents.on('did-finish-load', () => {
    log('page loaded:', mainWindow.webContents.getURL());
  });
  mainWindow.webContents.on('did-fail-load', (_e, code, desc, failedUrl) => {
    log('page load failed:', code, desc, failedUrl);
  });
  // 可选：设置 DSH_DESKTOP_SCREENSHOT=<png 路径>，页面加载后自动截图，便于验证/调试。
  mainWindow.webContents.on('did-finish-load', async () => {
    const dest = process.env.DSH_DESKTOP_SCREENSHOT;
    if (!dest) return;
    try {
      await new Promise((r) => setTimeout(r, 4000));
      const image = await mainWindow.webContents.capturePage();
      fs.writeFileSync(dest, image.toPNG());
      log('screenshot saved:', dest);
    } catch (e) {
      log('screenshot failed:', e.message);
    }
  });

  // 外部链接一律交给系统浏览器，不在应用内新开窗口。
  mainWindow.webContents.setWindowOpenHandler(({ url: u }) => {
    if (/^https?:/i.test(u)) shell.openExternal(u);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (e, u) => {
    if (backendOrigin && !u.startsWith(backendOrigin)) {
      e.preventDefault();
      if (/^https?:/i.test(u)) shell.openExternal(u);
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// 启动画面：一个无边框小窗口。两种形态：
//   - 等待态（无按钮）：后端启动中 / 版本自检中。
//   - 更新态（有按钮）：「更新后端 / 直接进入应用」。
function splashHtml(msg, opts = {}) {
  const { version = '', withActions = false } = opts;
  const versionLine = version ? `<div class="ver">v${version}</div>` : '';
  const actions = withActions ? `<div class="actions">
<button id="updateBtn">更新后端</button>
<button id="goBtn" class="primary">直接进入应用</button>
</div>` : '';
  const script = withActions ? `<script>
const statusEl = document.getElementById('status');
const updateBtn = document.getElementById('updateBtn');
const goBtn = document.getElementById('goBtn');
updateBtn.addEventListener('click', async () => {
  updateBtn.disabled = true;
  goBtn.disabled = true;
  statusEl.textContent = '正在更新后端…（视网络情况可能需要几分钟）';
  try {
    const r = await window.dshSplash.updateBackend();
    if (r && r.ok) {
      statusEl.innerHTML = '后端已更新：v' + (r.from || '?') + ' → v' + (r.to || '?') + '。<br>请重启应用生效（若浏览器/Web 版 Harness 正在运行，请先关闭它）。';
      updateBtn.textContent = '✓ 更新完成';
      goBtn.disabled = false;
    } else {
      statusEl.textContent = '更新失败：' + ((r && r.error) || '未知错误');
      updateBtn.disabled = false;
      goBtn.disabled = false;
    }
  } catch (err) {
    statusEl.textContent = '更新失败：' + (err && err.message ? err.message : String(err));
    updateBtn.disabled = false;
    goBtn.disabled = false;
  }
});
goBtn.addEventListener('click', () => { window.dshSplash.proceed(); });
</script>` : '';
  return `<!doctype html>
<html><head><meta charset="utf-8"><style>
html,body{margin:0;height:100%;background:#0d1117;color:#e6edf3;font-family:'Segoe UI',system-ui,sans-serif;display:flex;align-items:center;justify-content:center;overflow:hidden;user-select:none;-webkit-app-region:drag;}
.wrap{text-align:center;padding:0 28px;}
.spinner{width:40px;height:40px;border:4px solid #30363d;border-top-color:#4d9fff;border-radius:50%;margin:0 auto 16px;animation:spin .8s linear infinite;}
@keyframes spin{to{transform:rotate(360deg)}}
.title{font-size:16px;font-weight:600;letter-spacing:.4px;}
.msg{margin-top:10px;font-size:12.5px;color:#8b949e;line-height:1.55;white-space:pre-line;}
.ver{margin-top:8px;font-size:11px;color:#6e7681;}
.status{margin-top:8px;font-size:12px;color:#4d9fff;min-height:16px;line-height:1.5;}
.status a{color:#4d9fff;text-decoration:underline;}
.actions{margin-top:16px;display:flex;gap:10px;justify-content:center;-webkit-app-region:no-drag;}
button{font:inherit;font-size:12.5px;padding:7px 18px;border-radius:6px;border:1px solid #30363d;background:#21262d;color:#e6edf3;cursor:pointer;}
button:hover{background:#30363d;}
button.primary{background:#4d9fff;border-color:#4d9fff;color:#0d1117;font-weight:600;}
button.primary:hover{background:#6fb0ff;}
button:disabled{opacity:.5;cursor:default;}
</style></head><body><div class="wrap">
<div class="spinner"></div>
<div class="title">DeepSeek Harness</div>
<div class="msg">${msg}</div>
${versionLine}
<div class="status" id="status"></div>
${actions}
</div>${script}</body></html>`;
}

function showSplash(msg, opts = {}) {
  const { withActions = false } = opts;
  const html = 'data:text/html;charset=utf-8,' + encodeURIComponent(splashHtml(msg, opts));
  if (splashWindow && !splashWindow.isDestroyed()) {
    // 复用已有 splash 窗口（如从「正在启动后端…」切到「检测到新版本」）。
    // 不能“关旧建新”：旧窗口的 closed 事件会把 splashWindow 置 null，
    // 误清新窗口的引用，导致后续 closeSplash() 失效、splash 永远挡在主窗口前。
    try { splashWindow.setSize(400, withActions ? 320 : 230); } catch {}
    splashWindow.loadURL(html);
    splashWindow.once('ready-to-show', () => {
      if (splashWindow && !splashWindow.isVisible()) splashWindow.show();
    });
    return;
  }
  splashWindow = new BrowserWindow({
    width: 400,
    height: withActions ? 320 : 230,
    frame: false,
    resizable: false,
    center: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    backgroundColor: '#0d1117',
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  });
  splashWindow.loadURL(html);
  splashWindow.webContents.setWindowOpenHandler(({ url: u }) => {
    if (/^https?:/i.test(u)) shell.openExternal(u);
    return { action: 'deny' };
  });
  splashWindow.once('ready-to-show', () => { if (splashWindow) splashWindow.show(); });
  splashWindow.on('closed', () => { splashWindow = null; });
}

function closeSplash() {
  if (splashWindow) {
    const w = splashWindow;
    splashWindow = null;
    try { w.close(); } catch {}
  }
}

// 联网版本自检：并行请求多个 registry（官方 + 镜像），**第一个成功即返回**，
// 不被慢/挂起的请求拖累；短超时兜底。失败返回 { error }，由决策逻辑按“无更新”处理，
// 绝不让用户明显感到启动变慢。
async function fetchLatestDshVersion() {
  const urls = [
    'https://registry.npmjs.org/@deepseek-ai/dsh/latest',
    'https://registry.npmmirror.com/@deepseek-ai/dsh/latest',
  ];
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), VERSION_CHECK_TIMEOUT_MS);
  try {
    const tasks = urls.map(async (u) => {
      const res = await fetch(u, { signal: controller.signal });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();
      if (!data || typeof data.version !== 'string') throw new Error('bad payload');
      return data.version;
    });
    return await new Promise((resolve) => {
      let done = false;
      let failed = 0;
      for (const t of tasks) {
        t.then(
          (v) => { if (!done) { done = true; resolve({ latest: v }); } },
          () => { failed += 1; if (failed === tasks.length && !done) { done = true; resolve({ error: 'all registries failed' }); } }
        );
      }
    });
  } catch (e) {
    return { error: e.message };
  } finally {
    clearTimeout(timer);
  }
}

// 查 @deepseek-ai/dsh 指定版本的发布时间（ISO 字符串）；多 registry 并行，第一个成功即返回。
async function fetchDshPublishTime(version) {
  const urls = [
    'https://registry.npmjs.org/@deepseek-ai/dsh',
    'https://registry.npmmirror.com/@deepseek-ai/dsh',
  ];
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const tasks = urls.map(async (u) => {
      const res = await fetch(u, { signal: controller.signal });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();
      const t = data && data.time && data.time[version];
      if (typeof t !== 'string') throw new Error('publish time not found');
      return t;
    });
    return await new Promise((resolve) => {
      let done = false;
      let failed = 0;
      for (const t of tasks) {
        t.then(
          (v) => { if (!done) { done = true; resolve(v); } },
          () => { if (++failed === tasks.length && !done) { done = true; resolve(null); } }
        );
      }
    });
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// v2：启动时快速版本自检（与后端启动并行），结果就绪后参与决策。
async function checkVersionFast() {
  const r = await fetchLatestDshVersion();
  updateResult = r;
  log('version check:', JSON.stringify(r));
  maybeDecide();
}

// —— 更新后端（v3）：等价于 npx @deepseek-ai/dsh 的“完整依赖树”安装 ——
// 旧实现只升级主包 @deepseek-ai/dsh，其余包被 package.json 固定住，导致新主包与旧依赖
// 混装、且缺少新版本引入的包 → 依赖错误、后端启动失败。
// 新实现模仿 npx：备份 → 依赖精简为仅主包 → 删除旧 lockfile → 干净 npm install
// （npm 自动解析并安装主包的完整依赖树，含 peer）→ 校验版本 + 冒烟测试（真的启动一次）
// → 把实际装好的 @deepseek-ai/* 回写 package.json（保证打包收集完整）→ 任一步失败整体回滚。
async function updateBackend(targetVersion) {
  const appDir = __dirname;
  const pkgPath = path.join(appDir, 'package.json');
  const lockPath = path.join(appDir, 'package-lock.json');
  const nmPath = path.join(appDir, 'node_modules');
  const pkgBak = pkgPath + '.update-bak';
  const lockBak = lockPath + '.update-bak';
  const nmBak = path.join(appDir, 'node_modules.update-bak');
  const npmCli = resolveNpmCli();
  if (!npmCli) return { ok: false, error: '未找到 npm（resources/npm 或 vendor/node 中缺少 npm）' };
  const nodeBin = resolveNodeBinary();

  // 目标版本：未指定时联网取最新（多 registry，第一个成功即返回）
  let version = targetVersion;
  if (!version) {
    const r = await fetchLatestDshVersion();
    if (!r.latest) return { ok: false, error: '无法获取最新版本：' + (r.error || '未知错误') };
    version = r.latest;
  }
  log('update backend -> target', version);

  // 运行中的后端会锁住 node_modules 里的文件，先停掉再备份
  stopBackend();
  const restore = () => {
    try {
      if (fs.existsSync(nmBak)) {
        if (fs.existsSync(nmPath)) fs.rmSync(nmPath, { recursive: true, force: true });
        fs.renameSync(nmBak, nmPath);
      }
    } catch (e) { log('rollback node_modules failed:', e.message); }
    try { if (fs.existsSync(pkgBak)) { fs.copyFileSync(pkgBak, pkgPath); fs.rmSync(pkgBak, { force: true }); } } catch {}
    try { if (fs.existsSync(lockBak)) { fs.copyFileSync(lockBak, lockPath); fs.rmSync(lockBak, { force: true }); } } catch {}
  };
  try {
    fs.copyFileSync(pkgPath, pkgBak);
    if (fs.existsSync(lockPath)) fs.copyFileSync(lockPath, lockBak);
    if (fs.existsSync(nmBak)) fs.rmSync(nmBak, { recursive: true, force: true });
    if (fs.existsSync(nmPath)) fs.renameSync(nmPath, nmBak);
  } catch (e) {
    restore();
    return { ok: false, error: '准备更新失败（备份/移走旧依赖）：' + e.message };
  }

  // 依赖精简为仅主包 + 删除旧 lockfile —— 让 npm 干净重算整棵依赖树（避免在旧固定版本
  // 基础上做增量解析，那正是 placeDep 卡死与版本错配的根源）
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  pkg.dependencies = { '@deepseek-ai/dsh': version };
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
  try { if (fs.existsSync(lockPath)) fs.rmSync(lockPath, { force: true }); } catch {}

  // 计算 --before 边界（dsh 发布时间 +1 天）：caret 范围会把依赖拉到“比 dsh 更新、尚未
  // 适配”的版本（例如 cordis 生态在 dsh 发布后隔天发的新版，会让后端启动即崩溃）。
  // 用发布时间做上界，即可得到与 dsh 同时代、经过验证的依赖组合（等价 npx 安装的效果）。
  const pubTime = await fetchDshPublishTime(version);
  const beforeArgs = [];
  if (pubTime) {
    const boundary = new Date(new Date(pubTime).getTime() + 24 * 60 * 60 * 1000).toISOString();
    beforeArgs.push('--before=' + boundary);
    log('update backend: dsh', version, 'published', pubTime, '-> --before', boundary);
  } else {
    log('update backend: publish time unavailable; installing without --before');
  }

  // 干净安装：不带 --legacy-peer-deps，让 npm 自动解析并安装 peer 依赖。
  // 网络韧性：官方源可能 ECONNRESET / SSL 失败，失败后自动切国内镜像重试一次。
  const baseArgs = [npmCli, 'install', '--no-audit', '--no-fund', '--fetch-retries=5', ...beforeArgs];
  let out = await runProcess(nodeBin, baseArgs, appDir, true);
  if (out.code !== 0) {
    log('npm install failed (code=' + out.code + '), retrying with npmmirror registry...');
    out = await runProcess(nodeBin, [...baseArgs, '--registry=https://registry.npmmirror.com'], appDir, true);
  }
  if (out.code !== 0) {
    restore();
    return { ok: false, error: 'npm install 失败（退出码 ' + out.code + '，已回滚）：' + ((out.stderr || out.stdout).slice(-1000) || '') };
  }

  // 校验 1：主包版本是否真的到了目标版本
  const installed = readInstalledDshVersion(appDir);
  if (installed !== version) {
    restore();
    return { ok: false, error: `版本校验失败：期望 ${version}，实际 ${installed || '未知'}（已回滚）` };
  }

  // 校验 2：冒烟测试 —— 真正启动一次后端，确认依赖树完整、能跑起来
  const smoke = await smokeTestBackend();
  if (!smoke.ok) {
    restore();
    return { ok: false, error: '更新后自检失败（后端无法启动），已回滚：\n' + smoke.error };
  }

  // 成功：把实际安装的 @deepseek-ai/* 回写 package.json（打包时 electron-builder 才能收集齐全；
  // 下次更新会重新生成这份清单，无需手工维护）
  const written = writeBackInstalledDeps(appDir, version, pkgPath);
  log('update backend ok:', CURRENT_DSH_VERSION, '->', version, '| deps written:', written);
  try { fs.rmSync(nmBak, { recursive: true, force: true }); } catch {}
  try { fs.rmSync(pkgBak, { force: true }); } catch {}
  try { fs.rmSync(lockBak, { force: true }); } catch {}
  return { ok: true, from: CURRENT_DSH_VERSION, to: version };
}

function readInstalledDshVersion(appDir) {  try {
    return JSON.parse(fs.readFileSync(path.join(appDir, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'), 'utf8')).version;
  } catch {
    return null;
  }
}

// 启动一次后端（--no-open + 端口 0），看到 “dsh web:” 即视为依赖树完整可用。
function smokeTestBackend() {
  return new Promise((resolve) => {
    let settled = false;
    let proc = null;
    const done = (r) => {
      if (settled) return;
      settled = true;
      try {
        if (proc && proc.pid) spawnSync('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { windowsHide: true });
      } catch {}
      resolve(r);
    };
    try {
      proc = spawn(resolveNodeBinary(), [BACKEND_BIN, 'web', '--no-open', '--port', '0'], {
        cwd: resolveWorkspace(),
        env: { ...process.env, DSH_HOME: resolveDshHome() },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (e) {
      return resolve({ ok: false, error: '无法启动自检后端：' + e.message });
    }
    let buf = '';
    let err = '';
    proc.stdout.on('data', (d) => {
      buf += d;
      if (/dsh web:\s*http:\/\/127\.0\.0\.1:\d+/.test(buf)) done({ ok: true });
    });
    proc.stderr.on('data', (d) => { err += d; });
    proc.on('error', (e) => done({ ok: false, error: e.message }));
    proc.on('exit', (code) => done({ ok: false, error: `自检后端退出（code=${code}）\n` + (err || buf).slice(-1500) }));
    setTimeout(() => done({ ok: false, error: '自检超时（90 秒）\n' + (err || buf).slice(-1500) }), 90 * 1000);
  });
}

// 把 node_modules 里实际安装的 @deepseek-ai/* 包（精确版本）写回 package.json。
function writeBackInstalledDeps(appDir, dshVersion, pkgPath) {
  const scopeDir = path.join(appDir, 'node_modules', '@deepseek-ai');
  let names = [];
  try {
    names = fs.readdirSync(scopeDir).filter((n) => fs.existsSync(path.join(scopeDir, n, 'package.json')));
  } catch {}
  const deps = { '@deepseek-ai/dsh': dshVersion };
  for (const n of names.sort()) {
    if (n === 'dsh') continue;
    try {
      const v = JSON.parse(fs.readFileSync(path.join(scopeDir, n, 'package.json'), 'utf8')).version;
      if (v) deps[`@deepseek-ai/${n}`] = v;
    } catch {}
  }
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  pkg.dependencies = deps;
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
  return Object.keys(deps).length;
}

function runProcess(bin, args, cwd, verbose) {
  return new Promise((resolve) => {
    const proc = spawn(bin, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => {
      stdout += d;
      if (verbose) log('[update]', String(d).trimEnd().slice(-600));
    });
    proc.stderr.on('data', (d) => {
      stderr += d;
      if (verbose) log('[update:err]', String(d).trimEnd().slice(-600));
    });
    proc.on('error', (e) => resolve({ code: -1, stdout, stderr: String(e) }));
    proc.on('exit', (code) => resolve({ code, stdout, stderr }));
  });
}

// 启动画面的 IPC：版本自检 / 更新后端 / 直接进入
ipcMain.handle('splash:check-update', async () => {
  const r = await fetchLatestDshVersion();
  return { current: CURRENT_DSH_VERSION, latest: r.latest, error: r.error };
});
ipcMain.handle('splash:update-backend', async () => {
  return await updateBackend();
});
ipcMain.on('splash:proceed', () => {
  closeSplash();
  enterApp();
});

function stopBackend() {
  if (!backendProc) return;
  const pid = backendProc.pid;
  try {
    if (process.platform === 'win32' && pid) {
      // 连同其派生的工具子进程（pwsh/bash 等）一起结束，避免残留孤儿进程。
      spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true });
    } else {
      backendProc.kill('SIGTERM');
    }
  } catch {}
  backendProc = null;
}

// —— 单实例锁：避免重复启动导致多个后端/窗口 ——
// 注意：userData 重定向必须在 requestSingleInstanceLock 之前完成，这样锁按「最终
// userData」计算 —— 便携模式（独立 userData）才能与默认实例共存；而相同 userData
// 的两个实例仍会正确互斥。
if (process.env.DSH_DESKTOP_USERDATA) {
  app.setPath('userData', process.env.DSH_DESKTOP_USERDATA);
}

const gotLock = app.requestSingleInstanceLock();

// 无论主/次实例，都先弹出启动画面，避免「双击后毫无反应」的观感。
app.whenReady().then(async () => {
  if (!gotLock) {
    // 已有实例在运行：在启动画面上提示，短暂停留后自动退出。
    showSplash('应用已在运行\n正在切换到已有窗口…');
    setTimeout(() => app.quit(), 2500);
    return;
  }

  const userData = app.getPath('userData');
  fs.mkdirSync(userData, { recursive: true });
  logStream = fs.createWriteStream(path.join(userData, 'backend.log'), { flags: 'a' });

  // 去掉菜单栏（不显示 Electron 默认的“查看 / 窗口”等菜单）。
  Menu.setApplicationMenu(null);

  log('app version:', APP_VERSION);
  log('dsh version :', CURRENT_DSH_VERSION);

  // v2：并行「版本自检（快速）」+「后端启动」；二者就绪后由 maybeDecide 决策。
  checkVersionFast();
  startBackend();

  // 后端启动 / 版本自检迟迟未完成时，延迟显示一个无按钮的等待画面（避免快速场景闪现）。
  bootSplashTimer = setTimeout(() => {
    if (decided || splashWindow) return;
    if (!backendReady) showSplash('正在启动后端…');
    else if (!updateResult) showSplash('正在检查更新…');
  }, BOOT_SPLASH_DELAY_MS);

  bootTimer = setTimeout(() => {
    if (!backendUrl) {
      onBackendFailure(
        `后端启动超时（${BOOT_TIMEOUT_MS / 1000} 秒）。\n\n${(stdoutBuf + stderrBuf).slice(-3000)}`
      );
    }
  }, BOOT_TIMEOUT_MS);
});

if (gotLock) {
  app.setAppUserModelId('com.deepseek.harness.desktop');

  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}

app.on('window-all-closed', () => {
  stopBackend();
  app.quit();
});

app.on('before-quit', () => {
  stopBackend();
});

app.on('will-quit', () => {
  if (logStream) {
    try {
      logStream.end();
    } catch {}
  }
});
