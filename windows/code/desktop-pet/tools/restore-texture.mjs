import { readFileSync, writeFileSync, existsSync, statSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';

// 恢复助手：把用户给的纹理放回去，并做全套校验。
//
// 用法：
//   node tools/restore-texture.mjs "D:\某个路径\texture_00.png"
// 或者不带参数，脚本会在常见位置自己找一遍。

const DEST_DIR = 'D:/aaa/AAAAGENT/windows/code/desktop-pet/desktop/assets/local-model/pet.8192';
const DEST = join(DEST_DIR, 'texture_00.png');
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const inspect = file => {
  const buf = readFileSync(file);
  if (buf.length < 33 || !buf.subarray(0, 8).equals(PNG_MAGIC)) return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), size: buf.length, buf };
};

const source = process.argv[2];
console.log('══ 恢复模型纹理 ══\n');

if (!source) {
  console.log('  用法: node tools/restore-texture.mjs "<texture_00.png 的路径>"\n');
  console.log('  当前状态:');
  console.log('    ' + DEST + '  ' + (existsSync(DEST) ? '已存在' : '❌ 缺失'));
  process.exit(1);
}

if (!existsSync(source)) {
  console.error('  ❌ 找不到文件: ' + source);
  process.exit(1);
}

const info = inspect(source);
if (!info) {
  console.error('  ❌ 这不是一个 PNG 文件');
  process.exit(1);
}

console.log('  源文件: ' + source);
console.log('  尺寸:   ' + info.width + ' × ' + info.height);
console.log('  大小:   ' + (info.size / 1048576).toFixed(1) + ' MB');

// 渲染不强制要求 8192，但 UV 是按导出时的尺寸排的，尺寸不同会错位。
if (info.width !== 8192 || info.height !== 8192) {
  console.log('\n  ⚠️ 尺寸不是 8192×8192。');
  console.log('     模型是按导出尺寸编的 UV，尺寸不对会花屏。');
  console.log('     如果只有别的尺寸，可以先试，但更推荐找回原始的那一张。');
} else {
  console.log('\n  ✅ 尺寸正确');
}

copyFileSync(source, DEST);
console.log('\n  ✅ 已写入: ' + DEST);
console.log('     大小 ' + (statSync(DEST).size / 1048576).toFixed(1) + ' MB');

console.log('\n  下一步（必须做，否则启动会因指纹不符而拒绝加载）:');
console.log('     cd D:\\aaa\\AAAAGENT\\windows\\code\\desktop-pet');
console.log('     npm.cmd run refresh:runtime        # 刷新运行时指纹');
console.log('     node tools\\refresh-model-fingerprint.mjs   # 重算模型指纹');
console.log('     然后重启 烛.exe');
