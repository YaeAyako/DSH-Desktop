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

const { app, BrowserWindow, Menu, dialog, shell } = require('electron');
const { spawn, spawnSync, execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const BACKEND_BIN = path.join(__dirname, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
const DEFAULT_DSH_HOME = path.join(os.homedir(), '.dsh');
const BOOT_TIMEOUT_MS = 90 * 1000;

let backendProc = null;
let backendUrl = null;
let backendOrigin = null;
let mainWindow = null;
let bootTimer = null;
let stdoutBuf = '';
let stderrBuf = '';
let logStream = null;
let splashWindow = null;

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
    // 打包后：extraResources 里随包携带的独立 Node（开箱即用，无需用户装 Node）
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
  const args = [BACKEND_BIN, 'web', '--port', String(port)];

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
    const m = stdoutBuf.match(/dsh web:\s*(http:\/\/127\.0\.0\.1:\d+)/);
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

function onBackendReady(url) {
  log('backend ready:', url);
  if (bootTimer) {
    clearTimeout(bootTimer);
    bootTimer = null;
  }
  if (mainWindow) {
    mainWindow.loadURL(url);
  } else {
    createWindow(url);
  }
}

function onBackendFailure(message) {
  log('backend failure:', message);
  closeSplash();
  if (mainWindow) mainWindow.destroy();
  const logPath = logStream && logStream.path ? logStream.path : '';
  dialog.showErrorBox(
    'DeepSeek Harness 启动失败',
    message + (logPath ? `\n\n完整日志：${logPath}` : '')
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

// 启动画面：一个无边框小窗口，显示加载动画与状态文字。
function splashHtml(msg) {
  return `<!doctype html>
<html><head><meta charset="utf-8"><style>
html,body{margin:0;height:100%;background:#0d1117;color:#e6edf3;font-family:'Segoe UI',system-ui,sans-serif;display:flex;align-items:center;justify-content:center;overflow:hidden;user-select:none;-webkit-app-region:drag;}
.wrap{text-align:center;padding:0 28px;}
.spinner{width:40px;height:40px;border:4px solid #30363d;border-top-color:#4d9fff;border-radius:50%;margin:0 auto 18px;animation:spin .8s linear infinite;}
@keyframes spin{to{transform:rotate(360deg)}}
.title{font-size:16px;font-weight:600;letter-spacing:.4px;}
.msg{margin-top:12px;font-size:12.5px;color:#8b949e;line-height:1.55;white-space:pre-line;}
</style></head><body><div class="wrap">
<div class="spinner"></div>
<div class="title">DeepSeek Harness</div>
<div class="msg">${msg}</div>
</div></body></html>`;
}

function showSplash(msg) {
  if (splashWindow) return;
  splashWindow = new BrowserWindow({
    width: 380,
    height: 230,
    frame: false,
    resizable: false,
    center: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    backgroundColor: '#0d1117',
    show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  splashWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(splashHtml(msg)));
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

  showSplash('正在启动后端…');
  await startBackend();

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
