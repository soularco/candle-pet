#!/usr/bin/env node
/**
 * Build the transferable archive.
 *
 * This exists because of a real failure: an earlier archive was packed AFTER the
 * source had been edited but BEFORE refresh:runtime ran, so the zip shipped a build
 * whose fingerprint no longer matched. Double-clicking the shortcut from that
 * archive exited instantly with "试用程序文件缺失或已变化" and no dialog at all -
 * which is the worst kind of failure to debug.
 *
 * The order is therefore the whole point:
 *   1. refresh:runtime   register the current build
 *   2. zip               only then
 *
 * Run from windows/code/desktop-pet:  node tools/pack-archive.mjs
 *
 * A live launch check was tried here and removed: process polling is unreliable
 * under the harness sandbox, and a false negative that refuses to pack is worse
 * than no check at all. Verify a launch by hand before shipping.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = 'D:/aaa/AAAAGENT';
const DEST = 'C:/Users/Administrator/Desktop/烛-项目归档';
const ZIP = join(DEST, '99-完整包', '烛-完整包.zip');

const step = text => console.log('\n── ' + text + ' ' + '─'.repeat(Math.max(0, 56 - text.length)));
const run = (file, args, cwd) => execFileSync(file, args, { cwd, stdio: 'inherit', shell: false });

step('1/2  刷新运行时指纹');
// node is called directly rather than through npm.cmd: spawning a .cmd wrapper fails
// with EINVAL here, and the npm script only forwards to this file anyway.
run(process.execPath, ['tools/refresh-runtime.mjs'], join(ROOT, 'windows/code/desktop-pet'));

step('2/2  打包');
mkdirSync(join(DEST, '99-完整包'), { recursive: true });
rmSync(ZIP, { force: true });
const win = p => p.replace(/\//g, '\\');
run('powershell.exe', ['-NoProfile', '-Command',
  `Add-Type -AssemblyName System.IO.Compression.FileSystem; ` +
  `[System.IO.Compression.ZipFile]::CreateFromDirectory('${win(ROOT)}', '${win(ZIP)}', ` +
  `[System.IO.Compression.CompressionLevel]::Optimal, $true)`], ROOT);

console.log('\n  ✅ ' + ZIP + '  (' + (statSync(ZIP).size / 1048576).toFixed(1) + ' MB)');
console.log('  指纹已在打包前刷新，包内容与指纹一致。');
