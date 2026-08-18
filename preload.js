// preload.js —— 仅给「启动画面」窗口使用。
// 通过 contextBridge 暴露能力给渲染层：
//   checkUpdate(): Promise<{ current, latest, error }> —— 检查 @deepseek-ai/dsh 最新版本
//   updateBackend(): Promise<{ ok, from?, to?, error? }> —— 把后端更新到最新版本
//   proceed(): 用户点「直接进入应用」，通知主进程关闭启动画面并加载 Web UI
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('dshSplash', {
  checkUpdate: () => ipcRenderer.invoke('splash:check-update'),
  updateBackend: () => ipcRenderer.invoke('splash:update-backend'),
  proceed: () => ipcRenderer.send('splash:proceed'),
});
