#!/usr/bin/env node
// repair-session.cjs —— 修复 DeepSeek Harness 会话日志中的 seq 重复/回退问题。
//
// 适用症状：打开历史会话时报
//   "corrupt session log: seq gap in committed region ... (expected X, got Y)"
// 根因通常是两个 Harness 后端同时写同一个 ~/.dsh，导致序号错位。
//
// 用法：
//   node repair-session.cjs <session.jsonl.zstd 的完整路径>
//   node repair-session.cjs <session-id>            # 自动到 ~/.dsh/sessions 下查找
//
// ⚠ 运行前必须关闭所有 DeepSeek Harness 实例（浏览器 web / 桌面 App / 终端 dsh），
//   确保该会话文件不再被写入，否则修复结果不可靠。

const fs = require('fs');
const path = require('path');
const os = require('os');
const zlib = require('node:zlib');

const MAGIC = 0xfd2fb528;

// 解压整个文件（header 帧 + 若干事件帧），任意一帧解不开就抛错。
function decompressFile(buf) {
  const starts = [];
  for (let i = 0; i + 4 <= buf.length; i++) {
    if (buf.readUInt32LE(i) === MAGIC) starts.push(i);
  }
  if (starts.length === 0) throw new Error('文件中未找到 zstd 帧（可能不是 .zstd 会话日志）');
  let plain = '';
  for (let k = 0; k < starts.length; k++) {
    const s = starts[k];
    const e = k + 1 < starts.length ? starts[k + 1] : buf.length;
    try {
      plain += zlib.zstdDecompressSync(buf.subarray(s, e)).toString('utf8');
    } catch (err) {
      if (k === starts.length - 1) {
        throw new Error('最后一个 zstd 帧不完整：文件可能仍在被写入。请先关闭所有 Harness 实例再运行本脚本。');
      }
      throw new Error(`第 ${k} 个 zstd 帧解压失败：${err.message}`);
    }
  }
  return plain;
}

// 复刻 harness 的行解码：chunk 行展开为多事件，其它行是单事件。
function expand(rec) {
  if (!rec || typeof rec !== 'object') return null;
  if (rec.type === 'text-chunks' || rec.type === 'reasoning-chunks' || rec.type === 'tool-call-chunks') {
    const n = rec.type === 'tool-call-chunks' ? rec.data.args.length : rec.data.texts.length;
    return { start: rec.seq0, count: n };
  }
  if (typeof rec.seq === 'number') return { start: rec.seq, count: 1 };
  return null;
}

// 定位会话文件：直接路径，或按 session-id 在 ~/.dsh/sessions 下搜索。
function locateFile(arg) {
  if (fs.existsSync(arg)) return path.resolve(arg);
  const root = path.join(os.homedir(), '.dsh', 'sessions');
  const found = [];
  (function walk(dir) {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.name === 'session.jsonl.zstd' && path.basename(path.dirname(p)) === arg) found.push(p);
    }
  })(root);
  if (found.length === 0) throw new Error(`找不到会话文件：${arg}`);
  if (found.length > 1) throw new Error(`session-id 匹配到多个文件：\n${found.join('\n')}`);
  return found[0];
}

// 扫描并返回第一个序号断裂位置；无断裂返回 null。
function findGap(lines) {
  let position = 0;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.length) continue;
    const rec = JSON.parse(line);
    const x = expand(rec);
    if (!x) continue;
    if (x.start !== position) return { line: i, expected: position, got: x.start };
    position += x.count;
  }
  return null;
}

function main() {
  const arg = process.argv[2];
  if (!arg) {
    console.error('用法: node repair-session.cjs <session.jsonl.zstd 路径 | session-id>');
    process.exit(2);
  }

  const file = locateFile(arg);
  console.log('目标文件:', file);

  const plain = decompressFile(fs.readFileSync(file));
  const lines = plain.split('\n');
  console.log('总行数（含头）:', lines.length);

  const gap = findGap(lines);
  if (gap === null) {
    console.log('未发现序号断裂，无需修复。');
    process.exit(0);
  }
  const P = gap.expected;
  console.log(`发现损坏：第 ${gap.line} 行，期望 seq=${gap.expected}，实际=${gap.got}`);

  // 从损坏行起：seq / seq0 +1；sourceEventSeqs 中 >= P 的引用也 +1。
  let adjusted = 0;
  for (let i = gap.line; i < lines.length; i++) {
    const line = lines[i];
    if (!line.length) continue;
    const rec = JSON.parse(line);
    let changed = false;
    if (rec.type === 'text-chunks' || rec.type === 'reasoning-chunks' || rec.type === 'tool-call-chunks') {
      rec.seq0 += 1;
      changed = true;
    } else if (typeof rec.seq === 'number') {
      rec.seq += 1;
      changed = true;
    }
    if (Array.isArray(rec.sourceEventSeqs)) {
      for (let j = 0; j < rec.sourceEventSeqs.length; j++) {
        if (rec.sourceEventSeqs[j] >= P) {
          rec.sourceEventSeqs[j] += 1;
          changed = true;
        }
      }
    }
    if (changed) {
      lines[i] = JSON.stringify(rec);
      adjusted++;
    }
  }
  console.log('已调整行数:', adjusted);

  // 重新编码为 harness 的帧格式：header 帧 + 事件帧。
  const headerFrame = zlib.zstdCompressSync(Buffer.from(lines[0] + '\n', 'utf8'));
  const eventFrame = zlib.zstdCompressSync(Buffer.from(lines.slice(1).join('\n'), 'utf8'));
  const out = Buffer.concat([headerFrame, eventFrame]);

  // 备份 + 写回。
  const backup = `${file}.corrupt-bak-${Date.now()}`;
  fs.copyFileSync(file, backup);
  fs.writeFileSync(file, out);
  console.log('已备份原文件到:', backup);
  console.log('已写回修复后的文件。');

  // 自校验。
  const verifyGap = findGap(decompressFile(fs.readFileSync(file)).split('\n'));
  if (verifyGap === null) {
    console.log('✅ 校验通过：序号已连续。');
  } else {
    console.error(`❌ 校验仍失败于第 ${verifyGap.line} 行。请用备份文件 ${backup} 还原。`);
    process.exit(1);
  }
}

main();
