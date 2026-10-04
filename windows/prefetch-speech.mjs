// Pre-synthesize every ambient line with the cloud voice and store it locally.
//
// Why: the cloud voice (qwen3-tts, Cherry) sounds far better than the offline
// engine, but every line is an API call — it costs money, needs a working
// network, and is unavailable whenever DNS or the proxy misbehaves. Synthesizing
// each preset line once means the pet can keep talking offline forever after.
//
// Usage (from the windows folder):
//     node prefetch-speech.mjs            # synthesize anything missing
//     node prefetch-speech.mjs --force    # re-synthesize everything
//
// The cache lives in .local/speech-cache and is keyed by a hash of the text, so
// editing a line in ambient.json simply adds one new file.

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, 'code', 'desktop-pet');
const desktopRoot = resolve(projectRoot, 'desktop');
const cacheDir = resolve(here, '.local', 'speech-cache');
const configFile = resolve(here, '.local', 'model-evaluation', 'trial', 'user-trial', 'config.json');
const force = process.argv.includes('--force');

const cacheName = text => createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 32) + '.wav';

async function loadLines() {
  const raw = JSON.parse(await readFile(join(desktopRoot, 'ambient.json'), 'utf8'));
  const { AmbientScheduler } = await import(pathToFileURL(join(desktopRoot, 'ambient.mjs')).href);
  const userName = raw.profile?.userName ?? '';
  const lines = new Set();
  // Ambient lines, the short answers played when the character is tapped, and
  // both branches of every conversation exchange. {name} is substituted with the
  // same rule playback uses, otherwise the cache key would never match.
  const collect = entry => {
    if (!entry) return;
    if (typeof entry === 'string') { const text = AmbientScheduler.personalise(entry.trim(), userName); if (text) lines.add(text); return; }
    const text = AmbientScheduler.personalise((entry.text ?? '').trim(), userName);
    if (text) lines.add(text);
    // Chain follow-ups are spoken too, so they need a clip of their own. Missing
    // them left 27 lines silent at playback.
    if (Array.isArray(entry.chain)) {
      for (const follow of entry.chain) {
        const spoken = AmbientScheduler.personalise(String(follow).trim(), userName);
        if (spoken) lines.add(spoken);
      }
    }
    if (entry.waiting) { collect(entry.waiting.reply); collect(entry.waiting.ignored); collect(entry.waiting.remind); }
  };
  for (const group of raw.groups ?? []) for (const entry of group.lines ?? []) collect(entry);
  for (const entry of raw.reactions ?? []) collect(entry);
  return [...lines];
}

async function loadTts() {
  const config = JSON.parse(await readFile(configFile, 'utf8'));
  const slot = config.models?.tts;
  if (!slot) throw new Error('trial config has no tts slot');
  const key = (await readFile(slot.credentialFile, 'utf8')).trim();
  return { endpoint: slot.endpoint, model: slot.model, key };
}

/** One line -> WAV bytes, straight from the provider. */
/**
 * The pet's read-aloud style.
 *
 * One fixed style is baked into the cache; per-line mood is applied later by
 * adjusting playback rate and detune, which costs nothing. The style targets a
 * lively, cute 19-year-old: the model is a teenage anime girl, so a neutral
 * news-reader delivery did not fit her at all.
 */
const SPEECH_INSTRUCTION = '用温柔又活泼的少女嗓音朗读，声音清甜柔和，语气亲切自然，带着轻快的笑意和一点俏皮，像在和朋友撒娇聊天，语速舒缓但有起伏，句子之间连贯流畅。';

/**
 * Text as it should be SPOKEN, which is not always how it is written.
 *
 * 71 of the lines end a clause with an ellipsis. The synthesizer turns that into
 * an unpredictable pause and sometimes clips the following word, which is what
 * "停顿或者连读异常" describes. It becomes a comma for the recording only; the
 * speech bubble still shows the original text.
 */
function speechText(text) {
  const spoken = String(text)
    .replace(/…+/g, '，')
    .replace(/~+/g, '，')
    .replace(/[，、]{2,}/g, '，')
    .replace(/^[，、\s]+/, '')
    .replace(/[，、]+$/, '')
    .trim();
  // A line of pure punctuation ("……") normalises to nothing. Falling back to the
  // original keeps a quiet beat audible instead of silently failing to synthesize.
  return spoken || String(text).trim() || '……';
}

async function synthesize(tts, text, voice, language) {
  const response = await fetch(tts.endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${tts.key}` },
    body: JSON.stringify({ model: tts.model, input: { text: speechText(text), voice, language_type: language, instructions: SPEECH_INSTRUCTION, optimize_instructions: false } }),
    signal: AbortSignal.timeout(60000),
  });
  if (!response.ok) {
    const body = await response.text();
    const error = new Error(`HTTP ${response.status}: ${body.slice(0, 200)}`);
    // 429 / rate-limit and 5xx are worth retrying; a 403 quota error is not.
    error.retryable = response.status === 429 || response.status >= 500
      || /Throttling|RateQuota|timeout/i.test(body);
    throw error;
  }
  const payload = await response.json();
  const url = payload?.output?.audio?.url;
  if (typeof url !== 'string' || !url) throw new Error('provider returned no audio url');
  const audio = await fetch(url, { signal: AbortSignal.timeout(60000) });
  if (!audio.ok) throw new Error(`audio download HTTP ${audio.status}`);
  const bytes = Buffer.from(await audio.arrayBuffer());
  if (bytes.length <= 46) throw new Error('provider returned empty audio');
  return bytes;
}

/**
 * Synthesize with retries.
 *
 * A full library is several hundred requests in a row, which reliably trips the
 * provider's rate limiter partway through — the first attempt to build a big
 * batch lost 93 lines to HTTP 429. Retrying with backoff turns a partial failure
 * into a slow success.
 */
async function synthesizeWithRetry(tts, text, voice, language, attempts = 5) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try { return await synthesize(tts, text, voice, language); }
    catch (error) {
      lastError = error;
      if (!error.retryable) throw error;
      const wait = Math.min(20000, 1200 * Math.pow(2, attempt)) + Math.random() * 500;
      process.stdout.write(`     429 限流，${Math.round(wait / 1000)} 秒后重试（第 ${attempt + 1}/${attempts} 次）\n`);
      await new Promise(resolve => setTimeout(resolve, wait));
    }
  }
  throw lastError;
}

const main = async () => {
  const raw = JSON.parse(await readFile(join(desktopRoot, 'ambient.json'), 'utf8'));
  const speech = raw.speech ?? {};
  const voice = typeof speech.cloudVoice === 'string' && speech.cloudVoice ? speech.cloudVoice : 'Cherry';
  const language = typeof speech.cloudLanguage === 'string' && speech.cloudLanguage ? speech.cloudLanguage : 'Chinese';
  const lines = await loadLines();
  // Catch content that cannot be spoken. A line of pure punctuation normalises
  // away to nothing and the provider rejects it, which used to surface only as an
  // unexplained per-line failure at the end of a long run.
  const reportUnspeakable = () => {
    const bad = lines.filter(text => !speechText(text).trim() || !/[\p{L}\p{N}]/u.test(speechText(text)));
    if (bad.length === 0) return 0;
    console.log('  ⚠️ ' + bad.length + ' 条台词没有任何可朗读的字：');
    for (const text of bad.slice(0, 10)) console.log('      ' + JSON.stringify(text));
    console.log('  请把纯标点台词改成可朗读的内容，例如 "……" -> "……嗯。"');
    console.log('');
    return bad.length;
  };
  reportUnspeakable();
  const tts = await loadTts();
  await mkdir(cacheDir, { recursive: true });
  console.log(`语音缓存目录: ${cacheDir}`);
  console.log(`台词总数: ${lines.length}   音色: ${voice}   模型: ${tts.model}`);
  console.log('');
  let created = 0, skipped = 0, failed = 0;
  for (const [index, text] of lines.entries()) {
    const file = join(cacheDir, cacheName(text));
    if (!force) {
      try { if ((await stat(file)).size > 46) { skipped++; continue; } } catch {}
    }
    const label = `[${index + 1}/${lines.length}]`;
    try {
      const bytes = await synthesizeWithRetry(tts, text, voice, language);
      await writeFile(file, bytes, { mode: 0o600 });
      created++;
      console.log(`${label} OK   ${Math.round(bytes.length / 1024)} KB  ${text}`);
    } catch (error) {
      failed++;
      console.log(`${label} FAIL ${text}  -> ${error?.message ?? error}`);
    }
    // Stay well inside the provider rate limit.
    await new Promise(r => setTimeout(r, 350));
  }
  console.log('');
  console.log(`完成: 新增 ${created}，已存在 ${skipped}，失败 ${failed}`);
  if (failed) console.log('失败的多半是网络问题（域名解析/超时），重新运行本脚本只会补齐缺失的部分。');
};

await main();
