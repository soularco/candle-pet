import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { networkInterfaces } from 'node:os';
import { app, BrowserWindow, ipcMain, Menu, nativeImage, powerMonitor, protocol, screen, shell, Tray } from 'electron';
import { readFile, writeFile, mkdir, unlink } from 'node:fs/promises';
import { existsSync, statSync, renameSync, appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BackendConnection } from './transport.mjs';
import { fitDisplay } from './layout.mjs';
import { assetResponse } from './assets.mjs';
import { managementUrl } from '../../tools/management-url.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const option = name => { const i = process.argv.indexOf(name); return i < 0 ? undefined : process.argv[i + 1]; };
const root = resolve(option('--root') || resolve(here, '..'));
const node = option('--node'), backend = option('--backend');
if (!node || !backend) throw Error('Use npm run dev or npm start to launch the Windows host.');

// Offline speech engine. eSpeak NG is a self-contained synthesizer: it does not
// touch the broken Microsoft Chinese voice, and it needs no network or API key.
const SPEECH_ENGINES = [
  process.env.PET_SPEECH_ENGINE,
  'C:\\Program Files\\eSpeak NG\\espeak-ng.exe',
  'C:\\Program Files (x86)\\eSpeak NG\\espeak-ng.exe',
  resolve(process.env.LOCALAPPDATA || '', 'Programs', 'eSpeak NG', 'espeak-ng.exe'),
].filter(Boolean);
let speechEnginePath;
for (const candidate of SPEECH_ENGINES) { try { await readFile(candidate); speechEnginePath = candidate; break; } catch {} }

// Pre-synthesized ambient lines, produced by windows/prefetch-speech.mjs. Playing
// a cached clip needs no network and costs nothing, so a flaky DNS or a broken
// proxy can no longer leave the pet silent.
const speechCacheDir = resolve(root, '..', '..', '..', '.local', 'speech-cache');
const speechCacheName = text => createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 32) + '.wav';
async function readCachedSpeech(text) {
  try {
    const bytes = await readFile(join(speechCacheDir, speechCacheName(text)));
    return bytes.length > 46 ? bytes : null;
  } catch { return null; }
}
/**
 * The pet's read-aloud style — ONE style for everything.
 *
 * Per-emotion instructions were tried and rejected: a line that missed the cache
 * was synthesized in a different manner from the cached ones, so the pet appeared
 * to change voice mid-sentence. The character stays the same; mood is expressed
 * afterwards by a small playback rate and pitch adjustment instead.
 */
const SPEECH_INSTRUCTION = '用温柔又活泼的少女嗓音朗读，声音清甜柔和，语气亲切自然，带着轻快的笑意和一点俏皮，像在和朋友撒娇聊天，语速舒缓但有起伏，句子之间连贯流畅。';

/**
 * Synthesize one line with the cloud voice and store it in the cache.
 *
 * A line with no cached clip used to fall back to a live cloud request on every
 * play, so its first play needed the network and kept needing it. Caching here
 * means each line costs one request ever; afterwards it is a local file.
 */
/**
 * Text as it should be SPOKEN, which is not always how it is written.
 *
 * An ellipsis makes the synthesizer insert an unpredictable pause and sometimes
 * clip the next word. It becomes a comma for the recording only; the bubble still
 * shows the original text. Must stay identical to the rule in prefetch-speech.mjs,
 * or a cached line and an on-demand line of the same text would differ.
 */
function speechText(text) {
  const spoken = String(text)
    .replace(/…+/g, '，')
    .replace(/~+/g, '，')
    .replace(/[，、]{2,}/g, '，')
    .replace(/^[，、\s]+/, '')
    .replace(/[，、]+$/, '')
    .trim();
  // A line of pure punctuation ("……") normalises to nothing, which the provider
  // rejects outright. Keeping the original makes a quiet beat audible instead of
  // silently failing. Must match prefetch-speech.mjs exactly, or a cached line and
  // an on-demand line of the same text would differ.
  return spoken || String(text).trim() || '……';
}

async function synthesizeSpeech(text) {
  const configPath = process.env.PET_TRIAL_CONFIG;
  if (!configPath) throw new Error('no trial config');
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  const slot = config.models?.tts;
  if (!slot?.endpoint || !slot?.model || !slot?.credentialFile) throw new Error('trial config has no tts slot');
  const key = (await readFile(slot.credentialFile, 'utf8')).trim();
  // Voice and language always come from ambient.json so the whole library keeps
  // exactly the same timbre, whether a clip is pre-baked or synthesized on demand.
  let voice = 'Chelsie', language = 'Chinese';
  try {
    const speech = JSON.parse(await readFile(resolve(root, 'ambient.json'), 'utf8'))?.speech ?? {};
    if (typeof speech.cloudVoice === 'string' && speech.cloudVoice) voice = speech.cloudVoice;
    if (typeof speech.cloudLanguage === 'string' && speech.cloudLanguage) language = speech.cloudLanguage;
  } catch {}
  const response = await fetch(slot.endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({ model: slot.model, input: { text: speechText(text), voice, language_type: language, instructions: SPEECH_INSTRUCTION, optimize_instructions: false } }),
    signal: AbortSignal.timeout(60000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${(await response.text()).slice(0, 160)}`);
  const payload = await response.json();
  const url = payload?.output?.audio?.url;
  if (typeof url !== 'string' || !url) throw new Error('provider returned no audio url');
  const audio = await fetch(url, { signal: AbortSignal.timeout(60000) });
  if (!audio.ok) throw new Error(`audio download HTTP ${audio.status}`);
  const bytes = Buffer.from(await audio.arrayBuffer());
  if (bytes.length <= 46) throw new Error('provider returned empty audio');
  try { await mkdir(speechCacheDir, { recursive: true }); await writeFile(join(speechCacheDir, speechCacheName(text)), bytes); }
  catch (error) { logLine(`SPEECH_CACHE_WRITE_FAILED: ${error?.message ?? error}`); }
  return bytes;
}

/** Synthesize with the local engine and resolve with WAV bytes.
 *  The engine writes to stdout, so nothing touches the filesystem: this host
 *  process is denied directory creation under its own userData path. */
/** eSpeak NG amplitude is 0..200; the app's volume is 0..1. */
function espeakAmplitude(volume) {
  const level = Number.isFinite(volume) ? Math.max(0, Math.min(1, volume)) : 1;
  return String(Math.round(level * 200));
}
function speakWithLocalEngine(text, options = {}) {
  if (!speechEnginePath) return Promise.reject(new Error('local speech engine not found'));
  const voice = typeof options.voice === 'string' && /^[a-z-]{2,20}$/.test(options.voice) ? options.voice : 'cmn';
  const speed = Number.isSafeInteger(options.speed) && options.speed >= 80 && options.speed <= 450 ? String(options.speed) : '165';
  return new Promise((settle, fail) => {
    execFile(speechEnginePath, ['-v', voice, '-s', speed, '-a', espeakAmplitude(options.volume), '--stdout', text],
      { windowsHide: true, timeout: 20000, maxBuffer: 16 * 1024 * 1024, encoding: 'buffer' },
      (error, stdout, stderr) => {
        if (error) { process.stderr.write(`SPEECH_ENGINE_DETAIL: exe=${speechEnginePath} voice=${voice} code=${error.code ?? ''} stderr=${String(stderr ?? '').slice(0, 300)}\n`); fail(error); return; }
        const bytes = Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout ?? '');
        if (bytes.length <= 46) { fail(new Error('local speech produced no audio')); return; }
        settle(bytes);
      });
  });
}
logLine('LAUNCH argv=' + process.argv.slice(2).join(' ').slice(0, 160));
const preview = process.argv.includes('--preview');
const inspect = process.argv.includes('--inspect');
const smoke = process.argv.includes('--smoke-test');
/**
 * Diagnostic log on disk.
 *
 * The launcher starts this process with CREATE_NO_WINDOW and no stdio
 * redirection, so every stderr line it writes is discarded. That made a whole
 * class of failures — a stale runtime fingerprint, a tray that never appeared, a
 * silent exception — completely invisible when running the packaged exe. These
 * lines go to a file as well, trimmed so it cannot grow without bound.
 */
// 面板打开前的窗口尺寸，用来还原。
let panelRestore = null;

const LOG_DIR = resolve(root, '..', '..', '..', '.local', 'logs');
const LOG_FILE = join(LOG_DIR, 'electron.log');
const LOG_MAX_BYTES = 512 * 1024;
function logLine(text) {
  const stamped = `${new Date().toISOString()} ${text}\n`;
  try {
    // appendFileSync does NOT create the directory, and the log folder does not
    // exist on a fresh install, so every early line was silently dropped.
    if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true });
    if (existsSync(LOG_FILE) && statSync(LOG_FILE).size > LOG_MAX_BYTES) {
      // One generation of history is enough for a desktop pet.
      try { renameSync(LOG_FILE, LOG_FILE + '.1'); } catch {}
    }
    appendFileSync(LOG_FILE, stamped, 'utf8');
  } catch { /* logging must never be the reason the pet fails */ }
}

/**
 * Never let an exception freeze the pet behind a modal dialog.
 *
 * Electron's default is to show a blocking "A JavaScript error occurred in the
 * main process" box. That happened twice while this code was being worked on, and
 * each time the pet stayed frozen until somebody clicked OK — worse than the
 * original failure, because a broken feature should degrade rather than wedge the
 * whole app. Failures go to stderr and to the log file.
 */
function reportMainFailure(label, error) {
  const message = error && error.stack ? error.stack : String(error);
  const line = `MAIN_${label}: ${String(message).slice(0, 600)}`;
  process.stderr.write(line + '\n');
  logLine(line);
}
process.on('uncaughtException', error => reportMainFailure('UNCAUGHT', error));
process.on('unhandledRejection', reason => reportMainFailure('REJECTION', reason));
app.setName('AAAAGENT');
app.setPath('userData', resolve(app.getPath('appData'), 'AAAAGENT', smoke ? 'smoke-test' : preview ? 'preview' : 'desktop'));
// Single-instance enforcement is best-effort only. Chromium can fail to create
// its singleton lock file (security software, an unwritable profile folder or a
// virtual display driver). Exiting here made the app quit silently with code 0,
// which is indistinguishable from "nothing happened". A desktop pet does not
// require this lock, so warn and continue instead of dying.
let hasSingleInstanceLock = false;
try { hasSingleInstanceLock = app.requestSingleInstanceLock({ root, preview }); }
catch { hasSingleInstanceLock = false; }
if (!hasSingleInstanceLock) process.stderr.write('AAAAGENT: single-instance lock unavailable; continuing anyway.\n');
protocol.registerSchemesAsPrivileged([{ scheme: 'pet', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }]);
let win, ready = false, voiceRequested = false, wakeRequested = false, panelOpen = false, beforeResize;
// The backend announces its presentation policy exactly once, right after it
// starts. That is usually before the window reports ready, and `deliver` drops
// anything sent before then, so the renderer never learned which procedural
// idle features were enabled and the character sat perfectly still. Keep the
// last policy and replay it once the renderer can receive it.
let lastPresentationPolicy = null;
let prefs = { mode: 'full', width: 360, hotkey: null }, anchor, prefsFile, writes = Promise.resolve();
const deliver = (method, ...args) => { if (ready && win && !win.isDestroyed()) win.webContents.send('pet:delivery', method, ...args); };
const replayPresentationPolicy = () => { if (lastPresentationPolicy) deliver('receive', lastPresentationPolicy.message, lastPresentationPolicy.generation); };
const connection = new BackendConnection({
  onState: state => {
    voiceRequested = wakeRequested = false;
    deliver('connectionChanged', state);
    // The renderer invalidates its cached policy on every connection change, but
    // the backend announces the policy only once. Re-delivering the last one right
    // after the state change is what keeps the idle features enabled; without it
    // automaticIds ends up empty and the character barely moves.
    replayPresentationPolicy();
  },
  onMessage: (message, generation) => {
    if (message.channel === 'wake_control') wakeRequested = message.enabled === true;
    if (message.channel === 'wake_error') wakeRequested = false;
    if (['capture_finish', 'capture_stop'].includes(message.channel)) voiceRequested = false;
    if (message.channel === 'presentation_policy') lastPresentationPolicy = { message, generation };
    deliver('receive', message, generation);
  }
});
const validHotkey = code => code === null || /^(Arrow(Up|Down|Left|Right)|Key[A-Z]|Digit[0-9]|F([1-9]|1[0-9]|20)|Space|Enter|Backspace|Delete|Home|End|PageUp|PageDown|Comma|Period|Slash|Semicolon|Quote|BracketLeft|BracketRight|Backslash|Minus|Equal|Backquote)$/.test(code);
function savePreferences() {
  const raw = JSON.stringify({ ...prefs, anchor });
  writes = writes.then(() => writeFile(prefsFile, raw)).catch(() => process.stderr.write('Display preferences could not be saved.\n'));
}
function layout() {
  if (!win || win.isDestroyed()) return;
  const display = screen.getDisplayNearestPoint({ x: Math.round(anchor.x), y: Math.round(anchor.y) });
  const fitted = fitDisplay(prefs.width, panelOpen, display.workArea, anchor, prefs.mode,
    { width: prefs.drawerWidth, height: prefs.drawerHeight });
  anchor = fitted.anchor; win.setBounds(fitted.bounds); deliver('displayConfig', fitted.config);
}
const trusted = event => win && event.sender === win.webContents && event.senderFrame === win.webContents.mainFrame && event.senderFrame.url === 'pet://app/index.html';
const start = () => connection.start(node, [backend], process.env);

const FOCUS_REPORTER = '烛-focus.exe';
const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const AUTOSTART_VALUE = '烛';

/**
 * Auto-start at sign-in.
 *
 * Implemented with the per-user Run key rather than a scheduled task: it needs no
 * elevation, is trivially reversible, and the user can see and remove it in Task
 * Manager. The launcher exe is preferred because it is the one that starts
 * without a console window; the node entry is the fallback when the exe is
 * missing (for example on a checkout that never built it).
 *
 * These must be declared BEFORE the IPC handlers that call them. Declaring a
 * plain function further down the file is not enough in this main process: the
 * handler throws "readAutoStart is not defined" exactly like startFocusReporter
 * did, so every helper the handlers use lives above them.
 */
async function launcherCommand() {
  const exe = resolve(root, '..', '..', '..', '..', '烛.exe');
  if (existsSync(exe)) return `"${exe}"`;
  const entry = resolve(root, '..', '..', '..', 'dist', 'app', 'trial-launcher.js');
  if (!existsSync(entry)) return null;
  return `"${node}" "${entry}"`;
}
function readAutoStart() {
  return new Promise(resolvePromise => {
    execFile('reg.exe', ['query', RUN_KEY, '/v', AUTOSTART_VALUE], { windowsHide: true },
      (error, stdout) => resolvePromise(!error && typeof stdout === 'string' && stdout.includes(AUTOSTART_VALUE)));
  });
}
function writeAutoStart(enabled) {
  return new Promise(async (resolvePromise, rejectPromise) => {
    try {
      if (!enabled) {
        await new Promise(done => execFile('reg.exe', ['delete', RUN_KEY, '/v', AUTOSTART_VALUE, '/f'], { windowsHide: true }, () => done()));
        return resolvePromise(true);
      }
      const command = await launcherCommand();
      if (!command) return rejectPromise(new Error('launcher not found'));
      await new Promise((done, fail) => execFile('reg.exe',
        ['add', RUN_KEY, '/v', AUTOSTART_VALUE, '/t', 'REG_SZ', '/d', command, '/f'], { windowsHide: true },
        error => error ? fail(error) : done()));
      resolvePromise(true);
    } catch (error) { rejectPromise(error); }
  });
}

/** Settings the panel is allowed to write back into ambient.json. */

let focusReporter = null, focusDigest = null, focusBuffer = '';
let focusReporterPath = null;
// Late-bound on purpose. A plain function declaration later in the file was
// reported as "startFocusReporter is not defined" when the IPC handler fired, so
// the call site only ever sees a variable that is guaranteed to exist.
let startFocusReporter = () => {};
// Set once shutdown begins so the reporter is not restarted on the way out.
let quitting = false;
/**
 * Foreground window reporter.
 *
 * Electron cannot see other applications' windows, and the pet needs to know
 * when somebody is in a fullscreen game, a video call or a presentation before
 * it decides to start talking. A tiny resident helper prints one JSON line every
 * 1.5 s; spawning PowerShell per sample would cost about 300 ms each time.
 */
startFocusReporter = () => {
  focusReporterPath ??= resolve(root, '..', '..', '..', '烛-focus.exe');
  if (focusReporter || !existsSync(focusReporterPath)) return;
  try {
    focusReporter = spawn(focusReporterPath, ['--interval', '1500', '--ignore', String(process.pid)], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch (error) { process.stderr.write(`FOCUS_REPORTER_FAILED: ${error?.message ?? error}\n`); focusReporter = null; return; }
  focusReporter.stdout.setEncoding('utf8');
  focusReporter.stdout.on('data', chunk => {
    focusBuffer += chunk;
    let newline;
    while ((newline = focusBuffer.indexOf('\n')) >= 0) {
      const line = focusBuffer.slice(0, newline).trim(); focusBuffer = focusBuffer.slice(newline + 1);
      if (!line) continue;
      let parsed;
      try { parsed = JSON.parse(line); } catch { continue; }
      // Only forward real changes; the renderer does not need the same picture
      // several times a second.
      const digest = JSON.stringify(parsed);
      if (digest === focusDigest) continue;
      focusDigest = digest;
      deliver('foregroundState', parsed);
    }
  });
  focusReporter.on('exit', () => {
    focusReporter = null;
    // Restart it: the reporter is a long-lived helper, and without this a single
    // crash silently disabled fullscreen and call detection for the whole session.
    if (!quitting) setTimeout(() => { if (!quitting) startFocusReporter(); }, 4000);
  });
  focusReporter.on('error', () => { focusReporter = null; });
};
function stopFocusReporter() { quitting = true; try { focusReporter?.kill(); } catch {} focusReporter = null; focusDigest = null; focusBuffer = ''; }
// Started here, at module scope, rather than from the "ready" IPC handler.
// Calling it from the handler kept failing with "startFocusReporter is not
// defined" even though the declaration is at the top level, and this ordering
// removes the question entirely: everything it needs already exists.
startFocusReporter();


const WRITABLE_SETTINGS = new Set(['minIntervalMs', 'maxIntervalMs', 'idleAfterMs', 'lineDurationMs',
  'profile.userName', 'quiet.manual', 'quiet.fullscreen',
  'speech.cacheFirst', 'speech.cloudAmbient', 'speech.sfx.enabled', 'speech.sfx.tap',
  'speech.sfx.volume', 'speech.volume', 'speech.cloudVoice', 'speech.voiceRate', 'speech.cloudLanguage',
  'enabled', 'gestureMinIntervalMs', 'gestureMaxIntervalMs', 'gestures',
]);

/**
 * Tray menu.
 *
 * The pet window has no taskbar button, so this is the only place the common
 * commands can live without opening the chat panel first. Labels stay in Chinese
 * to match the rest of the UI, and every toggle reflects the live state rather
 * than a remembered preference.
 */
let tray = null;
function buildTrayMenu() {
  if (!tray) return;
  const quietOn = Boolean(quietFlag);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '打开对话面板', click: () => { panelOpen = true; layout(); win.show(); win.focus(); deliver('trayCommand', { type: 'panel', open: true }); } },
    { label: '隐藏对话面板', click: () => { panelOpen = false; layout(); deliver('trayCommand', { type: 'panel', open: false }); } },
    { type: 'separator' },
    { label: '全身显示', type: 'radio', checked: prefs.mode !== 'half', click: () => setDisplayMode('full') },
    { label: '半身显示', type: 'radio', checked: prefs.mode === 'half', click: () => setDisplayMode('half') },
    { type: 'separator' },
    { label: '免打扰', type: 'checkbox', checked: quietOn, click: () => { quietFlag = !quietFlag; void persistQuiet(quietFlag); buildTrayMenu(); } },
    { label: '全屏时不打扰', type: 'checkbox', checked: quietFullscreen, click: () => { quietFullscreen = !quietFullscreen; void persistQuiet(undefined); buildTrayMenu(); } },
    { type: 'separator' },
    { label: autoStartEnabled ? '开机自启（已开启）' : '开机自启（已关闭）', type: 'checkbox', checked: autoStartEnabled,
      click: () => { void writeAutoStart(!autoStartEnabled).then(readAutoStart).then(on => { autoStartEnabled = on; buildTrayMenu(); deliver('autoStart', { ok: true, enabled: on }); }); } },
    { label: '预览全部动作 (Ctrl+Shift+P)', click: () => deliver('trayCommand', { type: 'previewActions' }) },
    { label: remoteServer ? '关闭手机访问' : '开启手机访问', click: () => { if (remoteServer) stopRemoteChat(); else startRemoteChat(); } },
    { label: '手机访问地址（见弹窗）', click: () => { if (!remoteServer) startRemoteChat(); const url = remoteUrl(); shell.openPath(resolve(LOG_DIR, 'remote-chat.txt')); deliver('trayCommand', { type: 'remoteUrl', url }); } },
    { label: '重新连接', click: () => { if (['failed', 'disconnected'].includes(connection.state)) start(); } },
    { label: '打开网页控制台', click: () => { if (!preview) void managementUrl(process.env.PET_TRIAL_CONFIG).then(url => shell.openExternal(url)); } },
    { type: 'separator' },
    { label: '把窗口移到鼠标位置', click: () => { const point = screen.getCursorScreenPoint(); anchor = { x: point.x - prefs.width / 2, y: point.y - 60 }; layout(); savePreferences(); } },
    { label: '开发者工具', click: () => win.webContents.toggleDevTools() },
    { type: 'separator' },
    { label: '退出 AAAAGENT', click: () => app.quit() },
  ]));
}
/** Mirrors the renderer's quiet flag so the tray can show and change it. */
let quietFlag = false, quietFullscreen = true, autoStartEnabled = false;
async function persistQuiet(manual) {
  const file = resolve(root, 'ambient.json');
  try {
    const current = JSON.parse(await readFile(file, 'utf8'));
    if (!current.quiet || typeof current.quiet !== 'object') current.quiet = {};
    if (manual !== undefined) current.quiet.manual = manual === true;
    current.quiet.fullscreen = quietFullscreen === true;
    await writeFile(file, JSON.stringify(current, null, 2) + '\n', 'utf8');
    deliver('trayCommand', { type: 'quiet', manual: current.quiet.manual, fullscreen: current.quiet.fullscreen });
  } catch (error) { logLine('TRAY_QUIET_SAVE_FAILED: ' + (error?.message ?? error)); }
}
function setDisplayMode(mode) {
  if (!['full', 'half'].includes(mode)) return;
  prefs.mode = mode; layout(); savePreferences(); buildTrayMenu();
  deliver('trayCommand', { type: 'display', mode });
}
async function readQuietState() {
  try {
    const quiet = JSON.parse(await readFile(resolve(root, 'ambient.json'), 'utf8'))?.quiet ?? {};
    quietFlag = quiet.manual === true;
    quietFullscreen = quiet.fullscreen !== false;
    buildTrayMenu();
  } catch { /* a missing config just leaves the defaults */ }
}
/**
 * Click-through, driven by the cursor position rather than by events.
 *
 * The renderer-driven version was wrong: setIgnoreMouseEvents(true, {forward:true})
 * forwards mousemove but NOT pointermove, which is what it was listening for. The
 * result was a one-way door - once the window started ignoring the mouse it never
 * heard anything again, so clicks and selection stayed dead until a restart.
 *
 * Polling the cursor from here has no such dependency: the window is hit-tested
 * against the rects the renderer reports, and the state always resolves.
 */
const HIT_POLL_MS = 40;
let hitRects = [], petDragging = false, petIgnore = null, hitPoller = null;
function updatePassthrough() {
  if (!win || win.isDestroyed() || !ready) return;
  const point = screen.getCursorScreenPoint();
  const bounds = win.getBounds();
  const x = point.x - bounds.x, y = point.y - bounds.y;
  // While dragging, never ignore: the pointer leaves the character immediately and
  // the window has to keep receiving the moves the drag is built from.
  const inside = petDragging || hitRects.some(r => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h);
  const ignore = !inside;
  if (ignore === petIgnore) return;
  petIgnore = ignore;
  win.setIgnoreMouseEvents(ignore, { forward: true });
}
/**
 * LAN chat server - phase one of remote chat.
 *
 * The page talks to the SAME renderer the desktop uses. That matters: the
 * relationship state (rapport, the fourteen memory topics, the forgetting curve)
 * lives in the renderer's localStorage. Routing web messages through the renderer
 * means the phone and the desktop share one memory with no migration at all -
 * anything said on the phone is remembered at the desk, and the other way round.
 *
 * Deliberately not public: it binds to the LAN, requires a token, and stays off
 * until the user turns it on from the tray.
 */
const REMOTE_PORT = 62023;
const REMOTE_PAGE_BODY = "<!doctype html><html lang=\"zh-CN\"><head><meta charset=\"utf-8\">\n<meta name=\"viewport\" content=\"width=device-width,initial-scale=1,viewport-fit=cover\">\n<title>AAAAGENT</title><style>\n*{box-sizing:border-box}\nbody{margin:0;height:100dvh;display:flex;flex-direction:column;background:#1b1216;color:#f3e7e9;\n font:15px/1.6 system-ui,-apple-system,\"Segoe UI\",\"Microsoft YaHei\",sans-serif}\nheader{padding:12px 16px;border-bottom:1px solid #8b2f3a80;font-size:13px;color:#b09297}\n#log{flex:1;overflow-y:auto;padding:14px 16px;display:flex;flex-direction:column;gap:10px}\n.b{max-width:82%;padding:9px 13px;border-radius:14px;white-space:pre-wrap;word-break:break-word}\n.me{align-self:flex-end;background:#c8434f;color:#fff;border-bottom-right-radius:4px}\n.her{align-self:flex-start;background:#2a1c21;border:1px solid #8b2f3a66;border-bottom-left-radius:4px}\n.sys{align-self:center;font-size:12px;color:#b09297}\n#bar{display:flex;gap:8px;padding:10px 12px calc(10px + env(safe-area-inset-bottom));border-top:1px solid #8b2f3a80}\n#t{flex:1;padding:11px 13px;border-radius:12px;border:1px solid #8b2f3a80;background:#241820;color:inherit;font:inherit;outline:none}\n#t:focus{border-color:#c8434f}\n#s{padding:0 18px;border-radius:12px;border:0;background:#c8434f;color:#fff;font:inherit;font-weight:600}\n#s:disabled{opacity:.5}\n</style></head><body>\n<header>烛 · 局域网连接</header>\n<div id=\"log\"></div>\n<div id=\"bar\"><input id=\"t\" placeholder=\"说点什么…\" autocomplete=\"off\"><button id=\"s\">发送</button></div>\n<script>\nvar TOKEN=\"__TOKEN__\";\nvar log=document.getElementById('log'),input=document.getElementById('t'),send=document.getElementById('s');\nvar cursor=0,busy=false;\nfunction add(cls,text){var d=document.createElement('div');d.className='b '+cls;d.textContent=text;log.appendChild(d);log.scrollTop=log.scrollHeight;}\nadd('sys','已连接。桌面上的她也记得这里说过的话。');\nasync function poll(){\n  try{\n    var r=await fetch('/api/poll?token='+encodeURIComponent(TOKEN)+'&since='+cursor);\n    var j=await r.json();\n    if(j.messages) for(var i=0;i<j.messages.length;i++){ var m=j.messages[i]; if(m.role!=='user') add('her',m.text); }\n    if(typeof j.cursor==='number') cursor=j.cursor;\n  }catch(e){}\n  setTimeout(poll,1200);\n}\nasync function submit(){\n  var text=input.value.trim(); if(!text||busy)return;\n  input.value=''; add('me',text); busy=true; send.disabled=true;\n  try{ await fetch('/api/send?token='+encodeURIComponent(TOKEN),{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({text:text})}); }\n  catch(e){ add('sys','发送失败，检查网络'); }\n  busy=false; send.disabled=false; input.focus();\n}\nsend.onclick=submit;\ninput.addEventListener('keydown',function(e){if(e.key==='Enter')submit();});\npoll();input.focus();\n</script></body></html>";
let remoteServer = null, remoteToken = null;
const remoteReplies = [];

/**
 * The address to hand to a phone.
 *
 * Order matters: a machine with a VPN (Radmin, Hamachi, Tailscale) has several
 * non-internal IPv4 addresses, and the first one is often the virtual adapter -
 * which the phone cannot reach. Real private ranges are preferred, then anything
 * else, so the link usually just works.
 */
function lanAddress() {
  const candidates = [];
  for (const [name, list] of Object.entries(networkInterfaces())) {
    for (const net of list ?? []) {
      if (net.family !== 'IPv4' || net.internal) continue;
      const virtual = /virtual|vmware|vethernet|hyper-v|radmin|hamachi|tailscale|zerotier|loopback|docker|wsl/i.test(name);
      const priv = /^192\.168\./.test(net.address) ? 0
        : /^10\./.test(net.address) ? 1
        : /^172\.(1[6-9]|2\d|3[01])\./.test(net.address) ? 2
        : 3;
      candidates.push({ address: net.address, rank: priv + (virtual ? 10 : 0) });
    }
  }
  candidates.sort((a, b) => a.rank - b.rank);
  return candidates[0]?.address ?? '127.0.0.1';
}
function remoteUrl() { return 'http://' + lanAddress() + ':' + REMOTE_PORT + '/?token=' + remoteToken; }

function startRemoteChat() {
  if (remoteServer) return { ok: true, running: true, url: remoteUrl() };
  remoteToken = randomUUID().slice(0, 8);
  remoteServer = createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const token = url.searchParams.get('token') ?? req.headers['x-pet-token'];
    if (token !== remoteToken) { res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' }); res.end('需要访问令牌'); return; }
    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(REMOTE_PAGE_BODY.split('__TOKEN__').join(remoteToken));
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/poll') {
      const since = Math.max(0, Number(url.searchParams.get('since') ?? 0) | 0);
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ messages: remoteReplies.slice(since), cursor: remoteReplies.length }));
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/send') {
      let body = '';
      req.on('data', chunk => { body += chunk; if (body.length > 4000) req.destroy(); });
      req.on('end', () => {
        try {
          const text = String(JSON.parse(body)?.text ?? '').trim().slice(0, 500);
          if (text) {
            remoteReplies.push({ role: 'user', text });
            // The renderer owns the conversation and the memory, so it does the work.
            deliver('remoteChat', { text });
          }
        } catch {}
        res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}');
      });
      return;
    }
    res.writeHead(404); res.end();
  });
  remoteServer.on('error', error => { logLine('REMOTE_CHAT_FAILED: ' + (error?.message ?? error)); remoteServer = null; });
  remoteServer.listen(REMOTE_PORT, '0.0.0.0', () => {
    const url = remoteUrl();
    logLine('REMOTE_CHAT: ' + url);
    try {
      mkdirSync(LOG_DIR, { recursive: true });
      writeFileSync(resolve(LOG_DIR, 'remote-chat.txt'),
        '手机访问地址（同一局域网内打开）：\n' + url + '\n\n' +
        '关闭方式：托盘菜单 → 关闭手机访问\n' +
        '地址每次开启都会变化，属正常。\n', 'utf8');
    } catch (error) { logLine('REMOTE_CHAT_URL_WRITE_FAILED: ' + (error?.message ?? error)); }
    buildTrayMenu();
  });
  return { ok: true, running: true, url: remoteUrl() };
}
function stopRemoteChat() {
  try { remoteServer?.close(); } catch {}
  remoteServer = null; remoteReplies.length = 0; buildTrayMenu();
}
function remoteStatus() {
  return remoteServer ? { ok: true, running: true, url: remoteUrl() } : { ok: true, running: false };
}
/** The renderer hands her answers back here for the browser to collect. */
function pushRemoteReply(text) {
  if (!remoteServer || typeof text !== 'string' || !text.trim()) return;
  remoteReplies.push({ role: 'pet', text: text.trim() });
  if (remoteReplies.length > 200) remoteReplies.splice(0, remoteReplies.length - 200);
}
function createTray() {
  if (tray || preview || smoke) return;
  const icon = resolve(here, '..', '..', '..', 'aaaagent.ico');
  try {
    tray = new Tray(existsSync(icon) ? nativeImage.createFromPath(icon) : nativeImage.createEmpty());
  } catch (error) { logLine('TRAY_FAILED: ' + (error?.message ?? error)); tray = null; return; }
  tray.setToolTip('AAAAGENT 桌面宠物');
  tray.on('double-click', () => { panelOpen = !panelOpen; layout(); if (panelOpen) { win.show(); win.focus(); } deliver('trayCommand', { type: 'panel', open: panelOpen }); });
  buildTrayMenu();
  // One line so a missing tray icon is diagnosable from the log at all: a Tray
  // that fails to appear otherwise leaves no trace anywhere.
  logLine('TRAY: ready');
}

ipcMain.on('pet:desktop', (event, value) => {
  if (!trusted(event) || !value || value.generation !== connection.generation || connection.state !== 'ready' || !value.message || typeof value.message !== 'object') return;
  const type = value.message.command?.type;
  if (['start_voice', 'click_invitation'].includes(type)) voiceRequested = true;
  if (['finish_voice', 'cancel', 'submit_text'].includes(type)) voiceRequested = false;
  connection.send(value.message, value.generation);
});
ipcMain.on('pet:shell', (event, value) => {
  if (!trusted(event) || !value || typeof value !== 'object') return;  switch (value.type) {
    case 'ready':
      if (ready) return;
      ready = true; logLine('READY'); layout();
      if (!hitPoller) hitPoller = setInterval(updatePassthrough, HIT_POLL_MS); deliver('hotkeyConfig', { code: prefs.hotkey }); replayPresentationPolicy(); start(); createTray();
      void readQuietState(); void readAutoStart().then(on => { autoStartEnabled = on; buildTrayMenu(); deliver('autoStart', { ok: true, enabled: on }); });
      break;
    case 'panel': panelOpen = value.open === true; layout(); if (panelOpen) win.focus(); break;
    case 'focus': win.focus(); break;
    case 'drag':
      if (Number.isFinite(value.dx) && Number.isFinite(value.dy) && Math.abs(value.dx) < 2000 && Math.abs(value.dy) < 2000) {
        anchor.x += value.dx; anchor.y += value.dy; layout(); savePreferences();
      } break;
    case 'set_display': if (['full', 'half'].includes(value.mode)) { prefs.mode = value.mode; layout(); savePreferences(); } break;
    case 'resize_model':
      if (value.phase === 'begin') beforeResize ??= prefs.width;
      else if (beforeResize !== undefined) {
        if (value.phase === 'cancel') { prefs.width = beforeResize; beforeResize = undefined; }
        else if (['update', 'commit'].includes(value.phase) && Number.isFinite(value.width)) {
          prefs.width = Math.max(72, Math.min(720, value.width));
          if (value.phase === 'commit') { beforeResize = undefined; savePreferences(); }
        }
        layout();
      } break;
    case 'set_hotkey': if (validHotkey(value.code)) { prefs.hotkey = value.code; savePreferences(); deliver('hotkeyConfig', { code: prefs.hotkey }); } break;
    case 'reconnect': if (['failed', 'disconnected'].includes(connection.state)) start(); break;
    case 'disconnect': if (value.generation === connection.generation) connection.close(); break;
    case 'open_management':
      if (preview) { deliver('managementResult', { ok: false }); break; }
      void managementUrl(process.env.PET_TRIAL_CONFIG).then(url => shell.openExternal(url)).then(() => deliver('managementResult', { ok: true })).catch(() => deliver('managementResult', { ok: false })); break;
    // Click-through. The pet window is transparent and frameless, so without this
    // it swallows every click in a large rectangle around the character. Ignoring
    // mouse events forwards the click to whatever is underneath; the renderer
    // turns ignoring back off as soon as the pointer is over the model or the UI.
    case 'passthrough': {
      const ignore = value.ignore === true;
      if (win.petIgnoreMouse !== ignore) {
        win.petIgnoreMouse = ignore;
        win.setIgnoreMouseEvents(ignore, { forward: true });
      }
      break;
    }
    // The renderer reports what is currently clickable, in window coordinates.
    // It is re-sent periodically so a layout change or a new bubble can never
    // leave a stale hit region behind.
    case 'hit_rects': {
      if (Array.isArray(value.rects)) {
        hitRects = value.rects
          .filter(r => r && Number.isFinite(r.x) && Number.isFinite(r.y) && Number.isFinite(r.w) && Number.isFinite(r.h) && r.w > 0 && r.h > 0)
          .slice(0, 40);
      }
      petDragging = value.dragging === true;
      updatePassthrough();
      break;
    }
    case 'remote_chat': {
      if (value.action === 'start') deliver('remoteChatStatus', startRemoteChat());
      else if (value.action === 'stop') { stopRemoteChat(); deliver('remoteChatStatus', remoteStatus()); }
      else deliver('remoteChatStatus', remoteStatus());
      break;
    }
    case 'remote_reply': pushRemoteReply(value.text); break;
    // LAN chat diagnostics. The reply path failed once with no trace at all, which
    // made it impossible to tell where it stopped.
    case 'remote_trace': logLine('REMOTE_TRACE ' + String(value.step ?? '?') + ' ' + String(value.detail ?? '').slice(0, 60)); break;
    // 面板右下角拖出来的尺寸。存进偏好吗，布局时按它算抽屉大小。
    case 'panel_resize': {
      if (Number.isFinite(value.width)) prefs.drawerWidth = Math.max(280, Math.min(900, Math.round(value.width)));
      if (Number.isFinite(value.height)) prefs.drawerHeight = Math.max(240, Math.min(1000, Math.round(value.height)));
      savePreferences();
      logLine('panel_resize 收到 ' + value.width + 'x' + value.height +
        ' → prefs ' + prefs.drawerWidth + 'x' + prefs.drawerHeight);
      layout();
      break;
    }
    case 'quit': app.quit(); break;
    // The panel's "打开日志" button. Opening the folder rather than the file means the
    // rotated .log.1 is reachable too, which is often the one that matters.
    case 'open_log': {
      try { mkdirSync(LOG_DIR, { recursive: true }); void shell.openPath(LOG_DIR); }
      catch (error) { logLine('OPEN_LOG_FAILED: ' + (error?.message ?? error)); }
      break;
    }
    // Auto-start toggle for the settings panel.
    case 'autostart': {
      if (value.action === 'set') {
        void writeAutoStart(value.enabled === true)
          .then(() => readAutoStart())
          .then(on => deliver('autoStart', { ok: true, enabled: on }))
          .catch(error => { logLine(`AUTOSTART_FAILED: ${error?.message ?? error}`); deliver('autoStart', { ok: false, enabled: false }); });
        break;
      }
      void readAutoStart().then(on => deliver('autoStart', { ok: true, enabled: on }));
      break;
    }
    // The pet's own settings panel. It edits desktop/ambient.json in place, which
    // is what the user previously had to do by hand (and then remember to run
    // refresh:runtime and restart).
    case 'ambient_config': {
      const file = resolve(root, 'ambient.json');
      // Accept either name. The toolbar used to send 'settings' while this side
            // read 'patch', so those saves were skipped in silence and the value
            // reverted on the next reload.
            const patch = value.patch ?? value.settings;
            if (value.action === 'save' && patch && typeof patch === 'object') {
        void (async () => {
          try {
            const current = JSON.parse(await readFile(file, 'utf8'));
            for (const [key, raw] of Object.entries(patch)) {
              // Only the documented knobs are writable, so a malformed message
              // cannot rewrite the dialogue library.
              if (!WRITABLE_SETTINGS.has(key)) continue;
              const parts = key.split('.');
              let node = current;
              for (const part of parts.slice(0, -1)) {
                if (!node[part] || typeof node[part] !== 'object') node[part] = {};
                node = node[part];
              }
              node[parts[parts.length - 1]] = raw;
            }
            await writeFile(file, JSON.stringify(current, null, 2) + '\n', 'utf8');
            deliver('ambientConfig', { ok: true, action: 'save' });
          } catch (error) {
            process.stderr.write(`AMBIENT_CONFIG_SAVE_FAILED: ${error?.message ?? error}\n`);
            deliver('ambientConfig', { ok: false, action: 'save' });
          }
        })();
        break;
      }
      void readFile(file, 'utf8').then(
        text => deliver('ambientConfig', { ok: true, action: 'load', config: JSON.parse(text) }),
        error => deliver('ambientConfig', { ok: false, action: 'load', error: String(error?.message ?? error) }));
      break;
    }
    // Real system-wide state, polled by the renderer.
    //
    // `getSystemIdleTime()` counts seconds since the last keyboard or mouse input
    // in ANY application. The renderer previously judged idleness from its own UI
    // events only, so working in another window looked like being away and the pet
    // kept interrupting exactly when the user was busiest. The cursor position
    // drives eye contact, which is the cheapest way to look alive.
    case 'system_state': {
      let cursor = null;
      try { cursor = screen.getCursorScreenPoint(); } catch {}
      let bounds = null;
      try { bounds = win?.getBounds() ?? null; } catch {}
      // The work area lets the renderer scale eye tracking to the whole desktop
      // instead of saturating a few hundred pixels away from the window.
      let workArea = null;
      try { workArea = screen.getDisplayNearestPoint(cursor ?? { x: 0, y: 0 }).workAreaSize; } catch {}
      deliver('systemState', { idleSeconds: powerMonitor.getSystemIdleTime(), cursor, bounds, workArea });
      break;
    }
    // Local offline speech. The machine's own Chinese speech engine produces no
    // audio at all (Microsoft's OneCore voice synthesizes an empty stream), so a
    // third-party engine is invoked here instead. The resulting WAV is returned
    // to the renderer, which plays it through its own AudioContext.
    // Cached ambient line. Missing clips answer ok:false so the renderer can fall
    // back to a live cloud request; a hit plays entirely offline.
    case 'speak_cached': {
      const requestId = typeof value.requestId === 'string' ? value.requestId : null;
      const text = typeof value.text === 'string' ? value.text.trim() : '';
      if (!requestId || !text || text.length > 400) break;
      const emotion = typeof value.emotion === 'string' ? value.emotion : 'neutral';
      void readCachedSpeech(text).then(async cached => {
        if (cached) { deliver('localSpeech', { requestId, ok: true, audioBase64: cached.toString('base64'), cached: true }); return; }
        // Miss: synthesize once, keep it, and play it. `autoCache` is false in
        // preview so a preview run never spends anything.
        if (value.autoCache === false) { deliver('localSpeech', { requestId, ok: false, missing: true }); return; }
        try {
          const audio = await synthesizeSpeech(text);
          deliver('localSpeech', { requestId, ok: true, audioBase64: audio.toString('base64'), cached: false });
        } catch (error) {
          process.stderr.write(`SPEECH_SYNTH_FAILURE: ${error?.message ?? error}\n`);
          deliver('localSpeech', { requestId, ok: false, missing: true });
        }
      }, () => deliver('localSpeech', { requestId, ok: false, missing: true }));
      break;
    }
    case 'speak_local': {
      const requestId = typeof value.requestId === 'string' ? value.requestId : null;
      const text = typeof value.text === 'string' ? value.text.trim() : '';
      if (!requestId || !text || text.length > 400) break;
      void speakWithLocalEngine(text, value)
        .then(audio => deliver('localSpeech', { requestId, ok: true, audioBase64: audio.toString('base64') }))
        .catch(error => { process.stderr.write(`LOCAL_SPEECH_FAILURE: ${error?.message ?? error}\n`); deliver('localSpeech', { requestId, ok: false }); });
      break;
    }
  }
});
ipcMain.on('pet:diagnostic', (event, value) => {
  if (!trusted(event) || !value) return;
  // Don't copy arbitrary renderer text, chat or media into diagnostic logs, but
  // DO keep the JS error message: "script-error" on its own made a real failure
  // impossible to diagnose from the log.
  if (['model-ready', 'model-error', 'script-error', 'promise-error'].includes(value.type)) {
    const detail = typeof value.message === 'string' ? ' ' + value.message.slice(0, 200) : '';
    logLine(`Renderer: ${value.type}${detail}`); process.stderr.write(`Renderer: ${value.type}${detail}\n`);
  } else if (value.type === 'model-fingerprint-debug') {
    // MODEL_FP_DEBUG - temporary. Two fingerprints disagreeing says nothing about
    // where, so every input is logged: the per-file digests, the binding length and
    // both aggregate values.
    logLine(`FP computed=${value.computed}`);
    logLine(`FP expected=${value.expected}`);
    logLine(`FP binding length=${value.bindingLength} files=${value.fileCount}`);
    for (const item of value.files ?? []) logLine(`FP   ${item}`);
    process.stderr.write(`FP computed=${value.computed} expected=${value.expected}\n`);
  } else if (value.type === 'model-fingerprint-mismatch') {
    // No longer fatal: the catalog is stale, so its entries are skipped and loading
    // continues. Logged because a silent downgrade would hide a real model swap.
    logLine('Renderer: model-fingerprint-mismatch - catalog is stale, continuing');
    process.stderr.write('Renderer: model-fingerprint-mismatch\n');
  } else if (value.type === 'model-parameter-missing') {
    // The first parameter this rig lacks. One line is enough to diagnose a model
    // change without flooding the log.
    logLine('Renderer: model-parameter-missing ' + String(value.message ?? '').slice(0, 60));
  } else if (value.type === 'model-switched') {
    logLine('Renderer: model-switched ' + value.from + ' -> ' + value.to);
  } else if (value.type === 'policy-model-adapted') {
    // 换模型后策略被适配：保留了多少个自动项。
    logLine('Renderer: policy-model-adapted kept=' + value.kept +
      ' (' + value.expected + ' vs ' + value.received + ')');
  } else if (value.type === 'render-rate') {
    // Only sent when the frame rate is actually poor; useful for diagnosing
    // "it feels choppy" reports without logging a healthy session.
    logLine(`Renderer: render-rate ${value.fps} fps`); process.stderr.write(`Renderer: render-rate ${value.fps} fps\n`);
  }
});

// Do not await readiness at module scope: Electron must finish loading this ESM
// entry before it can emit ready. Keep initialization in the ready callback.
void app.whenReady().then(async () => {
await mkdir(app.getPath('userData'), { recursive: true });
prefsFile = resolve(app.getPath('userData'), 'windows-display.json');
try {
  const saved = JSON.parse(await readFile(prefsFile, 'utf8'));
  if (['full', 'half'].includes(saved.mode)) prefs.mode = saved.mode;
  if (Number.isFinite(saved.width)) prefs.width = Math.max(72, Math.min(720, saved.width));
  if (validHotkey(saved.hotkey)) prefs.hotkey = saved.hotkey;
  if (Number.isFinite(saved.anchor?.x) && Number.isFinite(saved.anchor?.y)) anchor = saved.anchor;
} catch {}
const area = screen.getPrimaryDisplay().workArea;
anchor ??= { x: area.x + area.width - 220, y: area.y + Math.max(0, area.height - 430) };
win = new BrowserWindow({ title: preview ? 'AAAAGENT · Offline preview' : 'AAAAGENT', width: 380, height: 376,
  frame: false, transparent: true, backgroundColor: '#00000000', alwaysOnTop: true, hasShadow: false, resizable: false, show: !smoke,
  webPreferences: { preload: resolve(here, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true,
    partition: 'aaaagent-desktop', backgroundThrottling: false, autoplayPolicy: 'no-user-gesture-required' } });
Menu.setApplicationMenu(Menu.buildFromTemplate([{ label: 'AAAAGENT', submenu: [
  { label: 'Reload', accelerator: 'Ctrl+R', click: () => { connection.close(); ready = false; win.webContents.reload(); } },
  { label: 'Developer tools', accelerator: 'Ctrl+Shift+I', click: () => win.webContents.toggleDevTools() }, { role: 'quit' }
] }, { role: 'editMenu' }]));
await win.webContents.session.protocol.handle('pet', request => assetResponse(root, request.url));
const mediaAllowed = (wc, permission, origin, types, mainFrame) => !preview && wc === win.webContents && permission === 'media'
  && origin?.startsWith('pet://app/') && mainFrame !== false && types.length > 0
  && types.every(type => type === 'audio' ? voiceRequested || wakeRequested : type === 'video' && voiceRequested);
win.webContents.session.setPermissionRequestHandler((wc, permission, callback, details) => callback(mediaAllowed(wc, permission, details.requestingUrl, details.mediaTypes || [], details.isMainFrame)));
win.webContents.session.setPermissionCheckHandler((wc, permission, origin, details) => mediaAllowed(wc, permission, origin + '/', [details.mediaType], details.isMainFrame));
win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
win.webContents.on('will-navigate', event => event.preventDefault());
win.webContents.on('will-attach-webview', event => event.preventDefault());
win.webContents.on('render-process-gone', () => { ready = false; connection.close(); });
win.on('blur', () => { if (beforeResize !== undefined) { prefs.width = beforeResize; beforeResize = undefined; layout(); } deliver('hotkeyEvent', { type: 'cancel' }); });
screen.on('display-metrics-changed', layout); screen.on('display-removed', layout);
app.on('second-instance', () => { win.show(); win.focus(); });
let quitDrained = false, quitPending = false;
// Declared here, above the IPC handlers, because startFocusReporter() is called
// from one of them: leaving these in a `const`/`let` further down put them in the
// temporal dead zone, so the helper silently never started.

app.on('before-quit', event => {
  if (quitDrained) return;
  event.preventDefault();
  if (quitPending) return;
  quitPending = true;
  // Keep pipes and the Electron event loop alive until backend EOF cleanup
  // finishes. Otherwise Windows can leave backend.lock after the window closes.
  void connection.close().then(() => writes).finally(() => { quitDrained = true; app.quit(); });
});
app.on('will-quit', () => { stopRemoteChat(); if (hitPoller) { clearInterval(hitPoller); hitPoller = null; } stopFocusReporter(); try { tray?.destroy(); } catch {} tray = null; });
app.on('window-all-closed', () => app.quit());
layout();
await win.loadURL('pet://app/index.html');
if (inspect) win.webContents.openDevTools({ mode: 'detach' });
if (smoke) {
  try {
    // Exercise the real Electron renderer in an offscreen window; no account or device access.
    const deadline = Date.now() + 20000;
    let loaded = false;
    while (Date.now() < deadline) {
      loaded = await win.webContents.executeJavaScript("!!window.petBridge && document.getElementById('loading').hidden && !document.getElementById('send').disabled");
      if (loaded) break;
      await new Promise(done => setTimeout(done, 200));
    }
    if (!loaded) throw Error('Renderer or offline backend did not become ready: ' + await win.webContents.executeJavaScript("document.getElementById('status').textContent"));
    await win.webContents.executeJavaScript("document.getElementById('open').click();document.getElementById('text').value='Windows bridge smoke test';document.getElementById('form').requestSubmit();");
    await new Promise(done => setTimeout(done, 400));
    const echoed = await win.webContents.executeJavaScript("document.getElementById('reply').textContent.includes('Offline preview received')");
    if (!echoed) throw Error('Text did not complete a backend round trip');
    console.log('WINDOWS_SMOKE_OK: Live2D renderer, isolated preload, backend round trip, panel layout.');
    if (option('--screenshot')) {
      win.showInactive();
      await new Promise(done => setTimeout(done, 600));
      const visible = await win.webContents.executeJavaScript("!document.getElementById('drawer').hidden && getComputedStyle(document.getElementById('drawer')).opacity === '1'");
      if (!visible) throw Error('Chat drawer is not visible');
      await writeFile(resolve(option('--screenshot')), (await win.webContents.capturePage()).toPNG());
    }
  } catch (error) { console.error(error.message); process.exitCode = 1; }
  app.quit();
}
}).catch(error => { console.error(error.message); app.exit(1); });
