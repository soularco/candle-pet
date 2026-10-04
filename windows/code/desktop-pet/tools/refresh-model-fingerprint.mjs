// Recompute ONLY the model fingerprint, leaving the rest of presets.json alone.
//
// tools/configure-model.mjs rebuilds the whole catalog from config/presets.example.json
// and writes with flag 'wx', so running it would both refuse (the file exists) and
// discard the hand-authored items. The hash is reproduced exactly as that tool
// computes it - same path set, same sort, same separator - but written back into the
// existing catalog.
import { readFile, writeFile, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

const code = fileURLToPath(new URL('..', import.meta.url));
const base = await realpath(resolve(code, 'desktop/assets/local-model'));
const refs = JSON.parse(await readFile(resolve(base, 'pet.model3.json'), 'utf8')).FileReferences;

const paths = [...new Set([
  'pet.model3.json', refs.Moc, refs.Physics,
  ...refs.Expressions.map(x => x.File),
  ...Object.values(refs.Motions ?? {}).flat().map(x => x.File),
])].sort();

const hash = b => createHash('sha256').update(b).digest('hex');
let binding = '';
for (const p of [...paths, ...refs.Textures, refs.DisplayInfo]) {
  if (typeof p !== 'string' || p.startsWith('/') || p.split('/').some(x => !x || x === '.' || x === '..') || /[:%\\]/.test(p)) throw new Error('Unsafe model-relative path: ' + p);
  const actual = await realpath(resolve(base, p));
  const rel = relative(base, actual);
  if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('Model reference escapes its directory: ' + p);
  if (paths.includes(p)) binding += p + '\0' + hash(await readFile(actual)) + '\n';
}

const catalogPath = resolve(base, 'presets.json');
const catalog = JSON.parse(await readFile(catalogPath, 'utf8'));
const before = catalog.modelFingerprint;
catalog.modelFingerprint = hash(binding);
await writeFile(catalogPath, JSON.stringify(catalog, null, 2) + '\n', 'utf8');

console.log('  参与指纹的文件 (' + paths.length + '):');
for (const p of paths) console.log('    ' + p);
console.log('');
console.log('  旧指纹: ' + before);
console.log('  新指纹: ' + catalog.modelFingerprint);
console.log('  ' + (before === catalog.modelFingerprint ? '· 未变化' : '✅ 已更新'));
console.log('  items 数量保留: ' + (catalog.items?.length ?? 0));
