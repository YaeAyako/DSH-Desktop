// afterPack 钩子：electron-builder 在组装 win-unpacked 后调用。
// 把 vendor/node 里随包携带的完整 npm（含 node_modules 依赖树）拷到
// resources/npm —— extraResources 会过滤 node_modules，这里绕开该处理。
const fs = require('fs');
const path = require('path');

exports.default = async function (context) {
  const projectDir = context.packager.info.projectDir;
  const appOutDir = context.appOutDir;
  const src = path.join(projectDir, 'vendor', 'node', 'node_modules', 'npm');
  const dest = path.join(appOutDir, 'resources', 'npm');
  if (!fs.existsSync(src)) {
    console.warn('[afterPack] vendor npm not found at', src);
    return;
  }
  if (fs.existsSync(dest)) {
    fs.rmSync(dest, { recursive: true, force: true });
  }
  fs.cpSync(src, dest, { recursive: true });
  const count = fs.readdirSync(path.join(dest, 'node_modules')).length;
  console.log(`[afterPack] copied npm (${count} deps) ->`, dest);
};
