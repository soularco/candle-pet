#!/usr/bin/env node
/**
 * 动作参数适配性检查
 *
 * ── 为什么需要它 ──
 *
 * 动作表（desktop/interaction-motion.mjs）里，每个动作都会往一批参数写值，
 * 用来推物理、抬手、切姿势。那些参数名是按【某一个模型】起的。
 *
 * 但 Cubism 的参数名在模型之间并不通用。同一个 Param33：
 *
 *   希罗 / 雪   裙子物理x1
 *   无尽夏      前左长发
 *
 * 于是「推裙子」的动作到了无尽夏身上，推的是头发 —— 表现就是
 * 头发乱晃、裙子不动，或者整块看起来和身体脱节。
 * 更极端的是 Param3：在希罗上是「L1物理x1」，在无尽夏上却是
 * 「制作者：墨舞笔歌」，一驱动就把作者名字显示出来了。
 *
 * 这个脚本把这种事在做之前就查出来。
 *
 * ── 用法 ──
 *
 *   node tools/check-action-parameters.mjs
 *   node tools/check-action-parameters.mjs --json     输出 JSON，便于接入 CI
 *
 * 退出码：0 = 没问题；1 = 有需要处理的项。
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const ACTION_FILE = join(ROOT, 'desktop/interaction-motion.mjs');
const MODELS_DIR = join(ROOT, 'desktop/assets/models');
const LOCAL_MODEL_DIR = join(ROOT, 'desktop/assets/local-model');

const asJson = process.argv.includes('--json');

/** 名字里出现这些词，说明这个参数不是拿来当物理驱动的。 */
const SUSPICIOUS = [
  { re: /制作者|作者|模型|署名|credit|author/i, why: '这是显示署名/文字的开关，驱动它会露出文字' },
  { re: /水印|watermark|禁止|规则|rule/i, why: '这是水印或说明文字的开关' },
  { re: /20\d\d[.\-/]\d{1,2}/, why: '这是版本日期，不是物理参数' },
];

/**
 * 从动作表里抽出「哪个动作会写哪些参数」。
 *
 * 不引 JS 解析器，靠文本匹配即可 —— 动作表的写法很规整：
 *   动作名:{duration:..., arm:{...}, phys:{Param33:[[...]],...}, curve:{...}}
 */
function readActionTable() {
  const text = readFileSync(ACTION_FILE, 'utf8');
  const actions = [];

  // 逐个动作块切分：行首两空格 + 名字 + :{
  const header = /^  ([A-Za-z][A-Za-z0-9_]*):\s*\{/gm;
  const marks = [];
  let m;
  while ((m = header.exec(text)) !== null) marks.push({ name: m[1], at: m.index });
  if (!marks.length) return actions;

  for (let i = 0; i < marks.length; i++) {
    const start = marks[i].at;
    const end = i + 1 < marks.length ? marks[i + 1].at : text.length;
    const block = text.slice(start, end);

    const params = new Set();
    // phys:{ ... } 里的 ParamNN
    const physAt = block.indexOf('phys:{');
    if (physAt >= 0) {
      // 取到与之配对的 close：从 phys:{ 开始数字号
      let depth = 0, from = physAt + 'phys:'.length, stop = block.length;
      for (let k = from; k < block.length; k++) {
        if (block[k] === '{') depth++;
        else if (block[k] === '}') { depth--; if (depth === 0) { stop = k; break; } }
      }
      const seg = block.slice(from, stop);
      for (const p of seg.match(/Param[A-Za-z0-9_]+/g) ?? []) params.add(p);
    }
    // switches:[{id:'ParamNN',value:..}]
    for (const p of block.match(/'Param[A-Za-z0-9_]+'/g) ?? []) params.add(p.replaceAll("'", ''));

    if (params.size) actions.push({ name: marks[i].name, params: [...params] });
  }
  return actions;
}

/** 读一个模型的参数表：Id -> Name。 */
function readModelParameters(dir) {
  const file = join(dir, 'pet.cdi3.json');
  if (!existsSync(file)) return null;
  let json;
  try { json = JSON.parse(readFileSync(file, 'utf8')); } catch { return null; }
  const map = new Map();
  for (const p of json.Parameters ?? []) if (p?.Id) map.set(p.Id, p.Name ?? '');
  for (const g of json.ParameterGroups ?? []) {
    for (const p of g?.Parameters ?? []) if (p?.Id && !map.has(p.Id)) map.set(p.Id, p.Name ?? '');
  }
  return map;
}

// ── 收集模型 ──
const models = [];
for (const dir of [LOCAL_MODEL_DIR, MODELS_DIR]) {
  if (!existsSync(dir)) continue;
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const full = join(dir, e.name);
    const params = readModelParameters(full);
    if (params) models.push({ id: e.name, params });
  }
}

const actions = readActionTable();

// ── 检查 ──
const problems = [];
for (const action of actions) {
  for (const param of action.params) {
    const where = [];
    for (const model of models) where.push({ model: model.id, name: model.params.get(param) });

    const present = where.filter(w => w.name !== undefined);
    const missing = where.filter(w => w.name === undefined);

    // 1) 模型之间名字不一致 —— 这就是「套用动作错位」的直接证据
    const distinct = [...new Set(present.map(w => w.name))];
    if (distinct.length > 1) {
      problems.push({
        kind: 'NAME-CONFLICT',
        action: action.name,
        param,
        detail: present.map(w => `${w.model}=${w.name}`).join('  '),
        why: '同一个参数在各模型里含义不同，动作按其中一个模型的语义写值，在别的模型上会推错部件',
      });
    }

    // 2) 参数在某些模型里不存在 —— 写值无效，但一般无害
    if (present.length && missing.length) {
      problems.push({
        kind: 'MISSING',
        action: action.name,
        param,
        detail: missing.map(w => w.model).join(', ') + ' 里没有这个参数',
        why: '写值会被忽略；如果这个动作主要靠它，那个模型上动作会看起来没效果',
      });
    }

    // 3) 参数名本身就不该被驱动
    const names = [...new Set([...present.map(w => w.name), ...(present.length ? [] : [param])])];
    for (const name of names) {
      const hit = SUSPICIOUS.find(s => s.re.test(name));
      if (hit) {
        problems.push({
          kind: 'SUSPICIOUS',
          action: action.name,
          param,
          detail: `${param} 的名字是「${name}」`,
          why: hit.why,
        });
      }
    }
  }
}

// ── 输出 ──
if (asJson) {
  console.log(JSON.stringify({ models: models.map(m => m.id), actions: actions.length, problems }, null, 2));
} else {
  console.log('════ 动作参数适配性检查 ════\n');
  console.log('  参与检查的模型: ' + (models.map(m => m.id).join(', ') || '（没找到模型）'));
  console.log('  动作条目: ' + actions.length + ' 个\n');

  if (!problems.length) {
    console.log('  ✅ 没发现问题：动作表里的参数在所有模型上含义一致。');
  } else {
    const group = kind => {
      const seen = new Map();
      for (const p of problems.filter(x => x.kind === kind)) {
        if (!seen.has(p.param)) seen.set(p.param, { ...p, actions: [] });
        seen.get(p.param).actions.push(p.action);
      }
      return [...seen.values()];
    };

    const conflicts = group('NAME-CONFLICT');
    const suspicious = group('SUSPICIOUS');
    const missing = group('MISSING');

    if (conflicts.length) {
      console.log('  ★ 参数含义在各模型间不一致 —— 这就是动作错位的原因\n');
      console.log('    ' + '参数'.padEnd(10) + '各模型里的名字'.padEnd(52) + '涉及动作');
      console.log('    ' + '─'.repeat(78));
      for (const c of conflicts) {
        console.log('    ' + c.param.padEnd(10) + c.detail.padEnd(52) + c.actions.length + ' 个');
      }
      console.log('');
    }

    if (suspicious.length) {
      console.log('  ★ 参数名本身不该被驱动\n');
      for (const c of suspicious) {
        console.log('    ' + c.param.padEnd(10) + c.detail);
        console.log('    ' + ''.padEnd(10) + '→ ' + c.why + '（' + c.actions.length + ' 个动作在写它）');
      }
      console.log('');
    }

    if (missing.length) {
      console.log('  · 参数在部分模型里不存在（写值被忽略，一般无害）\n');
      for (const c of missing) {
        console.log('    ' + c.param.padEnd(10) + c.detail + '   （' + c.actions.length + ' 个动作）');
      }
      console.log('');
    }

    console.log('  ── 汇总 ──');
    console.log('    含义冲突 ' + conflicts.length + ' 个参数 · 不该驱动 ' + suspicious.length +
      ' 个 · 缺失 ' + missing.length + ' 个');
    console.log('');
    console.log('  建议：');
    console.log('    · 含义冲突的参数，要么给每个模型各维护一份动作表，');
    console.log('      要么在写入前先确认它在当前模型里的含义。');
    console.log('    · 文字 / 水印 / 日期类的参数，永远不要由动作驱动。');
    console.log('    · 本项目的做法：关掉动作对物理参数的整体驱动，');
    console.log('      让模型自带的 physics3.json 跟随身体自然摆动。');
  }
  console.log('\n  （加 --json 可输出机器可读结果）');
}

process.exitCode = problems.some(p => p.kind !== 'MISSING') ? 1 : 0;
