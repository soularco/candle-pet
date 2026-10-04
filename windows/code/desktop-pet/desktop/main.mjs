import {WakeController} from './wake-controller.mjs';
import { COMPANION_LABEL, isProductCharacter } from '../contracts/character.ts';
import { CaptureFeedback } from './capture-feedback.mjs';
import { WorkRecords } from './work-records.mjs';
import { WorkCard } from './work-card.mjs';
import { installDisplayControls } from './display-controls.mjs';
import { toDeviceFailure, deviceFailureMessage } from '../media/capture-errors.ts';
import { PressToTalk, validVoiceKey } from './press-to-talk.ts';
import { DesktopChatLog } from './chat-log.ts';
import { DesktopViewState, DesktopConnectionState, scopeEquals } from './view-state.ts';
import { JellyfishRenderer } from './cubism-renderer.mjs';
import { AmbientScheduler, loadAmbientConfig } from './ambient.mjs';
import { LocalSpeaker } from './speech.mjs';
import { BrowserPlaybackDriver } from '../media/browser-playback.ts';
import { DesktopPlaybackController } from './playback-controller.ts';
import { BrowserCaptureDriver } from '../media/browser-capture.ts';
import { DESKTOP_BRIDGE_VERSION } from '../contracts/desktop-bridge.ts';
const $ = id => document.getElementById(id);
const native = (name, value) => window.desktopHost ? window.desktopHost.postMessage(name, value) : window.webkit?.messageHandlers[name]?.postMessage(value);
const report = value => native('diagnostic', value);
const connection = new DesktopConnectionState();
const send = (value, generation = connection.generation) => {
  if (connection.current(generation) && connection.connected) native('desktop', { generation, message: value });
};
const view = new DesktopViewState();
const workSpeechView=new DesktopViewState();
let workNotice=null,workSpeechBlocked=false,backendSessionId=null;
const spokenNotices=new Set();
const chat = new DesktopChatLog();
const captureFeedback=new CaptureFeedback($);let captureFeedbackToken;
let wakeFeedbackToken,wakeRequestId=null,wakeUI={phase:'off',enabled:false};
const wakeLabels={connecting:'连接中',waiting:'等待唤醒',listening:'正在听',submitting:'正在提交',replying:'等待唤醒'};
const wake=new WakeController({
 createCapture:async options=>{const module=await import('../media/wake/browser-capture.ts');return new module.BrowserWakeCapture({...options,workletModuleUrl:new URL('./wake-recorder-worklet.js',import.meta.url)});},send,
 onState:state=>{wakeUI=state;const label=wakeLabels[state.phase];if(state.enabled&&label){const mode={label,phase:state.phase,keepLabel:true};if(wakeFeedbackToken===undefined||!captureFeedback.active)wakeFeedbackToken=captureFeedback.start(mode);else captureFeedback.configure(wakeFeedbackToken,mode);}else{if(wakeFeedbackToken!==undefined)captureFeedback.stop(wakeFeedbackToken);wakeFeedbackToken=undefined;}Promise.resolve().then(()=>renderUI());},
 onLevel:level=>{if(wakeFeedbackToken!==undefined)captureFeedback.level(wakeFeedbackToken,level);},
 onWake:wakeHit=>command({type:'start_voice',wakeHit},{wakeInput:true}),
 onFinish:()=>command({type:'finish_voice'},{wakeInput:true}),
 onCancel:()=>{if(wakeRequestId){wakeRequestId=null;command({type:'cancel'},{wakeInput:true});}}
});
const records=new WorkRecords({get:$,action:a=>work.action(a),onClose:()=>markVisibleWork(),onSelect:id=>work.focusRecord(id)});
const work = new WorkCard({get:$,send,open:()=>panel(true),onState:s=>records.receive(s),onRecords:origin=>records.show(origin),onToggle:()=>{markVisibleWork();restoreSelectedSource();requestedSourceFocus=true;lastUI='';renderUI();}});
let companionRoute = null;
let inputScope = null, awaitingTranscript = false;
let lastInputRow = null, lastWorkOpen = false, preserveReading = false, requestedSourceFocus=false,lastSourceId=null;
const expandedInputs=new Set();
let textRequestId = null;
let inputFocusEpoch=0, interactionFocusEpoch=0, routeFocusEpoch=0;
let composing = false;
let presentationPolicy=null;
function applyPresentationPolicy(){
  if(!renderer?.ready)return;
  const policy=presentationPolicy??{modelId:'disconnected',revision:0,enabledIds:[]};
  const applied=renderer.setAutomaticPolicy(policy);
  if(presentationPolicy)report({type:'presentation-policy',modelId:policy.modelId,revision:policy.revision,enabledCount:policy.enabledIds.length,applied:applied===true});
}
let renderer, capturing, captureAllowed = false, voicePhase = 'idle';
// Ambient liveliness: preset small talk plus a short action, chosen by time of
// day. It is created after the config loads and stays null when disabled.
let ambient = null, ambientSpeechEnabled = false;
// Declared at module scope because quietReason() below runs outside the init
// block; a `let` inside that block is not visible here and threw
// "ambientConfig is not defined" on every frame.
let ambientConfig = null;
// Pending exchange: the pet said something that expects an answer. A tap plays
// `reply`; staying quiet past the deadline plays `ignored`. This is what makes
// the dialogue feel like a conversation instead of unrelated announcements.
let ambientWaiting = null, ambientWaitTimer = null, ambientRemindTimer = null;
// Real system-wide state, refreshed by polling the main process. `idleSeconds`
// counts keyboard/mouse inactivity across every application.
let systemIdleSeconds = 0, systemStateTimer = null;
// What the user has in front of them, reported by the focus helper: window title,
// process name, and whether it is a true fullscreen window.
let foreground = null;
// When the pointer last moved. While it is moving, idle gestures must not take
// the eyes over: the user is watching the pet follow the cursor.
let cursorMovedAt = 0, lastCursor = null;
// Consecutive pokes, so repeated tapping escalates instead of looping one reply.
let pokeStreak = 0, lastPokeAt = 0;
// Remembers how long the user had been away, so returning can be greeted.
let welcomeBackAt = 0, wasAway = false;
// The pet only starts small talk after the user has genuinely stepped back.
// Without this it kept talking while somebody was typing in another window.
const SPEAK_WHEN_IDLE_SECONDS = 12;
/**
 * Should the pet hold its tongue right now?
 *
 * Two things make small talk unwelcome: a true fullscreen window (a game, a
 * film, a presentation) and an application where an interruption is rude even
 * when it is windowed (a call, a recording, a slideshow). Both are configurable
 * from ambient.json so the list can be tuned without touching code.
 */
function quietReason() {
  const quiet = ambientConfig?.quiet ?? {};
  if (quiet.manual === true) return 'manual';
  if (foreground?.fullscreen && quiet.fullscreen !== false) return 'fullscreen';
  const process = String(foreground?.process ?? '').toLowerCase();
  if (process) {
    const list = (Array.isArray(quiet.apps) ? quiet.apps : []).map(value => String(value).toLowerCase());
    if (list.includes(process)) return 'app:' + process;
  }
  return null;
}
// Remembered across restarts: how the user has been responding, plus flags that
// let a later line refer back to something that happened earlier.
const RAPPORT_KEY = 'aaaagent-ambient-rapport';
const rapportState = (() => {
  try {
    const parsed = JSON.parse(localStorage.getItem(RAPPORT_KEY) ?? 'null');
    if (parsed && typeof parsed === 'object')
      return { streak: parsed.streak | 0, answered: parsed.answered | 0, ignored: parsed.ignored | 0,
        flags: parsed.flags && typeof parsed.flags === 'object' ? parsed.flags : {},
        // Long-term memory. Survives restarts and never expires on its own, so a
        // topic from days ago is still available.
        memory: parsed.memory && typeof parsed.memory === 'object' ? parsed.memory : {} };
  } catch {}
  return { streak: 0, answered: 0, ignored: 0, flags: {}, memory: {} };
})();
function saveRapport() { try { localStorage.setItem(RAPPORT_KEY, JSON.stringify(rapportState)); } catch {} ambient?.setRapport?.(rapportState); }
// Assigned with the scheduler; also called when a real turn starts.
let clearWaiting = () => {};
// Assigned once the scheduler exists; the pointer handler above can call it safely.
let reactToPart = () => {};
// Kept as an alias so the few existing call sites keep working.
let reactToTap = part => reactToPart(part);
// Local (free) speech. Used for ambient small talk, and as the fallback for chat
// replies when the cloud voice produced no audio for the turn.
let speaker = null, replySpeechTimer = null, lastSpokenReply = '';
// Offline speech: eSpeak NG is invoked by the main process and the WAV comes
// back here to be played with the page's own AudioContext.
let localSpeechAudio = null, localSpeechContext = null, localSpeechRequest = null, localSpeechFallback = null, localSpeechEmotion = null;
let localSpeechAnalyser = null, localSpeechSamples = null, localSpeechStarted = 0, localSpeechEnds = 0, speechMouthLevel = 0;
function speakLocally(text, engineVoice, engineSpeed) {
  if (!connection.connected) return false;
  localSpeechRequest = crypto.randomUUID();
  native('shell', { type: 'speak_local', requestId: localSpeechRequest, text, volume: Number(ambientConfig?.speech?.volume ?? 1),
    ...(engineVoice === undefined ? {} : { voice: engineVoice }),
    ...(engineSpeed === undefined ? {} : { speed: engineSpeed }) });
  return true;
}
/** Ask the host for a pre-synthesized clip; it answers with the text when missing. */
/** 粗略判断一句话的情绪，用来给缓存配音挑音色。 */
function emotionForText(text) {
  const s = String(text ?? '');
  if (/[！!]{1,}|哈哈|嘿嘿|开心|太好了/.test(s)) return 'cheerful';
  if (/[？?]$|吗$|呢$/.test(s)) return 'curious';
  if (/对不起|抱歉|难过|伤心|唉/.test(s)) return 'gentle';
  return 'neutral';
}
function requestCachedSpeech(text, emotion, options = {}) {
  localSpeechRequest = crypto.randomUUID();
  localSpeechFallback = text;
  localSpeechEmotion = emotion ?? null;
  native('shell', { type: 'speak_cached', requestId: localSpeechRequest, text,
    ...(emotion ? { emotion } : {}),
    // Preview must never spend anything on synthesis.
    autoCache: options.autoCache !== false });
  return true;
}
/**
 * How each mood colours a line at playback time. Adjusting the cached clip is
 * free and instant, so the same recording can sound cheerful, sleepy or shy
 * without re-synthesizing (and re-downloading) anything.
 */
/**
 * Fine-tuning only. The timbre has to stay recognisably the same person, so these
 * are deliberately small: larger swings (0.85 rate, -160 cents) made the pet sound
 * like somebody else rather than the same girl in a different mood.
 */
/**
 * Fine-tuning only, and deliberately tiny.
 *
 * playbackRate shifts pitch as well as speed, so a wide range made the same clip
 * sound like a different speaker from one mood to the next. Mood is now carried
 * mostly by level, with at most 2% speed and 25 cents of pitch.
 */
const EMOTION_VOICE = {
  neutral:  { rate: 1.00, detune: 0,   gain: 1.00 },
  happy:    { rate: 1.02, detune: 20,  gain: 1.00 },
  cheerful: { rate: 1.02, detune: 25,  gain: 1.00 },
  tired:    { rate: 0.99, detune: -20, gain: 0.96 },
  sleepy:   { rate: 0.98, detune: -25, gain: 0.92 },
  shy:      { rate: 0.99, detune: -12, gain: 0.96 },
  sad:      { rate: 0.99, detune: -18, gain: 0.96 },
  angry:    { rate: 1.01, detune: 12,  gain: 1.00 },
  calm:     { rate: 1.00, detune: -6,  gain: 0.98 },
};
/**
 * Short procedural sounds. These are synthesized on the fly rather than shipped
 * as files: no assets to manage, no download, and they match the voice volume
 * because they share the same AudioContext.
 */
function playSfx(kind) {
  try {
    if (!localSpeechContext) localSpeechContext = new AudioContext();
    const ctx = localSpeechContext;
    if (ctx.state === 'suspended') void ctx.resume();
    const now = ctx.currentTime;
    // One master level for the clicks, applied to every blip they are made of.
    const sfxLevel = Number(ambientConfig?.speech?.sfx?.volume);
    const master = Number.isFinite(sfxLevel) ? Math.max(0, Math.min(1, sfxLevel)) : .7;
    const blip = (type, freq, at, length, peak, sweep) => {
      const osc = ctx.createOscillator(), gain = ctx.createGain();
      osc.type = type; osc.frequency.setValueAtTime(freq, now + at);
      if (sweep) osc.frequency.exponentialRampToValueAtTime(sweep, now + at + length);
      gain.gain.setValueAtTime(0, now + at);
      gain.gain.linearRampToValueAtTime(peak * master, now + at + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + at + length);
      osc.connect(gain); gain.connect(ctx.destination);
      osc.start(now + at); osc.stop(now + at + length + 0.02);
    };
    if (kind === 'tap') blip('sine', 660, 0, 0.10, 0.10, 990);
    else if (kind === 'attention') { blip('sine', 720, 0, 0.12, 0.07, 900); blip('sine', 1080, 0.09, 0.16, 0.06); }
    else if (kind === 'chime') { blip('triangle', 880, 0, 0.35, 0.06); blip('triangle', 1320, 0.02, 0.30, 0.04); }
    else if (kind === 'soft') blip('sine', 420, 0, 0.18, 0.05, 300);
  } catch {}
}
/**
 * Turns what the user actually said into remembered context.
 *
 * The scripted small talk and the real chat used to be two unrelated systems:
 * telling the chat "我困了" did nothing for the ambient lines. Scanning the
 * user's own messages for a few strong signals lets the ambient side refer to
 * them later through the same `requires` flags the time-continuity lines use.
 */
const CHAT_SIGNALS = [
  [/困|好累|疲惫|睡了|熬夜|通宵/, 'stayedUpLate'],
  [/加班|赶工|deadline|做不完/i, 'overworked'],
  [/生病|不舒服|头疼|感冒|发烧|难受/, 'unwell'],
  [/考试|面试|答辩|汇报|演示/, 'bigDay'],
  [/开心|太好了|终于|哈哈|好耶|成功/, 'goodMood'],
  [/烦|难过|崩溃|压力|焦虑|生气/, 'badMood'],
];
function learnFromChat(text) {
  if (typeof text !== 'string' || !text.trim()) return;
  const hits = [];
  for (const [pattern, flag] of CHAT_SIGNALS) if (pattern.test(text)) hits.push(flag);
  if (hits.length === 0) return;
  for (const flag of hits) rapportState.flags[flag] = Date.now();
  saveRapport();
  console.info('[ambient] 从聊天记住:', hits.join(', '));
}
/**
 * Picks the mood a line should be read in: an explicit `emotion` wins, otherwise
 * the action that accompanies it implies one, otherwise the pet's overall mood
 * colours it. This is what makes "困了" sound sleepy and "嘿嘿" sound pleased
 * without recording every line twice.
 */
const EMOTION_BY_ACTION = {
  seqSleepy: 'sleepy', sleepy: 'sleepy', yawn: 'sleepy',
  seqTired: 'tired', tired: 'tired', sigh: 'tired', stretch: 'tired',
  seqCheer: 'cheerful', bounce: 'cheerful', perk: 'cheerful',
  seqGreet: 'happy', happyGreeting: 'happy', raiseHand: 'happy',
  seqShy: 'shy', shy: 'shy', pout: 'shy',
  seqAngry: 'angry', angryFace: 'angry', grumpy: 'angry', furrowBrow: 'angry', shake: 'angry',
  gloomy: 'sad', deadEyes: 'sad',
  blank: 'calm', breathe: 'calm', seqThink: 'calm', seqCool: 'calm', listen: 'calm',
};
function lineEmotion(event) {
  if (event?.emotion) return event.emotion;
  const byAction = EMOTION_BY_ACTION[event?.action];
  if (byAction) return byAction;
  // Nothing specific: let the overall mood colour it, so a pet that keeps being
  // ignored sounds a little softer and one that is answered often sounds warmer.
  const mood = ambient?.mood;
  if (mood === 'warm') return 'happy';
  if (mood === 'reserved') return 'calm';
  return 'neutral';
}
async function playLocalSpeech(audioBase64, emotion) {
  try {
    if (!localSpeechContext) localSpeechContext = new AudioContext();
    if (localSpeechContext.state === 'suspended') await localSpeechContext.resume();
    const bytes = Uint8Array.from(atob(audioBase64), char => char.charCodeAt(0));
    const decoded = await localSpeechContext.decodeAudioData(bytes.buffer);
    localSpeechAudio?.stop();
    if (!localSpeechAnalyser) {
      localSpeechAnalyser = localSpeechContext.createAnalyser();
      localSpeechAnalyser.fftSize = 512;
      localSpeechSamples = new Uint8Array(localSpeechAnalyser.fftSize);
      // The analyser must sit on the path to the destination, otherwise Web Audio
      // never pulls it and every reading stays at zero.
      localSpeechAnalyser.connect(localSpeechContext.destination);
    }
    const source = localSpeechContext.createBufferSource();
    source.buffer = decoded;
    // Mood is expressed by re-playing the cached clip, not by re-recording it.
    const tone = EMOTION_VOICE[emotion] ?? EMOTION_VOICE.neutral;
    // The user's overall speed preference multiplies the per-mood fine tuning.
    const preferred = Number(ambientConfig?.speech?.voiceRate) || 1;
    source.playbackRate.value = tone.rate * preferred;
    if ('detune' in source) source.detune.value = tone.detune;
    const gainNode = localSpeechContext.createGain();
    const loudness = Number(ambientConfig?.speech?.volume);
    gainNode.gain.value = tone.gain * (Number.isFinite(loudness) ? loudness : 1);
    globalThis.__lastSpeechGain = { applied: gainNode.gain.value, tone: tone.gain, loudness: Number.isFinite(loudness) ? loudness : 1, setting: ambientConfig?.speech?.volume, at: Date.now() };
    source.connect(gainNode); gainNode.connect(localSpeechAnalyser); source.start();
    localSpeechAudio = source;
    // Tap the same signal so the mouth can follow the actual voice envelope.
    // Without this the cached lines played with a motionless mouth.
    localSpeechStarted = performance.now();
    localSpeechEnds = localSpeechStarted + decoded.duration * 1000;
  } catch (error) { console.warn('[speech] local playback failed:', error?.message ?? error); }
}
function stopLocalSpeech() { try { localSpeechAudio?.stop(); } catch {} localSpeechAudio = null; localSpeechEnds = 0; renderer?.setSpeechAmplitude?.(0); }
/**
 * Converts the analyser reading into a mouth opening. Raw RMS is too small and
 * too jittery to drive a face, so it is scaled up and smoothed with a fast
 * attack / slower release, which is what makes speech read as alive rather than
 * as a flapping rectangle.
 */
function updateSpeechMouth() {
  if (!renderer?.setSpeechAmplitude) return;
  if (!localSpeechAudio || performance.now() > localSpeechEnds) { renderer.setSpeechAmplitude(0); return; }
  if (!localSpeechAnalyser || !localSpeechSamples) { renderer.setSpeechAmplitude(0); return; }
  localSpeechAnalyser.getByteTimeDomainData(localSpeechSamples);
  let sum = 0;
  for (const sample of localSpeechSamples) { const centred = (sample - 128) / 128; sum += centred * centred; }
  const rms = Math.sqrt(sum / localSpeechSamples.length);
  const target = Math.min(1, Math.pow(rms * 9, .62));
  speechMouthLevel += (target - speechMouthLevel) * (target > speechMouthLevel ? .55 : .18);
  renderer.setSpeechAmplitude(speechMouthLevel);
}
// Assigned once the renderer is up; the message handler below can call it earlier.
let cancelPendingReplySpeech = () => {};
let voiceRequestId = null, invitationPending = false, voiceRequestAt = 0, inputEventTiming=null;
function timedVoiceInput(at,source,run){const previous=inputEventTiming;inputEventTiming={at,source};try{return run();}finally{inputEventTiming=previous;}}
let introduction = null, introductionEpoch = 0, introductionFramePending = false;
let panelOpen = false, panelEpoch = 0, panelAnimation, panelCloseTimer;
let lastUI = '';
let awaitingTextTurn = false;
let bindingKey = false;
let managementOpening = false;
function managementResult(result) {
  if (!managementOpening || typeof result?.ok !== 'boolean') return;
  managementOpening = false; $('management').disabled = false; $('management').textContent = '控制台';
  $('management-notice').hidden = result.ok;
  $('management-notice').textContent = result.ok ? '' : '暂时无法打开控制台，请确认桌宠服务已启动后重试。';
}
$('management').onclick = () => {
  if (managementOpening) return;
  managementOpening = true; $('management').disabled = true; $('management').textContent = '打开中…';
  $('management-notice').hidden = true;
  native('shell', { type:'open_management' });
};
const display = installDisplayControls({ get: $, shell: value => native('shell', value), setFraming: mode => renderer?.setFraming(mode) });
const hold = new PressToTalk({
  start() {
    // A fresh physical hold supersedes pending generation, output or capture cleanup.
    if (!connection.connected) return false;
    command({ type: 'start_voice' }); return true;
  },
  finish() { command({ type: 'finish_voice' }); },
  cancel(early) {
    command({ type: 'cancel' });
    view.error = early ? '录音尚未开始，已取消，未发送。请按住直到提示正在听。' : '按键录音已取消，未发送。'; renderUI();
  }
});
function hotkeyConfig(value) {
  const code = value && typeof value === 'object' ? value.code ?? null : value;
  if (!hold.configure(code)) return;
  $('hotkey-value').textContent = code ? ({ ArrowUp:'↑', ArrowDown:'↓', ArrowLeft:'←', ArrowRight:'→', Space:'空格', Enter:'回车' }[code] ?? code.replace(/^Key|^Digit/,'')) : '未绑定';
}
function hotkeyEvent(event) {
  const receivedAt=performance.now();
  if (event.type === 'cancel') { hold.cancel(); return; }
  if (bindingKey || composing) return;
  if (event.type === 'down') timedVoiceInput(receivedAt,'native-hotkey',()=>hold.down(event.code,event.repeat));
  else if (event.type === 'up') hold.up(event.code);
}
$('hotkey-bind').onclick = () => { hold.cancel(); bindingKey = true; $('hotkey-bind').textContent = '请按一个键…'; $('hotkey-bind').focus(); };
$('hotkey-bind').onkeydown = event => {
  if (!bindingKey) return;
  event.preventDefault(); event.stopPropagation?.();
  if (event.key === 'Escape') { bindingKey = false; $('hotkey-bind').textContent = '设置按键'; return; }
  if (event.isComposing || event.repeat || event.metaKey || event.ctrlKey || event.altKey || !validVoiceKey(event.code)) return;
  bindingKey = false; $('hotkey-bind').textContent = '更换按键'; hotkeyConfig(event.code);
  native('shell', { type: 'set_hotkey', code: event.code });
};
$('hotkey-clear').onclick = () => { bindingKey = false; hotkeyConfig(null); $('hotkey-bind').textContent = '设置按键'; native('shell', { type: 'set_hotkey', code: null }); };

const reconnect = document.createElement('button'); reconnect.id = 'reconnect'; reconnect.type = 'button'; reconnect.textContent = '重新连接'; reconnect.hidden = true;
$('status').after(reconnect);
reconnect.onclick = () => { if (connection.canRetry && !connection.active) { reconnect.disabled = true; native('shell', { type: 'reconnect' }); } };
const connectionText = () => ({ connecting: '正在连接对话服务…', disconnected: '对话服务已断开', failed: connection.reason === 'version' ? '对话服务版本不一致，请退出后重新启动' : '对话服务连接失败' }[connection.state]);
const features = { type: 'features', secureContext: isSecureContext, mediaDevices: !!navigator.mediaDevices?.getUserMedia, audioWorklet: typeof AudioWorkletNode !== 'undefined', userAgent: navigator.userAgent, origin: location.origin };
report(features);
// --- forward replies to the LAN page ---------------------------------------
// A question typed on the phone is answered by the ordinary pipeline, so the
// simplest reliable hook is the row list itself: whatever reaches the user ends up
// recorded here, no matter which path produced it.
let forwardedRows = 0;
function forwardRepliesToRemote() {
  try {
    const rows = chat.rows(view.characterId);
    if (rows.length < forwardedRows) forwardedRows = rows.length;   // conversation cleared
    for (let i = forwardedRows; i < rows.length; i++) {
      const row = rows[i];
      if (row.kind === 'model' && typeof row.text === 'string' && row.text.trim()) {
        native('shell', { type: 'remote_reply', text: row.text.trim() });
      }
    }
    forwardedRows = rows.length;
  } catch { /* the bridge is optional */ }
}
/**
 * Play every physics-driven limb action in turn, each with its own caption.
 *
 * Built for testing: it names what should be happening, so a silent failure - the
 * action never reaching the rig - is obvious instead of looking like the character
 * simply chose not to move.
 *
 * Declared at module scope on purpose. The first attempt put it inside the setup
 * block, where it was invisible both to the callers and to the debugger.
 */
let previewRunning = false;
async function previewAllActions() {
  if (previewRunning) return;
  previewRunning = true;
  const fallback = [
    { action: 'raiseArm', text: '抬手' }, { action: 'lowerArm', text: '放下手臂' },
    { action: 'coverUp', text: '捂脸' }, { action: 'skirtSway', text: '裙子摆动' },
    { action: 'turnBody', text: '转身' }, { action: 'waveArm', text: '挥手' },
    { action: 'shrinkArms', text: '缩起来' }, { action: 'stretchArms', text: '伸展' },
  ];
  const steps = ambientConfig?.testSequence?.steps ?? fallback;
  const list = steps.length ? steps : fallback;
  settingsNotice?.('开始预览全部动作');
  for (const step of list) {
    showAmbient({ text: step.text, action: step.action, groupId: 'preview' }, { durationMs: 4200, keepWaiting: true });
    await new Promise(r => setTimeout(r, 4400));
  }
  previewRunning = false;
  settingsNotice?.('预览结束');
}

// Test hooks. The preview lives at module scope already, but these keep the rig
// observable from the debugger without reaching into the closure by hand.
// Frame grabber for the visual comparison, downsampled so two frames can be
// diffed cheaply in the test harness.
globalThis.__aaaagentGrab = () => {
  try {
    const c = document.querySelector('#model');
    const t = document.createElement('canvas');
    t.width = 160; t.height = 160;
    const g = t.getContext('2d');
    g.drawImage(c, 0, 0, 160, 160);
    const d = g.getImageData(0, 0, 160, 160).data;
    const out = new Array(d.length / 4);
    for (let i = 0; i < d.length; i += 4) out[i / 4] = (d[i] + d[i + 1] * 2 + d[i + 2] * 3) & 0xff;
    return out;
  } catch { return null; }
};

globalThis.__aaaagentTestHooks = {
  renderer: () => renderer,
  preview: () => previewAllActions(),
  last: () => globalThis.__lastAmbient ?? null,
  play: (action, text) => showAmbient({ text: text ?? action, action, groupId: 'preview' }, { durationMs: 4200, keepWaiting: true }),
};

function renderUI() {
  forwardRepliesToRemote();
  wake.observe({busy:!!capturing||voicePhase!=='idle'||awaitingTextTurn||awaitingTranscript||['listening','thinking','speaking'].includes(view.state)||workSpeechView.state==='speaking',playing:playback.busy});
  const uiKey = JSON.stringify([wakeUI.phase,wakeUI.detail,awaitingTextTurn, awaitingTranscript, work.expanded,work.state?.sourceInput?.draftId,workSpeechView.state, voicePhase, chat.revision, view.reply, view.error, view.state, view.characterId, view.invitation?.id, view.invitation?.text, connection.state, connection.reason, connection.canRetry, introduction?.id, introduction?.text]);
  if (uiKey === lastUI) return;
  lastUI = uiKey;
  const rows = chat.rows(view.characterId).map(row => {
    const item = document.createElement('div'); item.className = `chat-row ${row.kind}`;item.dataset.rowId=String(row.id);
    const label = document.createElement('span'); label.className = 'chat-label';
    label.textContent = row.kind === 'user' ? `${row.sourceLabel??'你'}${row.status === 'sending' ? ' · 发送中' : row.status === 'failed' ? ' · 未送达' : ''}` : COMPANION_LABEL;
    const text = document.createElement('div'); text.textContent = row.text;
    item.append(label, text);
    if(row.kind==='user'&&row.text.length>140){const expanded=expandedInputs.has(row.id);text.className=expanded?'input-original':'input-original input-original-preview';const more=document.createElement('button');more.type='button';more.className='input-full-toggle';more.textContent=expanded?'收起全文':'查看输入全文';more.setAttribute('aria-expanded',String(expanded));more.onclick=()=>{if(expanded)expandedInputs.delete(row.id);else expandedInputs.add(row.id);preserveReading=true;lastUI='';renderUI();};item.append(more);}
    return item;
  });
  if (introduction) {
    const opening = document.createElement('section'); opening.id = 'introduction'; opening.className = 'introduction';
    const label = document.createElement('span'); label.className = 'introduction-label'; label.textContent = '开场 · 虚构设定';
    const text = document.createElement('div'); text.textContent = introduction.text; opening.append(label, text); rows.unshift(opening);
  }
  const log = $('reply'),scroller=$('conversation'), nearBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 36;
  const oldScroll = scroller.scrollTop, latestInput = chat.rows(view.characterId).filter(row=>row.kind==='user').at(-1)?.id;
  const sourceId=work.state?.sourceInput?.draftId;
  const sourceFocus=requestedSourceFocus||work.expanded&&(!lastWorkOpen||sourceId!==lastSourceId);
  const focusInput=sourceFocus?chat.sourceRowId(view.characterId,sourceId)??latestInput:latestInput;
  const showInput = requestedSourceFocus||latestInput!==lastInputRow||work.expanded!==lastWorkOpen||work.expanded&&sourceId!==lastSourceId;lastSourceId=sourceId;requestedSourceFocus=false;
  lastInputRow=latestInput;lastWorkOpen=work.expanded;
  log.replaceChildren(...rows);
  const inputRow=showInput?rows.find(row=>row.dataset?.rowId===String(focusInput)):null;
  if(preserveReading){scroller.scrollTop=oldScroll;preserveReading=false;}
  else if(inputRow)scroller.scrollTop=Math.max(0,(scroller.scrollTop||0)+inputRow.getBoundingClientRect().top-scroller.getBoundingClientRect().top);
  else scroller.scrollTop=nearBottom?scroller.scrollHeight:oldScroll;
  $('status').textContent = connectionText() || view.error || (workSpeechView.state==='speaking'?'正在播报任务状态…':'') || (awaitingTranscript ? '正在转写…' : '') || (voicePhase === 'preparing' ? '正在准备麦克风…' : '') || ({ idle: wakeLabels[wakeUI.phase]||(wakeUI.phase==='error'?'唤醒已停止，请在网页重新开启':'我在这里'), listening: voicePhase === 'recording' ? '正在听你说 · 再点一次结束' : '正在准备麦克风…', thinking: '正在想怎么回应你…', speaking: '正在说话…', error: '这一轮没有完成' }[view.state]);
  $('thinking-indicator').hidden = !connection.connected || !!view.error || awaitingTranscript || !(awaitingTextTurn || view.state === 'thinking');
  reconnect.hidden = connection.active || !connection.canRetry; reconnect.disabled = connection.active;
  $('invitation').disabled = !connection.connected;
  $('voice').textContent = voicePhase === 'preparing' ? '取消准备' : voicePhase === 'recording' ? '说完了' : '开始语音';
  $('stop').hidden = (view.state === 'idle' || view.state === 'error')&&!workNotice;
  $('voice').disabled = !connection.connected || (voicePhase === 'idle' && !['idle', 'error'].includes(view.state));
  $('send').disabled = !connection.connected || chat.pending(view.characterId);
  $('invitation').hidden = !view.invitation; $('invitation').textContent = view.invitation?.text ?? '';
  if (panelOpen) fitComposer();
  scheduleIntroductionAck();
}
// This presentation is never appended to chat or submitted as user/model text.
function scheduleIntroductionAck() {
  const current = introduction, epoch = introductionEpoch;
  if (!current || current.acknowledged || introductionFramePending || !connection.connected || !panelOpen || document.hidden) return;
  const visible = () => {
    if (epoch !== introductionEpoch || introduction !== current || !connection.current(current.generation) || !connection.connected || !panelOpen || document.hidden) return false;
    const node = $('introduction');
    if (!node || !node.getClientRects().length || $('drawer').hidden) return false;
    const rect = node.getBoundingClientRect(), clip = $('conversation').getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 && rect.bottom > clip.top && rect.top < clip.bottom && rect.right > clip.left && rect.left < clip.right;
  };
  introductionFramePending = true;
  requestAnimationFrame(() => {
    if (!visible()) { if (epoch === introductionEpoch) introductionFramePending = false; return; }
    // Give the visible content a paint opportunity before acknowledging it.
    requestAnimationFrame(() => {
      if (epoch === introductionEpoch) introductionFramePending = false;
      if (!visible() || current.acknowledged) return;
      send({ channel: 'command', command: { type: 'acknowledge_introduction', introductionId: current.id } }, current.generation);
      current.acknowledged = true;
    });
  });
}
$('conversation').addEventListener('scroll', scheduleIntroductionAck);
function panel(open) {
  if(open&&panelOpen&&!$('drawer').hidden){scheduleIntroductionAck();return;}
  const epoch = ++panelEpoch;
  panelAnimation?.cancel(); panelAnimation = null;
  clearTimeout(panelCloseTimer);
  if (!open) {
    records.close(false);document.activeElement?.blur?.();
    bindingKey = false; $('hotkey-bind').textContent = '设置按键';
  }
  const drawer = $('drawer');
  panelOpen = open; drawer.inert = !open; $('open').hidden = open;
  $('open').setAttribute('aria-expanded', String(open));
  const animate = drawer.animate && !document.hidden && !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  const finishClose = () => { if (!panelOpen && epoch === panelEpoch && !drawer.hidden) { clearTimeout(panelCloseTimer); drawer.hidden = true; native('shell', { type: 'panel', open: false }); } };
  if (open) { drawer.hidden = false; markVisibleWork(); native('shell', { type: 'panel', open: true }); }
  if (animate && !drawer.hidden) {
    panelAnimation = drawer.animate(open ? [{opacity:0,transform:'translateY(6px)'},{opacity:1,transform:'translateY(0)'}] : [{opacity:1,transform:'translateY(0)'},{opacity:0,transform:'translateY(6px)'}], {duration:open ? 200 : 180,easing:'cubic-bezier(.2,.7,.2,1)'});
    // Occluded WKWebViews can suspend animation frames. Closing must still end.
    if (!open) panelCloseTimer = setTimeout(finishClose, 180);
    panelAnimation.finished.then(() => { if (!open) finishClose(); }, () => {});
  } else if (!open) finishClose();
  introductionEpoch++; introductionFramePending = false;
  if (open) { requestAnimationFrame(() => {
    if (panelOpen && epoch === panelEpoch && !document.hidden && document.hasFocus?.() !== false&&!records.isOpen) { fitComposer(); $('text').focus({ preventScroll: true }); }
  }); scheduleIntroductionAck(); }
}
function fitComposer() {
  // Bounds scaled with the shrunken 240x270 drawer (were 120 / 24).
  const input = $('text'); input.style.height = 'auto';
  input.style.height = `${Math.min(80, Math.max(17, input.scrollHeight || 17))}px`;
}
const playback = new DesktopPlaybackController(new BrowserPlaybackDriver(), scope => view.accepts(scope)||workSpeechView.accepts(scope), (requestId, event) => {
  const workOutput=workSpeechView.accepts(event.scope);
  (workOutput?workSpeechView:view).receive({type:'playback',playback:event});
  if(workOutput&&event.type==='started'&&workNotice)workNotice.started=true;
  if(workOutput&&event.type==='ended'&&workNotice?.started&&workNotice.workBinding)work.presented(workNotice.workBinding);
  if(workOutput&&['ended','stopped','error'].includes(event.type)){workNotice=null;workSpeechView.reset();}
  renderUI();
  send({ channel: 'playback', requestId, event });
  if (['ended','stopped','error'].includes(event.type)) renderer?.reset();
  if (event.type === 'started' || ['ended','stopped','error'].includes(event.type)) report({ type: 'playback-state', event: event.type, timingBasis: event.timingBasis, model: renderer?.ready ? renderer.snapshot() : null });
});
function stopPlayback(scope) { playback.stop(scope); }
function restoreSelectedSource(){const source=work.state?.sourceInput;if(work.expanded&&source&&typeof source.draftId==='string'&&typeof source.text==='string'&&isProductCharacter(source.scope?.characterId)&&['original_input','legacy_saved_input'].includes(source.provenance))chat.restoreSource(source);}
function markVisibleWork(){if(!records.isOpen&&panelOpen&&!document.hidden&&!$('drawer').hidden&&work.expanded&&!$('work-card').hidden)work.presented();}
function displayedWorkBinding(){return work.inputBinding();}
function clearWorkSpeech(){const scope=workNotice?.scope;workNotice=null;workSpeechView.reset();if(scope)stopPlayback(scope);}
function stopCapture(scope) {
  if (!scope || capturing && scopeEquals(capturing.scope, scope)) voicePhase = 'idle';
  if (!capturing || scope && !scopeEquals(capturing.scope, scope)) return;
  const active = capturing; capturing = null; captureFeedback.stop(active.feedbackToken);active.controller.abort(); active.session?.stop();
  report({ type: 'capture-stopped' });
}
function command(cmd,{wakeInput=false}={}) {
  const commandEnteredAt=performance.now();
  if (!connection.connected) return;
  // Any real user action silences ambient small talk, so a preset line can never
  // talk over a turn the user actually started. It also ends any open exchange.
  ambient?.noteInteraction();
  clearWaiting();
  if(!wakeInput&&['start_voice','click_invitation','submit_text','cancel'].includes(cmd.type)){wake.pause();wakeRequestId=null;}
  if(['start_voice','submit_text'].includes(cmd.type)){const binding=displayedWorkBinding();cmd={...cmd,...(binding?{workBinding:binding}:{})};}
  if(['start_voice','click_invitation'].includes(cmd.type))voiceRequestAt=inputEventTiming?.at??commandEnteredAt;

  if (cmd.type === 'finish_voice' && voicePhase !== 'recording') {
    command({ type: 'cancel' }); view.error = '录音尚未就绪，已取消；请等到提示正在听再结束。'; renderUI(); return;
  }
  if (cmd.type === 'click_invitation' && voicePhase !== 'idle') return;
  if(['start_voice','click_invitation'].includes(cmd.type))captureFeedbackToken=wakeInput?wakeFeedbackToken:captureFeedback.start();
  else if(['finish_voice','cancel','submit_text'].includes(cmd.type)&&!wakeInput)captureFeedback.stop();
  if(['cancel','start_voice','click_invitation'].includes(cmd.type))textRequestId=null;
  if(cmd.type==='submit_text'){textRequestId=crypto.randomUUID();cmd={...cmd,clientRequestId:textRequestId};}
  if (cmd.type === 'start_voice') { voiceRequestId = crypto.randomUUID();wakeRequestId=wakeInput?voiceRequestId:null; cmd = { ...cmd, clientRequestId: voiceRequestId }; invitationPending = false; }
  if (cmd.type === 'click_invitation') { voiceRequestId = null; invitationPending = true; }
  if (['cancel', 'submit_text'].includes(cmd.type)) { voiceRequestId = null; invitationPending = false; chat.cancelVoice(view.characterId); }
  if (['start_voice', 'click_invitation'].includes(cmd.type)) { chat.failPending(view.characterId); chat.beginVoice(view.characterId, true); }
  if (cmd.type === 'submit_text') {
    // Remote submits were reaching here and producing no turn, with nothing in the
    // log to say why. chat.submit returns false rather than throwing, so the result
    // has to be reported explicitly.
    const accepted = chat.submit(view.characterId, cmd.text);
    native('shell', { type: 'remote_trace', step: 'submit-result', detail: accepted ? 'accepted' : 'rejected' });
    if (!accepted) return;
  }
  // Remember what the user just said so the small talk can refer to it later.
  if (cmd.type === 'submit_text') learnFromChat(cmd.text);
  if (cmd.type === 'cancel') { work.forgetBinding();chat.failPending(view.characterId); $('text').value = chat.draft(view.characterId); }
  if (['cancel','submit_text'].includes(cmd.type)) hold.clear();
  if (['cancel','submit_text','start_voice','click_invitation'].includes(cmd.type)) {
    clearWorkSpeech();workSpeechBlocked=false;inputFocusEpoch++;inputScope=null;awaitingTranscript=false;work.input(!!cmd.workBinding); routeFocusEpoch=++interactionFocusEpoch; companionRoute=null; void stopPlayback(); stopCapture(); renderer?.reset();
  }
  captureAllowed = cmd.type === 'start_voice' || cmd.type === 'click_invitation';
  if (captureAllowed) { voicePhase = 'preparing'; }
  if (cmd.type === 'finish_voice') { awaitingTranscript=true;voicePhase = 'finishing'; captureAllowed = false; if (capturing) capturing.inputEndedAt = new Date().toISOString(); }
  if (['cancel', 'submit_text', 'start_voice', 'click_invitation'].includes(cmd.type)) awaitingTextTurn = cmd.type === 'submit_text';
  view.command(cmd);
  if (cmd.type === 'start_voice') renderer?.beginAttention();
  // Dispatch explicit voice authorization before rebuilding the chat DOM.
  if (cmd.type === 'start_voice') { send({ channel: 'command', command: cmd }); report({type:'capture-command-timing',source:inputEventTiming?.source??'command',handlerToCommandMs:Math.max(0,commandEnteredAt-voiceRequestAt),handlerToSendMs:Math.max(0,performance.now()-voiceRequestAt)});renderUI(); }
  else { renderUI(); send({ channel: 'command', command: cmd }); }

}
const bytesFromBase64 = value => Uint8Array.from(atob(value), c => c.charCodeAt(0));
function base64(bytes) { let text = ''; for (let at = 0; at < bytes.length; at += 32768) text += String.fromCharCode(...bytes.subarray(at, at + 32768)); return btoa(text); }
function connectionChanged(value) {
  if (!connection.update(value)) return;
  wake.disconnect();wakeRequestId=null;
  captureFeedback.stop();
  awaitingTextTurn = false;clearWorkSpeech();spokenNotices.clear();workSpeechBlocked=false;inputFocusEpoch=0;interactionFocusEpoch=0;routeFocusEpoch=0; inputScope=null;awaitingTranscript=false;work.reset(); companionRoute=null; textRequestId=null;
  presentationPolicy=null;applyPresentationPolicy();
  hold.clear(); voiceRequestId = null; invitationPending = false; chat.cancelVoice(view.characterId);
  introduction = null; introductionEpoch++; introductionFramePending = false; captureAllowed = false;
  chat.setDraft(view.characterId, $('text').value); chat.failPending(view.characterId); $('text').value = chat.draft(view.characterId);
  void stopPlayback(); stopCapture(); renderer?.reset(); view.reset(); view.reply = ''; view.invitation = null;
  renderUI();
  if (!connection.active) panel(true);
}
async function receive(message, generation) {
  if (!connection.current(generation)) return;
  if (message.channel === 'backend_ready') {
    if (message.bridgeVersion !== DESKTOP_BRIDGE_VERSION || !isProductCharacter(message.characterId) || typeof message.sessionId !== 'string' || !message.sessionId) {
      connectionChanged({ generation, state: 'failed', reason: 'version' });
      native('shell', { type: 'disconnect', generation }); return;
    }
    if (!connection.ready(generation)) return;
    wake.disconnect();wakeRequestId=null;
    captureFeedback.stop();
    awaitingTextTurn = false;clearWorkSpeech();spokenNotices.clear();workSpeechBlocked=false;inputFocusEpoch=0;interactionFocusEpoch=0;routeFocusEpoch=0; inputScope=null;awaitingTranscript=false;work.reset(); companionRoute=null; textRequestId=null;
    // Do NOT clear the presentation policy here. The backend announces it before
    // it announces backend_ready, so resetting at this point discarded the policy
    // that had just been applied: every procedural idle feature stayed disabled
    // and the character never moved. connectionChanged() already invalidates a
    // stale policy when a new generation starts, which is the correct moment.
    introduction = null; introductionEpoch++; introductionFramePending = false; captureAllowed = false;
    void stopPlayback(); stopCapture(); renderer?.reset();
    backendSessionId=message.sessionId;view.setSession(message.characterId, message.sessionId);workSpeechView.setSession(message.characterId,message.sessionId);
    if (message.introduction && typeof message.introduction.id === 'string' && message.introduction.id && typeof message.introduction.text === 'string' && message.introduction.text.trim()) introduction = { ...message.introduction, generation, acknowledged: false };
    $('text').value = chat.draft(view.characterId); renderUI();
    report({ type: message.channel, characterId: message.characterId, bridgeVersion: DESKTOP_BRIDGE_VERSION }); return;
  }
  if(message.channel==='wake_control'){if(!connection.connected)return;wake.control(message);return;}
  if(message.channel==='wake_result'){if(!connection.connected)return;wake.result(message);return;}
  if(message.channel==='wake_error'){if(!connection.connected)return;wake.error(message);return;}
  if (message.channel === 'backend_closed') { connectionChanged({ generation, state: 'disconnected' }); return; }
  if (!connection.connected) return;
  if(message.channel==='work_state') { if(work.receive(message.state)){markVisibleWork();if(message.state.focus==='work')restoreSelectedSource();renderUI();} return; }
  if(message.channel==='work_speech'){
    const e=message.event;
    if(!e||!e.scope||e.scope.sessionId!==backendSessionId||!isProductCharacter(e.scope.characterId)||!Number.isSafeInteger(e.inputEpoch)||e.inputEpoch!==inputFocusEpoch||typeof e.noticeId!=='string')return;
    if(e.state==='end'){if(workNotice?.noticeId===e.noticeId&&scopeEquals(workNotice.scope,e.scope)){if(playback.busy&&scopeEquals(playback.scope,e.scope))workNotice.ending=true;else clearWorkSpeech();}return;}
    if(e.state!=='start'||spokenNotices.has(e.noticeId)||workSpeechBlocked||voicePhase!=='idle'||capturing||awaitingTextTurn||['thinking','speaking','listening'].includes(view.state))return;
    clearWorkSpeech();spokenNotices.add(e.noticeId);workNotice={noticeId:e.noticeId,scope:e.scope,ending:false,workBinding:e.workBinding?structuredClone(e.workBinding):undefined};workSpeechView.scope=e.scope;renderUI();return;
  }
  if(message.channel==='input_route') {
    if(!view.accepts(message.scope)||!['companion','work'].includes(message.route))return;
    chat.route(message.scope,message.route);
    if(message.route==='work'){companionRoute=null;awaitingTextTurn=false;if(routeFocusEpoch===interactionFocusEpoch)work.routedWork();markVisibleWork();restoreSelectedSource();view.reset();renderer?.reset();}
    else {companionRoute=message.scope;work.input();}
    renderUI(); return;
  }
  if(message.channel==='presentation_policy'){
    const p=message.policy;
    if(!p||typeof p.modelId!=='string'||!Number.isSafeInteger(p.revision)||p.revision<0||!Array.isArray(p.enabledIds)||p.enabledIds.some(id=>typeof id!=='string'))return;
    if(presentationPolicy?.modelId===p.modelId&&p.revision<=presentationPolicy.revision)return;
    presentationPolicy=structuredClone(p);applyPresentationPolicy();return;
  }
  if (message.channel === 'event') {
    const e = message.event;
    if(e.type==='turn'&&e.input.kind==='text'&&(!textRequestId||e.input.clientRequestId!==textRequestId))return;
    if(e.type==='reply'&&!scopeEquals(companionRoute,e.reply.scope))return;
    if (e.type === 'turn' && e.input.kind === 'voice' && !(invitationPending && !e.input.clientRequestId) && (!voiceRequestId || e.input.clientRequestId !== voiceRequestId)) return;
    // Work presentation may reset before a late ASR event; input identity is independent.
    const accepted = e.type==='transcript' ? scopeEquals(inputScope,e.scope) : view.receive(e);
    if(accepted&&e.type==='turn')inputScope=e.input.scope;
    if(accepted&&e.type==='transcript')awaitingTranscript=false;
    if(accepted&&e.type==='error'){captureFeedback.stop();inputScope=null;awaitingTranscript=false;}
    if (accepted && ['turn', 'error'].includes(e.type)) awaitingTextTurn = false;
    if (accepted && e.type === 'turn') { if (e.input.kind === 'text') chat.acknowledge(e.input.scope, true); else chat.bindVoice(e.input.scope); }
    if (accepted && e.type === 'transcript') chat.transcript(e.scope, e.text);
    if (accepted && e.type === 'reply' && scopeEquals(companionRoute,e.reply.scope)) chat.reply(e.reply.scope, e.reply.text);
    if (accepted && e.type === 'error') { hold.clear(); voiceRequestId = null; invitationPending = false; chat.cancelVoice(view.characterId); chat.failPending(view.characterId); $('text').value = chat.draft(view.characterId); }
    if (accepted && (e.type === 'error' || e.type === 'presentation' && e.presentation.state === 'error')) { captureFeedback.stop();void stopPlayback(); stopCapture(); renderer?.reset(); }
    if (accepted && e.type === 'turn') { if (playback.scope && !scopeEquals(playback.scope, e.input.scope)) void stopPlayback(); if (capturing && !scopeEquals(capturing.scope, e.input.scope)) stopCapture(); renderer?.reset({ preserveAttention: e.input.kind === 'voice' }); }
    if (accepted) renderUI(); return;
  }
  try {
    if (message.channel === 'stop' || message.channel === 'capture_stop') {
      if (message.channel === 'stop') await stopPlayback(message.scope); else stopCapture(message.scope);
      send({ channel: 'ack', requestId: message.requestId }, generation); return;
    }
    if (message.channel === 'play') {
      const isWorkSpeech=workNotice&&!workNotice.ending&&scopeEquals(workNotice.scope,message.tts.scope);
      if(!scopeEquals(companionRoute,message.tts.scope)&&!isWorkSpeech||isWorkSpeech&&workNotice.playRequestId&&workNotice.playRequestId!==message.requestId){message.audioBase64='';send({channel:'playback',requestId:message.requestId,event:{type:'stopped',scope:message.tts.scope,at:new Date().toISOString()}});return;}
      if(isWorkSpeech)workNotice.playRequestId=message.requestId;
      if(isWorkSpeech)workSpeechView.expression=message.tts.expression??workSpeechView.expression;
      const bytes = bytesFromBase64(message.audioBase64); message.audioBase64 = '';
      cancelPendingReplySpeech();
      await playback.play(message.requestId, message.tts, bytes);
      return;
    }
    if (message.channel === 'capture_start') {
      if (!captureAllowed || !view.accepts(message.scope)) throw new Error('录音仅能由当前主动语音轮次打开');
      const fromWake=wakeRequestId!==null&&wakeRequestId===voiceRequestId;
      if(fromWake&&!wake.pendingCapture){if(capturing?.wake&&capturing.session&&scopeEquals(capturing.scope,message.scope)){send({channel:'ack',requestId:message.requestId},generation);return;}throw new Error('唤醒录音已取消');}
      stopCapture(); voicePhase = 'preparing';
      const active = { scope: message.scope, controller: new AbortController(),feedbackToken:captureFeedbackToken,wake:fromWake }; capturing = active;
      const driver = new BrowserCaptureDriver({ workletModuleUrl: new URL('./recorder-worklet.js', import.meta.url), cameraWidth: 640, jpegQuality: .8, maxBufferedSamples: 12000000,onLevel:level=>{if(capturing===active&&!active.controller.signal.aborted)captureFeedback.level(active.feedbackToken,level);}, onDiagnostic: event => {
        if(capturing===active){if(event.phase==='stopped')captureFeedback.stop(active.feedbackToken);report({type:'capture-timing',...event,requestElapsedMs:Math.max(0,performance.now()-voiceRequestAt)});}
      } });
      const opening=active.wake?Promise.resolve(wake.takeCapture()):driver.open(active.controller.signal);renderUI();
      active.session = await opening;
      if (capturing !== active) { active.session.stop(); throw new Error('录音轮次已取消'); }
      voicePhase = 'recording'; hold.ready(); renderUI();
      send({ channel: 'ack', requestId: message.requestId }, generation);if(active.wake)wake.captureReady(); report({ type: 'capture-ready' }); return;
    }
    if (message.channel === 'capture_finish') {
      const active = capturing;
      if (!active?.session || !scopeEquals(active.scope, message.scope)) throw new Error('没有本轮已就绪的录音');
      if(!active.wake)captureFeedback.stop(active.feedbackToken);
      const inputEndedAt = active.inputEndedAt ?? new Date().toISOString();
      const value = await active.session.finish();
      try {
        if (capturing !== active) throw new Error('采集结果已失效');
        send({ channel: 'capture', requestId: message.requestId, result: { scope: active.scope, audio: { id: crypto.randomUUID(), mimeType: 'audio/wav', base64: base64(value.audio) }, images: value.images.map(i => ({ id: crypto.randomUUID(), mimeType: i.mimeType, base64: base64(i.bytes) })), inputEndedAt, captureStoppedAt: value.captureStoppedAt } }, generation);
        capturing = null; voicePhase = 'idle'; renderUI(); report({ type: 'capture-finished', inputEndedAt, captureStoppedAt: value.captureStoppedAt });
      } finally { value.audio.fill(0); value.images.forEach(i => i.bytes.fill(0)); }
    }
  } catch (error) {
    const failure = toDeviceFailure(error), text = deviceFailureMessage(failure), scope = message.scope ?? message.tts?.scope;
    if (connection.current(generation) && message.channel.startsWith('capture') && scope && view.accepts(scope)) {
      stopCapture(scope); captureAllowed = false; hold.clear(); voiceRequestId = null; invitationPending = false;
      inputScope=null;awaitingTranscript=false;chat.cancelVoice(view.characterId); view.receive({ type: 'error', scope, message: text }); renderUI();
    }
    send({ channel: 'rpc_error', requestId: message.requestId, ...(scope ? { scope } : {}), error: failure, message: text }, generation);
  }
}
window.petBridge = { receive, connectionChanged, hotkeyConfig, hotkeyEvent, displayConfig: display.receive, managementResult,
  // What the user has in front of them: window title, process and fullscreen state.
  foregroundState(value) {
    if (!value || typeof value !== 'object') { foreground = null; return; }
    foreground = value.idle || value.self ? null : value;
  },
  // Real system state from the main process: how long the user has been away
  // from the keyboard anywhere, and where the pointer is.
  systemState(value) {
    if (!value || typeof value !== 'object') return;
    if (Number.isFinite(value.idleSeconds)) systemIdleSeconds = value.idleSeconds;
    const cursor = value.cursor, bounds = value.bounds;
    if (!cursor || !bounds || !bounds.width || !bounds.height) return;
    // Track pointer movement: while it is moving the user is watching the pet
    // follow the cursor, so the idle timer must not play an action that takes the
    // eyes over.
    if (lastCursor && Math.abs(cursor.x - lastCursor.x) + Math.abs(cursor.y - lastCursor.y) > 4) cursorMovedAt = performance.now();
    lastCursor = { x: cursor.x, y: cursor.y };
    const away = Number(value.idleSeconds) || 0;
    if (away > 300) wasAway = true;
    else if (wasAway && performance.now() - welcomeBackAt > 60000) {
      wasAway = false; welcomeBackAt = performance.now();
      const line = ambient?.reaction({ kind: 'back' });
      if (line && view.state === 'idle' && $('drawer').hidden) showAmbient({ ...line, groupId: 'reaction' }, { durationMs: 5600, keepWaiting: true });
    }
    // What the pet can notice right now. The process name comes from the focus
    // reporter; idle is system-wide, so it is the same number the away-lines use.
    ambient?.observe({
      app: value.process || foreground?.process || '',
      away: Number.isFinite(value.idleSeconds) ? value.idleSeconds : undefined,
    });
    // Normalise the pointer against the pet's own box and the desktop size, so
    // the eyes reach their extremes at the screen edges rather than a few
    // hundred pixels away. -1 is fully left, +1 fully right.
    const centreX = bounds.x + bounds.width / 2, centreY = bounds.y + bounds.height * 0.32;
    const area = value.workArea;
    const reachX = Math.max(area?.width ? area.width * 0.8 : 0, 480);
    const reachY = Math.max(area?.height ? area.height * 0.8 : 0, 380);
    renderer?.setCursorGaze?.((cursor.x - centreX) / reachX, (cursor.y - centreY) / reachY);
  },
  localSpeech(value) {
    if (!value || value.requestId !== localSpeechRequest) return;
    if (value.ok && typeof value.audioBase64 === 'string') { localSpeechFallback = null; void playLocalSpeech(value.audioBase64, localSpeechEmotion); return; }
    // No cached clip yet: fall back to a live cloud request so the pet still talks.
    const pending = localSpeechFallback; localSpeechFallback = null;
    if (value.missing && pending && ambientSpeechEnabled && connection.connected)
      send({ channel: 'command', command: { type: 'ambient_speak', text: pending } });
  } };
window.desktopHost?.subscribe((method, ...args) => window.petBridge[method]?.(...args));
$('open').onclick = () => panel(true);
  // Quick controls beside "？怎么了". Each is one click from the pet itself.
  {
    const volumeToggle = $('qb-voice-btn'), volumeBox = $('qb-volume'), volumeRange = $('qb-volume-range'), volumeOut = $('qb-volume-out');
    // The slider mirrors whatever the settings panel has, so the two never drift.
    const syncVolume = value => {
      const percent = Math.round(Math.max(0, Math.min(1, value ?? .7)) * 100);
      if (volumeRange) volumeRange.value = percent;
      if (volumeOut) volumeOut.value = percent;
    };
    syncVolume(ambientConfig?.speech?.volume);
    volumeToggle && (volumeToggle.onclick = event => {
      event.stopPropagation();
      const open = volumeBox.hidden;
      volumeBox.hidden = !open;
      volumeToggle.setAttribute('aria-pressed', String(open));
      if (open) syncVolume(ambientConfig?.speech?.volume);
    });
    volumeRange && (volumeRange.oninput = event => {
      const percent = Number(event.target.value);
      if (volumeOut) volumeOut.value = percent;
    });
    // Commit on release, not on every pixel of the drag.
    volumeRange && (volumeRange.onchange = event => {
      const value = Number(event.target.value) / 100;
      // applyVoiceVolume also updates the live fallback speaker and the settings
      // panel. The cached-clip gain reads the setting when it plays, so it needs
      // nothing further.
      applyVoiceVolume(value);
      native('shell', { type: 'ambient_config', action: 'save', patch: { 'speech.volume': value } });
      settingsNotice?.('音量已保存');
    });
    const quietButton = $('qb-quiet');
    quietButton && (quietButton.onclick = event => {
      event.stopPropagation();
      const next = !(ambientConfig?.quiet?.manual === true);
      if (ambientConfig?.quiet) ambientConfig.quiet.manual = next;
      else if (ambientConfig) ambientConfig.quiet = { manual: next };
      quietButton.setAttribute('aria-pressed', String(next));
      quietButton.textContent = next ? '🔇' : '🌙';
      if ($('ps-quiet')) $('ps-quiet').checked = next;
      native('shell', { type: 'ambient_config', action: 'save', patch: { 'quiet.manual': next } });
      settingsNotice?.(next ? '已开启免打扰' : '已关闭免打扰');
    });
    // Straight to the console: this is the "long way round" that is now one click.
    const consoleButton = $('qb-console');
    // #management lives inside the drawer, so the click has to be dispatched after
    // the drawer is open - otherwise nothing happens at all.
    consoleButton && (consoleButton.onclick = event => {
      event.stopPropagation();
      panel(true);
      requestAnimationFrame(() => { const target = $('management'); if (target) target.click(); });
    });
    const settingsButton = $('qb-settings');
    settingsButton && (settingsButton.onclick = event => {
      event.stopPropagation();
      panel(true);
      const details = $('pet-settings');
      if (details) { details.open = true; details.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }
    });
  } $('close').onclick = () => panel(false); $('quit').onclick = () => { wake.disconnect();captureFeedback.stop();void stopPlayback(); stopCapture(); native('shell', { type: 'quit' }); };
$('text').oninput = () => { clearWorkSpeech();workSpeechBlocked=true;interactionFocusEpoch++; work.input(!!displayedWorkBinding()); chat.setDraft(view.characterId, $('text').value); fitComposer(); };
$('text').oncompositionstart = () => { composing = true; };
$('text').oncompositionend = () => { composing = false; };
$('text').onkeydown = event => {
  if (event.key !== 'Enter') return;
  if (composing || event.isComposing || event.keyCode === 229) { event.preventDefault(); return; }
  if (!event.shiftKey) { event.preventDefault(); $('form').requestSubmit(); }
};
$('form').onsubmit = event => {
  event.preventDefault(); const text = $('text').value.trim();
  if (composing || event.isComposing || !text || !connection.connected || chat.pending(view.characterId)) return;
  $('text').value = ''; command({ type: 'submit_text', text });
};
$('text').onfocus = () => report({ type: 'input-focus', active: document.activeElement === $('text') });
$('voice').onclick = () => timedVoiceInput(performance.now(),'voice-button',()=>command({ type: voicePhase !== 'idle' ? 'finish_voice' : 'start_voice' }));
$('stop').onclick = () => command({ type: 'cancel' });
$('invitation').onclick = () => { if (view.invitation) { const id = view.invitation.id; view.invitation = null; panel(true); command({ type: 'click_invitation', invitationId: id }); } };
/**
 * Clickable regions, as fractions of the canvas box.
 *
 * The model's own model3.json declares an empty HitAreas array, so there is no
 * rig data to read. These are measured from the rendered character and weighted
 * toward the upper body: head, face, chest and the two hands.
 *
 * Order matters - the first match wins, so the small face box sits inside the
 * head box and must be tested first.
 */
const PART_REGIONS = [
  { id: 'face', x: .34, y: .055, w: .32, h: .22 },
  { id: 'head', x: .18, y: .015, w: .64, h: .32 },
  { id: 'chest', x: .30, y: .30, w: .40, h: .26 },
  { id: 'hand', x: .04, y: .38, w: .30, h: .30 },
  { id: 'hand', x: .66, y: .38, w: .30, h: .30 },
  // Lower body. Without these the skirt and legs hit no region at all, so
  // overPet() answered "not on the pet" and the click passed through to the window
  // behind - the lower half of the character was not clickable.
  { id: 'body', x: .26, y: .54, w: .48, h: .22 },
  { id: 'skirt', x: .18, y: .70, w: .64, h: .24 },
  { id: 'legs', x: .30, y: .88, w: .40, h: .12 },
];
/**
 * Gesture combos.
 *
 * Tapping her cheek and then her chest should feel like one act - first stroking
 * her face, then poking her chest - not like two separate pokes with a coincidence
 * between them. Recent taps are kept for a few seconds and matched against these
 * patterns; the longest match wins.
 */
const COMBO_WINDOW_MS = 4500;
const COMBO_PATTERNS = [
  { seq: ['face', 'chest'], kind: 'combo:face-chest' },
  { seq: ['head', 'chest'], kind: 'combo:head-chest' },
  { seq: ['head', 'face'], kind: 'combo:head-face' },
  { seq: ['face', 'face'], kind: 'combo:face-face' },
  { seq: ['head', 'head'], kind: 'combo:head-head' },
  { seq: ['hand', 'hand'], kind: 'combo:hand-hand' },
  { seq: ['chest', 'chest'], kind: 'combo:chest-chest' },
  { seq: ['face', 'hand'], kind: 'combo:face-hand' },
];
let tapHistory = [];
/** The combo this tap completes, or null. */
/**
 * The limb gesture a poke should always produce.
 *
 * Set here instead of relying on the reaction's own action list: that list is
 * chosen by the scheduler and sometimes arrives empty, which left the rig still
 * when it should have been moving.
 */
const POKE_MOTION = {
  head: 'handToFace',      // 摸头 → 单手抬到脸旁
  face: 'handToFace',      // 戳脸 → 单手抬到脸旁（捂脸）
  chest: 'handsTogether',  // 戳胸 → 双手交叠在身前
  hand: 'peaceSign',       // 碰手 → 比耶
  body: 'salute',          // 戳腰 → 单手打招呼
  skirt: 'turnBody',       // 戳裙 → 转身（裙子只跟着身体动）
  legs: 'lowerArm',        // 戳腿 → 放下手臂
};

function matchCombo(part) {
  const now = performance.now();
  tapHistory = tapHistory.filter(entry => now - entry.at < COMBO_WINDOW_MS);
  tapHistory.push({ part, at: now });
  for (const pattern of COMBO_PATTERNS) {
    const tail = tapHistory.slice(-pattern.seq.length).map(entry => entry.part);
    if (tail.length === pattern.seq.length && tail.every((p, i) => p === pattern.seq[i])) {
      tapHistory = [];
      return pattern.kind;
    }
  }
  // Keep the window short enough that an old tap cannot join a later gesture.
  if (tapHistory.length > 6) tapHistory.shift();
  return null;
}

function partAt(clientX, clientY) {
  const canvas = $('model');
  if (!canvas) return null;
  const box = canvas.getBoundingClientRect();
  if (box.width <= 0 || box.height <= 0) return null;
  const nx = (clientX - box.left) / box.width, ny = (clientY - box.top) / box.height;
  if (nx < 0 || nx > 1 || ny < 0 || ny > 1) return null;
  for (const region of PART_REGIONS) {
    if (nx >= region.x && nx <= region.x + region.w && ny >= region.y && ny <= region.y + region.h) return region.id;
  }
  return null;
}
/**
 * Is the pointer over the character, or over any piece of chrome?
 *
 * Anything outside both should let clicks fall through to the window below, which
 * is the whole point of a transparent pet. The inset keeps the edges of the
 * canvas from counting, since the character does not reach them.
 */
function overPet(clientX, clientY) {
  if (partAt(clientX, clientY)) return true;
  for (const node of [$('quick-bar'), $('ambient-bubble'), $('open'), $('invitation'), $('work-badge'), $('model-resize'), $('thinking-indicator')]) {
    if (!node || node.hidden) continue;
    const box = node.getBoundingClientRect();
    if (box.width > 0 && box.height > 0 && clientX >= box.left && clientX <= box.right && clientY >= box.top && clientY <= box.bottom) return true;
  }
  // The chat drawer covers the whole window when it is open.
  if (!$('drawer').hidden) return true;
  return false;
}
let ignoringMouse = null;
/**
 * Everything the user can currently click, in window CSS pixels.
 *
 * Sent to the main process so it can decide click-through by itself. Reporting
 * rectangles rather than reacting to events is what makes recovery reliable: the
 * window that is ignoring the mouse cannot be trusted to notice that it should stop.
 */
function interactiveRects() {
  const rects = [];
  const canvas = $('model');
  if (canvas) {
    const box = canvas.getBoundingClientRect();
    if (box.width > 0 && box.height > 0) {
      for (const region of PART_REGIONS) {
        rects.push({ x: box.left + region.x * box.width, y: box.top + region.y * box.height, w: region.w * box.width, h: region.h * box.height });
      }
    }
  }
  for (const id of ['quick-bar', 'ambient-bubble', 'open', 'invitation', 'work-badge', 'model-resize', 'thinking-indicator']) {
    const node = $(id);
    if (!node || node.hidden) continue;
    const box = node.getBoundingClientRect();
    if (box.width > 0 && box.height > 0) rects.push({ x: box.left, y: box.top, w: box.width, h: box.height });
  }
  if (!$('drawer').hidden) rects.push({ x: 0, y: 0, w: window.innerWidth, h: window.innerHeight });
  return rects;
}
function syncPassthrough(clientX, clientY) {
  // Never while dragging. The pointer leaves the character almost immediately, and
  // switching to click-through at that moment stops the window receiving the very
  // move events the drag is built from - the pet would stick after a few pixels.
  if (pointer) return;
  const ignore = !overPet(clientX, clientY);
  if (ignore === ignoringMouse) return;
  ignoringMouse = ignore;
  native('shell', { type: 'passthrough', ignore });
}
// Replaced by a main-process cursor poll; see updatePassthrough() in electron/main.mjs.
// Re-evaluate whenever the chrome changes shape, so a closing panel does not
// leave the window permanently click-through.

let pointer;
$('character').onpointerdown = e => {
  displayWhenDragStarted = displayKey();
  // The pointer is provably on the character, so make sure the window is
  // listening before the drag begins.
  if (ignoringMouse !== false) { ignoringMouse = false; native('shell', { type: 'passthrough', ignore: false }); }
  pointer = { x: e.screenX, y: e.screenY, moved: false, part: partAt(e.clientX, e.clientY) }; try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* capture is optional */ }
};
$('character').onpointermove = e => { if (!pointer) return; const dx = e.screenX - pointer.x, dy = e.screenY - pointer.y; if (Math.abs(dx) + Math.abs(dy) > 3 || pointer.moved) { pointer.moved = true; native('shell', { type: 'drag', dx, dy }); pointer.x = e.screenX; pointer.y = e.screenY; } };
// Capture loss is the normal end of a drag that left the window; in that case no
// pointerup arrives at all, so the drag reaction is handled here.
//
// It must NOT clear `pointer` on a normal click. This handler fires just before
// pointerup when setPointerCapture was used, and clearing it there made pointerup
// see no press and return silently - which is what turned every click into a no-op.
let captureLostAt = 0;
$('character').onpointercancel = $('character').onlostpointercapture = () => {
  if (!pointer) return;
  captureLostAt = performance.now();
  // Give pointerup a moment to arrive and handle the click itself.
  setTimeout(() => {
    if (!pointer || performance.now() - captureLostAt < 60) return;
    const wasDrag = pointer.moved === true;
    pointer = null;
    if (!wasDrag) return;
    const line = ambient?.reaction({ kind: 'drag' });
    if (line) showAmbient({ ...line, groupId: 'reaction' }, { durationMs: 4600, keepWaiting: true });
  }, 90);
};
// A tap on the character is an interaction, not a panel toggle: the pet answers
// with a matching action and line. The panel still opens from the "？怎么了"
// button below the model.
//
// Tap, drag-release and double-tap must all be decided in ONE handler. They were
// split across `onpointerup` and a separate `addEventListener`, and the property
// handler runs first — it cleared `pointer` before the drag listener could read
// `pointer.moved`, so dragging her somewhere and letting go did nothing at all.
$('character').onpointerup = event => {
  const wasDrag = pointer?.moved === true;
  // Captured before the pointer is cleared. This line was missing, so every
  // pointerup threw "wasPointer is not defined" and swallowed the click.
  const wasPointer = pointer;
  const hadPointer = Boolean(pointer);
  pointer = null;
  if (event.detail > 1) return;                                  // dblclick owns this
  if (!hadPointer) return;
  // Where they touched decides what she does. A drag is still a drag regardless.
  if (!wasDrag) { reactToPart(wasPointer?.part ?? null); return; }
  // Order matters: arriving on another monitor is the most interesting thing that
  // just happened, then being parked against an edge, then a plain drag.
  const kind = crossedDisplay() ? 'monitor' : nearDisplayEdge() ? 'edge' : 'drag';
  const line = ambient?.reaction({ kind });
  if (line) showAmbient({ ...line, groupId: 'reaction' }, { durationMs: 5000, keepWaiting: true });
};
// Double tap: a delighted reaction, distinct from a single poke.
$('character').ondblclick = () => {
  const line = ambient?.reaction({ kind: 'double' });
  if (line) showAmbient({ ...line, groupId: 'reaction' }, { durationMs: 5200, keepWaiting: true });
};
// Scrolling over her. Throttled: a wheel gesture fires dozens of events and she
// should comment once, not once per notch.
let lastWheelAt = 0;
$('character').onwheel = event => {
  event.preventDefault();
  const now = performance.now();
  if (now - lastWheelAt < 4000) return;
  lastWheelAt = now;
  const line = ambient?.reaction({ kind: 'scroll' });
  if (line) showAmbient({ ...line, groupId: 'reaction' }, { durationMs: 5000, keepWaiting: true });
};
// Right click. The default Chromium menu is suppressed: on a frameless pet it
// looks like a bug rather than a feature.
$('character').oncontextmenu = event => {
  event.preventDefault();
  const line = ambient?.reaction({ kind: 'right' });
  if (line) showAmbient({ ...line, groupId: 'reaction' }, { durationMs: 5200, keepWaiting: true });
};

/**
 * Which display the pet is on, as a stable key.
 *
 * window.screen reports the display the window currently occupies, so a change in
 * these four numbers means she was carried to another monitor.
 */
function displayKey() {
  const s = globalThis.screen ?? {};
  return [s.availLeft, s.availTop, s.availWidth, s.availHeight].join(':');
}
let displayWhenDragStarted = displayKey();
function crossedDisplay() {
  const now = displayKey();
  if (now === displayWhenDragStarted) return false;
  displayWhenDragStarted = now;
  return true;
}
/** Which edge, if any, she is currently parked against. */
function nearDisplayEdge() {
  const s = globalThis.screen;
  if (!s || !Number.isFinite(s.availWidth)) return null;
  const left = s.availLeft ?? 0, top = s.availTop ?? 0;
  const right = left + s.availWidth, bottom = top + s.availHeight;
  const x = globalThis.screenX, y = globalThis.screenY, gap = 14;
  if (x <= left + gap) return 'left';
  if (x + globalThis.outerWidth >= right - gap) return 'right';
  if (y <= top + gap) return 'top';
  if (y + globalThis.outerHeight >= bottom - gap) return 'bottom';
  return null;
}

const editing = target => ['INPUT', 'TEXTAREA', 'SELECT'].includes(target?.tagName) || target?.isContentEditable || ['view-full', 'view-half', 'model-resize', 'management'].includes(target?.id);
document.addEventListener('keydown', e => {
  const receivedAt=performance.now();
  // Ctrl+Shift+P walks through every limb action. Easy to hit repeatedly while
  // watching the character, which is what makes the rig testable by hand.
  if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'p') {
    e.preventDefault();
    void previewAllActions();
    return;
  }
  if(e.key==='Tab'&&records.isOpen){records.tab(e);return;}
  if(e.key==='Escape'&&records.isOpen){e.preventDefault();e.stopPropagation();records.close();return;}
  if (e.key === 'Escape' && display.cancel(e)) return;
  if (bindingKey || composing || e.isComposing || e.keyCode === 229) return;
  if (!editing(e.target) && !e.metaKey && !e.ctrlKey && !e.altKey && timedVoiceInput(receivedAt,'keyboard',()=>hold.down(e.code,e.repeat))) { e.preventDefault(); e.stopPropagation(); return; }
  if (e.key === 'Escape') { if (playback.busy || capturing || voicePhase !== 'idle' || view.scope) command({ type: 'cancel' }); else panel(false); }
}, true);
document.addEventListener('keyup', e => { if (hold.up(e.code)) { e.preventDefault(); e.stopPropagation(); } }, true);
document.addEventListener('focusin', e => { if (editing(e.target)) hold.cancel(); });
window.addEventListener('blur', () => { hold.cancel(); display.cancel(); pointer = null; });
document.addEventListener('visibilitychange', () => { introductionEpoch++; introductionFramePending = false; if (document.hidden) { hold.cancel(); display.cancel(); pointer = null; } else scheduleIntroductionAck(); });
window.addEventListener('pagehide', () => { display.cancel(); connectionChanged({ generation: connection.generation, state: 'disconnected' }); void stopPlayback(); stopCapture(); renderer?.dispose(); });
window.addEventListener('error', e => report({ type: 'script-error', message: e.message }));
window.addEventListener('unhandledrejection', e => report({ type: 'promise-error', message: String(e.reason) }));
renderUI(); native('shell', { type: 'ready' });
let frame = 0, lastRender = 0;
try {
  // A model that will not load must not take the rest of the app with it. The
  // dialogue library, the reactions and the speech are all model-independent, so a
  // failure here degrades to "no character on screen" rather than "nothing works".
  renderer = new JellyfishRenderer($('model'), report);
  try {
    await renderer.load();
  } catch (error) {
    report({ type: 'model-error', message: String(error?.message ?? error).slice(0, 160) });
    renderer = null;
  }
  applyPresentationPolicy(); renderer.setFraming(display.mode);
  // 模型这时才加载完，纹理图也解码好了 —— 面板配色就取它。
  //
  // 这里用 setTimeout 是有原因的：applyModelTheme 是 const，定义在文件靠后的位置，
  // 直接在这里调用会撞上暂时性死区（之前就是这么静默失败的）。推迟到脚本全部求值
  // 之后再调，就没有这个问题。
  setTimeout(() => {
    void (async () => {
      for (let i = 0; i < 10; i++) {
        if (await applyModelTheme()) return;
        await new Promise(done => setTimeout(done, 400));
      }
    })();
  }, 1200);
  // The opening prompt used to appear above an empty canvas, which read as the
  // pet demanding attention before it had even shown up. Fade the greeting first
  // and only reveal the button once there is a character to attach it to.
  $('loading').dataset.fading = 'true';
  setTimeout(() => { $('loading').hidden = true; }, 350);
  $('open').hidden = false;
  // Ambient config is optional: a missing ambient.json just means a quiet pet.
  ambientConfig = await loadAmbientConfig();
  if (ambientConfig) { ambient = new AmbientScheduler(ambientConfig); ambient.setRapport(rapportState); ambient.noteInteraction(); console.info('[ambient] ready, rapport=' + JSON.stringify({ streak: rapportState.streak, answered: rapportState.answered, ignored: rapportState.ignored })); }
  else console.warn('[ambient] disabled (no config)');
  // Poll the real system state. Two hertz is plenty: idle time is reported in
  // whole seconds and the eyes only need to look responsive, not instant.
  // 10 Hz. At 2 Hz the look-at target only moved twice a second, so even a
  // perfectly smooth easing could only produce "step, glide, step, glide".
  systemStateTimer = setInterval(() => native('shell', { type: 'system_state' }), 100);
  native('shell', { type: 'system_state' });
  // Reflect the real registry state rather than a remembered preference.
  native('shell', { type: 'autostart' });
  // --- Settings panel -------------------------------------------------------
  // Edits ambient.json through the main process, then re-reads it so the change
  // takes effect at once. Previously every tweak meant hand-editing JSON, running
  // refresh:runtime and restarting the pet.
  const settingsFields = {
    minIntervalMs: $('ps-min'), maxIntervalMs: $('ps-max'), idleAfterMs: $('ps-idle'), lineDurationMs: $('ps-line'),
    userName: $('ps-name'), quietManual: $('ps-quiet'), quietFullscreen: $('ps-quietfs'), sfx: $('ps-sfx'), voice: $('ps-voice'),
    voiceName: $('ps-voice-name'), sfxVolume: $('ps-sfxvol'), voiceRate: $('ps-voice-rate'), voiceVolume: $('ps-vol'),
  };
  // Kept at this scope so the config handler below can refresh the quick slider
  // after the settings have been loaded; it initialises before the fetch resolves.
  /**
   * Apply a voice-volume change everywhere it matters.
   *
   * The cached-clip path reads the setting when it plays, so it needs nothing. The
   * fallback speaker holds a snapshot, so it has to be told.
   */
  function applyVoiceVolume(value) {
    const level = Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 1;
    if (ambientConfig?.speech) ambientConfig.speech.volume = level;
    speaker?.setVolume?.(level);
    syncVolumeFromConfig(ambientConfig);
  }
  function syncVolumeFromConfig(config) {
    const range = $('qb-volume-range'), out = $('qb-volume-out');
    if (!range) return;
    const percent = Math.round(Math.max(0, Math.min(1, config?.speech?.volume ?? 1)) * 100);
    range.value = percent;
    if (out) out.value = percent;
  }
  function fillSettingsPanel(config) {
    const seconds = ms => Math.max(1, Math.round(ms / 1000));
    const speech = config?.speech ?? {}, quiet = config?.quiet ?? {};
    if (settingsFields.minIntervalMs) settingsFields.minIntervalMs.value = seconds(config?.minIntervalMs ?? 45000);
    if (settingsFields.maxIntervalMs) settingsFields.maxIntervalMs.value = seconds(config?.maxIntervalMs ?? 120000);
    if (settingsFields.idleAfterMs) settingsFields.idleAfterMs.value = seconds(config?.idleAfterMs ?? 20000);
    if (settingsFields.lineDurationMs) settingsFields.lineDurationMs.value = seconds(config?.lineDurationMs ?? 9000);
    if (settingsFields.userName) settingsFields.userName.value = config?.profile?.userName ?? '';
    if (settingsFields.quietManual) settingsFields.quietManual.checked = quiet.manual === true;
    if (settingsFields.quietFullscreen) settingsFields.quietFullscreen.checked = quiet.fullscreen !== false;
    if (settingsFields.sfx) settingsFields.sfx.checked = speech.sfx?.enabled === true;
    syncVolumeFromConfig(config);
    speaker?.setVolume?.(Number.isFinite(config?.speech?.volume) ? config.speech.volume : 1);
    if (settingsFields.voice) settingsFields.voice.checked = speech.cacheFirst === true;
    if (settingsFields.voiceName) settingsFields.voiceName.value = speech.cloudVoice ?? 'Chelsie';
    if (settingsFields.sfxVolume) { settingsFields.sfxVolume.value = Math.round((speech.sfx?.volume ?? .7) * 100); }
    if ($('ps-sfxvol-out')) $('ps-sfxvol-out').value = Math.round((speech.sfx?.volume ?? .7) * 100);
    if (settingsFields.voiceVolume) { settingsFields.voiceVolume.value = Math.round((speech.volume ?? 1) * 100); }
    if ($('ps-vol-out')) $('ps-vol-out').value = Math.round((speech.volume ?? 1) * 100);
    if (settingsFields.voiceRate) { settingsFields.voiceRate.value = Math.round((speech.voiceRate ?? 1) * 100); }
    if ($('ps-voice-rate-out')) $('ps-voice-rate-out').value = Math.round((speech.voiceRate ?? 1) * 100);
  }
  // Live read-outs for the two sliders, so dragging gives immediate feedback.
  $('ps-sfxvol') && ($('ps-sfxvol').oninput = event => { $('ps-sfxvol-out').value = event.target.value; });
  // Live, matching the toolbar. The value is still persisted by 保存, but the
  // sound changes as the slider moves so the two controls behave the same way.
  /**
   * Model size.
   *
   * The corner handle already resizes the model; this exposes the same thing as a
   * number in the panel, where every other adjustable quantity lives. Both go
   * through the same host message, so they cannot drift apart.
   */
  const scaleSlider = $('ps-scale'), scaleOut = $('ps-scale-out');
  const SCALE_BASE_WIDTH = 360;
  const applyScale = percent => {
    const pct = Math.max(50, Math.min(220, Math.round(Number(percent) || 100)));
    if (scaleOut) scaleOut.value = pct;
    // The host only acts on resize_model once a 'begin' has set its baseline: without
    // it the whole branch is skipped and the slider does nothing. 'begin' captures the
    // current width, 'commit' applies the new one and persists it.
    native('shell', { type: 'resize_model', phase: 'begin' });
    native('shell', { type: 'resize_model', phase: 'commit', width: Math.round(SCALE_BASE_WIDTH * pct / 100) });
  };
  scaleSlider && (scaleSlider.oninput = event => {
    if (scaleOut) scaleOut.value = event.target.value;
  });
  scaleSlider && (scaleSlider.onchange = event => applyScale(event.target.value));

  $('ps-vol') && ($('ps-vol').oninput = event => {
    $('ps-vol-out').value = event.target.value;
    applyVoiceVolume(Number(event.target.value) / 100);   // ps-vol-live
  });
  $('ps-voice-rate') && ($('ps-voice-rate').oninput = event => { $('ps-voice-rate-out').value = event.target.value; });
  // Reset the relationship. Rapport, mood and the unlocked stage live in
  // localStorage, so there was previously no way back to a first meeting short of
  // clearing site data by hand.
  /**
   * The rest of the settings panel.
   *
   * Everything here was previously reachable only from the tray, the console or a
   * keyboard shortcut. Grouping it in the panel means a new user can find it, which
   * matters more than the few hundred bytes it costs.
   */

  /**
   * 面板尺寸与透明度。
   *
   * 尺寸用 CSS 变量控制，拖右下角改变；透明度同理。两者都写进 localStorage，
   * 下次打开还是这个样子 —— 原来尺寸是写死的，用户完全改不了。
   */
  const PANEL_KEY = 'aaaagent.panelBox';
  const readBox = () => {
    try { return JSON.parse(localStorage.getItem(PANEL_KEY)) ?? {}; } catch { return {}; }
  };
  const writeBox = box => {
    try { localStorage.setItem(PANEL_KEY, JSON.stringify(box)); } catch { /* 隐私模式 */ }
  };
  const applyBox = box => {
    const root = document.documentElement;
    if (box.w) root.style.setProperty('--panel-w', box.w + 'px');
    if (box.h) root.style.setProperty('--panel-h', box.h + 'px');
    if (box.alpha) {
      root.style.setProperty('--panel-alpha', String(box.alpha / 100));
      const slider = $('ps-alpha'), out = $('ps-alpha-out');
      if (slider) slider.value = box.alpha;
      if (out) out.value = box.alpha;
    }
  };
  applyBox(readBox());

  const panelGrip = $('panel-grip');
  const drawer = $('drawer');
  if (panelGrip && drawer) {
    panelGrip.addEventListener('pointerdown', start => {
      start.preventDefault();
      start.stopPropagation();
      // setPointerCapture 在合成事件（自动化、部分触控板）上会抛异常，
      // 之前它一抛，下面的拖动监听就全部没装上。抓不住就退回普通拖动。
      try { panelGrip.setPointerCapture(start.pointerId); } catch { /* 退回普通拖动 */ }
      const rect = drawer.getBoundingClientRect();
      const origin = { x: start.clientX, y: start.clientY, w: rect.width, h: rect.height };
      const move = event => {
        // 右下角拖动：往右下变大。上下限同时受窗口大小约束。
        const w = Math.max(240, Math.min(window.innerWidth - 16, origin.w + (event.clientX - origin.x)));
        const h = Math.max(220, Math.min(window.innerHeight - 16, origin.h + (event.clientY - origin.y)));
        document.documentElement.style.setProperty('--panel-w', w + 'px');
        document.documentElement.style.setProperty('--panel-h', h + 'px');
      };
      const end = () => {
        panelGrip.removeEventListener('pointermove', move);
        panelGrip.removeEventListener('pointerup', end);
        panelGrip.removeEventListener('pointercancel', end);
        const root = getComputedStyle(document.documentElement);
        writeBox({
          ...readBox(),
          w: parseInt(root.getPropertyValue('--panel-w'), 10) || undefined,
          h: parseInt(root.getPropertyValue('--panel-h'), 10) || undefined,
        });
      };
      panelGrip.addEventListener('pointermove', move);
      panelGrip.addEventListener('pointerup', end);
      panelGrip.addEventListener('pointercancel', end);
    });
    $('ps-size-reset') && ($('ps-size-reset').onclick = () => {
      document.documentElement.style.removeProperty('--panel-w');
      document.documentElement.style.removeProperty('--panel-h');
      const box = readBox();
      delete box.w; delete box.h;
      writeBox(box);
    });
  }

  const alphaSlider = $('ps-alpha'), alphaOut = $('ps-alpha-out');
  alphaSlider && (alphaSlider.oninput = event => {
    const v = Number(event.target.value) || 88;
    if (alphaOut) alphaOut.value = v;
    document.documentElement.style.setProperty('--panel-alpha', String(v / 100));
  });
  alphaSlider && (alphaSlider.onchange = event => {
    writeBox({ ...readBox(), alpha: Number(event.target.value) || 88 });
  });

  /**
   * 让面板配色跟着模型走。
   *
   * 纹理地址取自模型的 model3.json，不写死文件名。取色在离屏 canvas 上完成：
   * 反复降采样到很小，统计色相直方图，挑出出现最多的饱和色相当强调色，
   * 再把它的暗调版本当作底色 —— 这样面板和角色是同一族颜色。
   */
  const applyModelTheme = async () => {
    try {
      // 渲染器已经把纹理图片解码好了，直接用 —— 它用的路径是
      // settings.getTextureFileName(i)，不会因为模型换文件名而失效。
      const image = renderer?.textureImages?.[0] ?? null;
      if (!image || !image.width) return false;

      // 降到 64×64 再统计：足够看出主色，又不会被细节噪声带偏。
      const canvas = document.createElement('canvas');
      canvas.width = 64; canvas.height = 64;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(image, 0, 0, 64, 64);
      const { data } = ctx.getImageData(0, 0, 64, 64);

      const hueBins = new Array(36).fill(0);
      let darkSum = [0, 0, 0], darkN = 0;
      for (let i = 0; i < data.length; i += 4) {
        const a = data[i + 3];
        if (a < 24) continue;                       // 透明部分不计
        const r = data[i] / 255, g = data[i + 1] / 255, b = data[i + 2] / 255;
        const max = Math.max(r, g, b), min = Math.min(r, g, b);
        const l = (max + min) / 2;
        const s = max === min ? 0 : (l > 0.5 ? (max - min) / (2 - max - min) : (max - min) / (max + min));
        if (l < 0.22) { darkSum[0] += r; darkSum[1] += g; darkSum[2] += b; darkN++; continue; }
        if (s < 0.28 || l < 0.15) continue;         // 只要够鲜艳的
        let h;
        if (max === r) h = ((g - b) / (max - min) + 6) % 6;
        else if (max === g) h = (b - r) / (max - min) + 2;
        else h = (r - g) / (max - min) + 4;
        hueBins[Math.round((h * 60) / 10) % 36] += 1 + s;   // 越鲜艳权重越高
      }

      let best = 0;
      for (let i = 1; i < hueBins.length; i++) if (hueBins[i] > hueBins[best]) best = i;
      const hue = best * 10;
      const root = document.documentElement;

      if (hueBins[best] > 0) {
        root.style.setProperty('--accent', `hsl(${hue} 58% 52%)`);
        root.style.setProperty('--accent-soft', `hsl(${hue} 58% 52% / .20)`);
      }
      if (darkN > 0) {
        // 底色调成模型暗部的同族颜色，而不是中性灰。
        const r = Math.round(darkSum[0] / darkN * 255);
        const g = Math.round(darkSum[1] / darkN * 255);
        const b = Math.round(darkSum[2] / darkN * 255);
        root.style.setProperty('--panel-tint', `${r} ${g} ${b}`);
        root.style.setProperty('--accent', `hsl(${hue} 58% 52%)`);
      }
      report({ type: 'model-theme', hue, hasDark: darkN > 0 });
      return hueBins[best] > 0;
    } catch (error) {
      // 取不到色就用默认主题，不影响使用。
      report({ type: 'model-theme', error: String(error?.message ?? error).slice(0, 80) });
      return false;
    }
  };

  // --- 取景 ---
  const setMode = mode => {
    native('shell', { type: 'set_display', mode });
    for (const [id, m] of [['ps-mode-half', 'half'], ['ps-mode-full', 'full']]) {
      const button = $(id);
      if (button) button.setAttribute('aria-pressed', String(m === mode));
    }
  };
  $('ps-mode-half') && ($('ps-mode-half').onclick = () => setMode('half'));
  $('ps-mode-full') && ($('ps-mode-full').onclick = () => setMode('full'));

  // --- 动作预览：直接复用已有的预览序列 ---
  $('ps-preview-actions') && ($('ps-preview-actions').onclick = () => { void previewAllActions(); });

  // --- 手机访问 ---
  let remoteRunning = false;
  const syncRemoteButton = () => {
    const button = $('ps-remote-toggle');
    if (button) button.textContent = remoteRunning ? '关闭手机访问' : '开启手机访问';
  };
  $('ps-remote-toggle') && ($('ps-remote-toggle').onclick = () => {
    if (remoteRunning) native('shell', { type: 'remote_chat', action: 'stop' });
    else native('shell', { type: 'remote_chat', action: 'start' });
  });
  // The host reports the outcome; the button follows it rather than guessing.
  window.petBridge.remoteChatStatus = value => {
    remoteRunning = value?.running === true;
    syncRemoteButton();
    const hint = $('ps-remote-hint');
    if (hint && value?.url) hint.textContent = '手机访问地址：' + value.url;
    else if (hint && !remoteRunning) hint.textContent = '同一局域网内的手机浏览器可打开聊天页，与桌面共享记忆。';
  };
  syncRemoteButton();

  // --- 诊断 ---
  $('ps-open-log') && ($('ps-open-log').onclick = () => native('shell', { type: 'open_log' }));
  $('ps-about') && ($('ps-about').onclick = () => {
    const hint = $('ps-diagnostic-hint');
    if (hint) hint.textContent = '烛 · 桌面宠物 — 本地模型 + 1008 句配音 + 记忆系统。日志：windows\.local\logs\electron.log';
  });

  $('ps-reset') && ($('ps-reset').onclick = () => {
    try {
      localStorage.removeItem(RAPPORT_KEY);
      localStorage.removeItem('aaaagent-ambient-mood');
      localStorage.removeItem('aaaagent-ambient-stage');
      for (const key of Object.keys(localStorage)) if (key.startsWith('aaaagent-ambient-')) localStorage.removeItem(key);
      settingsNotice('已重置关系，从现在起重新认识');
      void reloadAmbientConfig();
    } catch (error) { settingsNotice('重置失败：' + error.message, true); }
  });
  function settingsNotice(message, bad) {
    const node = $('ps-state'); if (!node) return;
    node.textContent = message; node.hidden = false; node.classList.toggle('ps-error', bad === true);
    setTimeout(() => { if (node.textContent === message) node.hidden = true; }, 4000);
  }
  $('ps-reload') && ($('ps-reload').onclick = () => { native('shell', { type: 'ambient_config', action: 'load' }); settingsNotice('已重新载入'); });
  $('ps-save') && ($('ps-save').onclick = () => {
    const num = (field, min, max, fallback) => { const v = Math.round(Number(field?.value)); return Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback; };
    const patch = {
      minIntervalMs: num(settingsFields.minIntervalMs, 5, 600, 45) * 1000,
      maxIntervalMs: num(settingsFields.maxIntervalMs, 5, 600, 120) * 1000,
      idleAfterMs: num(settingsFields.idleAfterMs, 0, 600, 20) * 1000,
      lineDurationMs: num(settingsFields.lineDurationMs, 2, 60, 9) * 1000,
      'profile.userName': String(settingsFields.userName?.value ?? '').trim().slice(0, 24),
      'quiet.manual': settingsFields.quietManual?.checked === true,
      'quiet.fullscreen': settingsFields.quietFullscreen?.checked !== false,
      'speech.sfx.enabled': settingsFields.sfx?.checked === true,
      'speech.cacheFirst': settingsFields.voice?.checked === true,
      'speech.cloudVoice': String(settingsFields.voiceName?.value ?? 'Chelsie'),
      'speech.voiceRate': Math.round(Number(settingsFields.voiceRate?.value ?? 100)) / 100,
      'speech.sfx.volume': Math.round(Number(settingsFields.sfxVolume?.value ?? 70)) / 100,
      'speech.volume': Math.round(Number(settingsFields.voiceVolume?.value ?? 100)) / 100,
    };
    // The upper bound must not fall below the lower one.
    if (patch.maxIntervalMs < patch.minIntervalMs) patch.maxIntervalMs = patch.minIntervalMs;
    native('shell', { type: 'ambient_config', action: 'save', patch });
    settingsNotice('已保存，立即生效');
  });
  // Commands issued from the tray menu. They arrive already applied in the main
  // process, so this only has to keep the UI in step.
  window.petBridge.trayCommand = value => {
    if (!value || typeof value !== 'object') return;
    if (value.type === 'panel') { panel(value.open === true); return; }
    if (value.type === 'display') { renderer?.setFraming(value.mode); renderUI(); return; }
    // Tray / shortcut entry: walk through every limb action so the rig can be
    // checked in one pass.
    if (value.type === 'previewActions') { void previewAllActions(); return; }
    if (value.type === 'needRemote') { native('shell', { type: 'remote_chat', action: 'start' }); return; }
    if (value.type === 'quiet') {
      const manual = $('ps-quiet'), fullscreen = $('ps-quietfs');
      if (manual) manual.checked = value.manual === true;
      if (fullscreen) fullscreen.checked = value.fullscreen !== false;
      if (ambientConfig?.quiet) { ambientConfig.quiet.manual = value.manual === true; ambientConfig.quiet.fullscreen = value.fullscreen !== false; }
      settingsNotice(value.manual ? '已开启免打扰' : '已关闭免打扰');
    }
  };
  // --- LAN chat bridge -------------------------------------------------
  // Incoming text from the phone. Routed through the normal submit path so the
  // renderer's memory, rapport and dialogue state all see it as a real turn.
  window.petBridge.remoteChat = value => {
    const text = typeof value?.text === 'string' ? value.text.trim().slice(0, 500) : '';
    if (!text) return;
    try {
      // The LAN reply path once failed with no trace anywhere, so each step now
      // leaves evidence in the diagnostic log.
      native('shell', { type: 'remote_trace', step: 'received', detail: text.slice(0, 40) });
      command({ type: 'submit_text', text });
      native('shell', { type: 'remote_trace', step: 'submitted' });
    } catch (error) { native('shell', { type: 'remote_trace', step: 'failed', detail: String(error?.message ?? error).slice(0, 120) }); }
  };
  window.petBridge.remoteChatStatus = value => {
    if (value?.running) settingsNotice?.('手机访问已开启');
  };
  window.petBridge.autoStart = value => {    const node = $('ps-autostart');
    if (!node) return;
    if (value?.ok === true) { node.checked = value.enabled === true; settingsNotice(value.enabled ? '已开启开机自启' : '已关闭开机自启'); }
    else settingsNotice('设置开机自启失败', true);
  };
  $('ps-autostart') && ($('ps-autostart').onchange = event => {
    native('shell', { type: 'autostart', action: 'set', enabled: event.target.checked === true });
  });
  window.petBridge.ambientConfig = value => {
    if (!value || value.ok !== true) { settingsNotice('读写设置失败', true); return; }
    if (value.action === 'save') { settingsNotice('已保存'); void reloadAmbientConfig(); return; }
    fillSettingsPanel(value.config);
  };
  // --- Idle gestures --------------------------------------------------------
  // Actions used to fire only alongside a line, and lines are 25-60 seconds
  // apart, so the pet mostly stood still. This plays a pose on its own timer.
  let gestureNextAt = 0;
  function tickGestures() {
    if (!ambient || !ambientConfig) return;
    const now = performance.now();
    if (gestureNextAt === 0) { gestureNextAt = now + 6000; return; }
    if (now < gestureNextAt) return;
    const min = ambientConfig.gestureMinIntervalMs ?? 9000;
    const max = Math.max(min, ambientConfig.gestureMaxIntervalMs ?? 22000);
    gestureNextAt = now + min + Math.random() * (max - min);
    // A gesture never talks, so it only plays while nothing else is on screen.
    if (ambient.active() || ambientDisplay || view.state !== 'idle') return;
    // Skip eye-taking actions for a moment after the pointer stops, so a gesture
    // never lands on top of a follow the user is still watching.
    const pointerRecently = performance.now() - cursorMovedAt < 1800;
    const gesture = ambient.gesture({ excludeGaze: pointerRecently });
    if (gesture?.action) renderer?.playAmbient?.(gesture.action);
  }
  async function reloadAmbientConfig() {    const fresh = await loadAmbientConfig();
    if (!fresh) return;
    ambientConfig = fresh;
    if (ambient) { ambient = new AmbientScheduler(fresh); ambient.setRapport(rapportState); ambient.noteInteraction(); }
    fillSettingsPanel(fresh);
  }
  // Called only now, after `settingsFields` exists: reaching it earlier hit the
  // temporal dead zone, which aborted the whole init block and left the panel
  // empty and the config bridge undefined.
  fillSettingsPanel(ambientConfig);
  // Tapping the character answers immediately with a matched action and line.
  reactToPart = part => {
    if (!ambient) return;
    if (!['idle', 'error'].includes(view.state) || playback.busy) return;
    // Cut whatever is being said right now. Without this the previous clip kept
    // playing underneath the new one and two voices overlapped.
    stopLocalSpeech();
    cancelPendingReplySpeech();
    // A short blip confirms the tap registered; it shares the voice's audio
    // context so it never sounds louder than the pet.
    const sfxConfig = ambientConfig?.speech?.sfx ?? {};
    if (sfxConfig.enabled === true && sfxConfig.tap !== false) playSfx('tap');
    // An open exchange takes priority: the pet asked something, so a tap is the
    // answer to that question rather than a fresh greeting.
    if (ambientWaiting) {
      const pending = ambientWaiting; clearWaiting();
      // Answering after being ignored should feel like a reunion, not a reset.
      rapportState.streak = rapportState.streak < 0 ? 1 : Math.max(1, Math.min(6, rapportState.streak + 1));
      rapportState.answered++; saveRapport();
      playExchange(pending.reply);
      return;
    }
    // Poking her over and over should escalate rather than repeat one line: a
    // streak of taps within a few seconds climbs poke2 -> poke5, then resets.
    const now = performance.now();
    pokeStreak = now - lastPokeAt < 2600 ? Math.min(9, pokeStreak + 1) : 1;
    lastPokeAt = now;
    const kind = pokeStreak >= 5 ? 'poke5' : pokeStreak === 4 ? 'poke4' : pokeStreak === 3 ? 'poke3' : pokeStreak === 2 ? 'poke2' : null;
    // Where they touched. Each region has its own register; if a region has no
    // lines of its own the call falls through to the generic pool, so touching an
    // unhandled spot still gets an answer.
    if (part) {
      // A completed gesture outranks the single-tap answer: rubbing her cheek and
      // then poking her chest should read as one act, not two coincidences.
      const combo = matchCombo(part);
      if (combo) {
        const comboLine = ambient.reaction({ kind: combo });
        if (comboLine) { showAmbient({ ...comboLine, groupId: 'reaction' }, { durationMs: 5200, keepWaiting: true }); return; }
      }
      const partLine = ambient.reaction({ kind: 'part:' + part });
      if (partLine) {
        // The limb gesture is forced rather than taken from the line's own list:
        // that list is chosen by the scheduler and sometimes arrives empty, which
        // left the rig motionless when it should have been moving.
        showAmbient({ ...partLine, action: POKE_MOTION[part] ?? partLine.action, groupId: 'reaction' }, { durationMs: 5200, keepWaiting: true });
        return;
      }
    }
    const reaction = ambient.reaction(kind ? { kind } : {});
    if (reaction) showAmbient({ ...reaction, groupId: 'reaction' }, { durationMs: 5200, keepWaiting: true });
  };
  clearWaiting = () => {
    ambientWaiting = null;
    if (ambientWaitTimer !== null) { clearTimeout(ambientWaitTimer); ambientWaitTimer = null; }
  };
  function openWaiting(waiting) {
    clearWaiting();
    if (!waiting || (!waiting.reply && !waiting.ignored && !waiting.remind)) return;
    ambientWaiting = waiting;
    if (waiting.ignored || waiting.remind) ambientWaitTimer = setTimeout(() => {
      ambientWaitTimer = null;
      const pending = ambientWaiting; clearWaiting();
      // Being ignored counts against the rapport, then either the line's own
      // "ignored" answer plays, or a reminder is queued to come back later.
      rapportState.streak = Math.min(-1, rapportState.streak - 1);
      rapportState.ignored++; saveRapport();
      if (pending?.ignored) playExchange(pending.ignored, { keepWaiting: false });
      if (pending?.remind) {
        if (ambientRemindTimer !== null) clearTimeout(ambientRemindTimer);
        ambientRemindTimer = setTimeout(() => { ambientRemindTimer = null; playExchange(pending.remind, { keepWaiting: false }); }, pending.remind.afterMs);
      }
    }, waiting.timeoutMs);
  }
  /**
   * Plays one branch of an exchange. The branch keeps its own `waiting`, so a
   * reply can ask something back — that is what makes a 3-4 turn exchange.
   */
  function playExchange(branch, options = {}) {
    if (!branch) return;
    if (branch.setFlag) { rapportState.flags[branch.setFlag] = Date.now(); saveRapport(); }
    showAmbient({ groupId: 'exchange', text: branch.text, waiting: branch.waiting,
      action: branch.actions?.length ? branch.actions[Math.floor(Math.random() * branch.actions.length)] : null },
      { durationMs: 5200, keepWaiting: options.keepWaiting === true });
  }
  speaker = new LocalSpeaker(ambientConfig?.speech ?? {});
  // Chromium fills the voice list asynchronously, so report it once it settles.
  if (speaker.enabled) setTimeout(() => console.info('[speech] local voice:', speaker.voiceName ?? 'none available'), 900);
  else console.warn('[speech] local voice unavailable');
  // Cloud audio wins. If playback starts, the local fallback line must not also
  // read the reply aloud, so the pending local utterance is dropped.
  cancelPendingReplySpeech = () => { if (replySpeechTimer !== null) { clearTimeout(replySpeechTimer); replySpeechTimer = null; } speaker?.cancel(); };
  // --- Ambient display -----------------------------------------------------
  // One owner of "what is on screen right now". The scheduler proposes an event;
  // exchange branches and tap reactions push their own. Nothing re-renders the
  // opening line afterwards, which is what used to stamp over the replies.
  let ambientDisplay = null, ambientLastStartedAt = null, ambientHideTimer = null, ambientChainTimer = null;
  const bubbleEl = $('ambient-bubble');
  function hideBubble() {
    if (bubbleEl.dataset.shown !== 'true') { bubbleEl.hidden = true; return; }
    bubbleEl.dataset.shown = 'false';
    if (ambientHideTimer !== null) clearTimeout(ambientHideTimer);
    ambientHideTimer = setTimeout(() => { ambientHideTimer = null; if (bubbleEl.dataset.shown === 'false') bubbleEl.hidden = true; }, 500);
  }
  function showAmbient(event, options = {}) {
    // Recorded so a test can confirm which action was asked for. Block-scoped
    // functions are unreachable from the debugger, so the observation has to be
    // published here rather than read out of the closure.
    // Recorded so a test can confirm which action was asked for. Both spellings are
    // captured: the scheduler emits `action` (singular, one pick) while a line may
    // carry `actions` (plural), and reading only one of them made the rig look idle
    // when it was in fact moving.
    globalThis.__lastAmbient = { text: event?.text ?? null, action: event?.action ?? null, actions: event?.actions ?? [], at: Date.now() };
    if (!event || !event.text) return;
    const durationMs = options.durationMs ?? ambientConfig?.lineDurationMs ?? 9000;
    ambientDisplay = { text: event.text, endsAt: performance.now() + durationMs };
    if (ambientHideTimer !== null) { clearTimeout(ambientHideTimer); ambientHideTimer = null; }
    bubbleEl.textContent = event.text; bubbleEl.hidden = false;
    requestAnimationFrame(() => { if (ambientDisplay?.text === event.text) bubbleEl.dataset.shown = 'true'; });
    // Both spellings are accepted: the scheduler emits `action` (one pick) while
    // a dialogue line carries `actions` (a list). Reading only one of them is what
    // made the preview silent.
    const action = event?.action ?? event?.actions?.[0] ?? null;
    globalThis.__lastAmbientAction = action;
    if (action) renderer?.playAmbient?.(action);
    // Speech order: cached cloud clip (offline, free), then the offline engine,
    // then the OS voice, then a live cloud request.
    const speechConfig = ambientConfig?.speech ?? {};
    ambientSpeechEnabled = speechConfig.cloudAmbient === true;
    const emotion = lineEmotion(event);
    const sfx = speechConfig.sfx ?? {};
    if (sfx.enabled === true && sfx.ambient === true) playSfx('soft');
    if (speechConfig.cacheFirst === true) requestCachedSpeech(event.text, emotion, { autoCache: renderer?.previewMode !== true });
    else if (speechConfig.localEngine === true) speakLocally(event.text, speechConfig.engineVoice, speechConfig.engineSpeed);
    else if (speaker?.wantsAmbient()) speaker.speak(event.text);
    else if (speechConfig.cloudAmbient === true && connection.connected)
      send({ channel: 'command', command: { type: 'ambient_speak', text: event.text } });
    // Lines that expect an answer open a short window: a tap replies, silence
    // gets the "ignored" branch (and possibly a reminder later). Exchange
    // branches open their own window the same way, which chains the turns.
    if (event.setFlag) { rapportState.flags[event.setFlag] = Date.now(); saveRapport(); }
    // Long-term memory: recorded when the line is actually spoken, and kept across
    // restarts so a later conversation can refer back to it.
    if (event.remember) {
      const entries = Array.isArray(event.remember) ? event.remember : [event.remember];
      for (const raw of entries) {
        const spec = typeof raw === 'string' ? { key: raw, strength: 1 } : raw;
        if (!spec || typeof spec.key !== 'string' || !spec.key) continue;
        const prior = rapportState.memory[spec.key];
        const priorStrength = prior && typeof prior === 'object' ? prior.strength ?? 1 : 1;
        // A repeat stores a stronger memory rather than resetting it, which is how
        // the forgetting curve rewards things that keep coming up.
        rapportState.memory[spec.key] = {
          at: Date.now(),
          strength: Math.min(3, priorStrength * 0.5 + (spec.strength ?? 1) * 0.5 + 0.2),
          hits: prior && typeof prior === 'object' ? prior.hits | 0 : 0,
        };
      }
      saveRapport();
    }
    // Recalling a memory reinforces it: talking about something is what keeps it
    // sharp, exactly as the curve above assumes.
    if (event.remembers?.key) {
      const entry = rapportState.memory[event.remembers.key];
      if (entry && typeof entry === 'object') { entry.hits = (entry.hits | 0) + 1; entry.at = Date.now(); saveRapport(); }
    }
    if (!options.keepWaiting) openWaiting(event.waiting);
    // A chain keeps the thought going: the pet says the follow-ups in order
    // instead of stopping after one sentence. This is what makes a line read as
    // talking rather than as an announcement.
    if (Array.isArray(event.chain) && event.chain.length > 0 && !options.noChain) {
      if (ambientChainTimer !== null) { clearTimeout(ambientChainTimer); ambientChainTimer = null; }
      let index = 0;
      const next = () => {
        ambientChainTimer = null;
        const text = event.chain[index++];
        if (!text || view.state !== 'idle' || !$('drawer').hidden) return;
        showAmbient({ text, emotion: event.emotion, action: null }, { durationMs: options.chainDurationMs ?? 4200, keepWaiting: true, noChain: true });
        if (index < event.chain.length) ambientChainTimer = setTimeout(next, (options.chainDurationMs ?? 4200) + 320);
      };
      ambientChainTimer = setTimeout(next, durationMs + 320);
    }
  }
  function tickAmbientDisplay() {
    if (ambientDisplay && performance.now() > ambientDisplay.endsAt) { ambientDisplay = null; hideBubble(); }
  }
  // The cloud voice is authoritative, but it silently produces nothing when its
  // provider call is refused. Give it a moment; if no audio started, read the
  // reply with the local voice so the character is never mute by accident.
  const replyObserver = new MutationObserver(() => {
    // 语音开着就朗读：原来要求 enabled && replies 同时为真，配置里两个默认都是 false，
    // 于是这里永远返回，回复从来没有被念出来过。
    const speechOn = ambientConfig?.speech?.enabled !== false && ambientConfig?.speech?.replies !== false;
    if (!speechOn) return;
    const rows = $('reply').querySelectorAll('.chat-row.assistant');
    const latest = rows[rows.length - 1]?.textContent?.trim() ?? '';
    if (!latest || latest === lastSpokenReply) return;
    lastSpokenReply = latest;
    if (replySpeechTimer !== null) clearTimeout(replySpeechTimer);
    // The reply used to go straight to speaker.speak(), which is the operating system's
    // voice - a flat robot next to the warm cached clips. speak_cached synthesizes
    // through the same cloud voice and caches the result, so a reply sounds like the
    // same person as the small talk. The local voice stays as the fallback for when
    // that produces no audio at all.
    replySpeechTimer = setTimeout(() => {
      replySpeechTimer = null;
      const speechConfig = ambientConfig?.speech ?? {};
      if (speechConfig.cacheFirst !== false) {
        requestCachedSpeech(latest, emotionForText(latest), { autoCache: true });
        setTimeout(() => { if (!localSpeechStarted) speaker?.speak(latest); }, 3400);
      } else {
        speaker?.speak(latest);
      }
    }, 2600);
  });
  replyObserver.observe($('reply'), { childList: true, subtree: true, characterData: true });
  function animate(at) {
    requestAnimationFrame(animate);
    // A 32 ms gate is ~31 fps, and that alone reads as stutter while the head is
    // tracking the cursor. The pet is a small transparent window, so running at
    // the display's refresh rate costs very little here.
    if (at - lastRender > 15) {
      if (view.expireInvitation(Date.now())) renderUI();
      // Ambient lines stay quiet while a turn is in flight or a work card is open.
      const busy = !['idle', 'error'].includes(view.state) || playback.busy || work.focused || work.expanded
        || !$('drawer').hidden || !$('invitation').hidden || captureAllowed;
      if (ambient) {
        // Quiet means quiet: an open exchange also stops nagging.
        const quiet = quietReason();
        if (quiet) { ambient.tick(true); if (ambientWaiting) clearWaiting(); }
        else {
          ambient.tick(busy || systemIdleSeconds < SPEAK_WHEN_IDLE_SECONDS);
          const active = ambient.active();
          if (active && active.startedAt !== ambientLastStartedAt) { ambientLastStartedAt = active.startedAt; showAmbient(active); }
          tickGestures();
        }
      }
      tickAmbientDisplay();
      updateSpeechMouth();
      const shown=workSpeechView.state==='speaking'?workSpeechView:view;renderer.updateView(shown,voicePhase==='preparing'?'listening':shown.state,work.focused&&shown===view); lastRender = at; frame++;
    }
  }
  requestAnimationFrame(animate);
  // Tell the main process what is clickable, so IT can decide click-through by
  // polling the cursor. The previous event-driven version deadlocked: a window
  // that is ignoring the mouse only receives mousemove, not the pointermove it was
  // listening for, so it could never switch itself back on.
  setInterval(() => native('shell', { type: 'hit_rects', rects: interactiveRects(), dragging: Boolean(pointer) }), 350);
  native('shell', { type: 'hit_rects', rects: interactiveRects(), dragging: false });
  // Render-rate watchdog. "It feels choppy" is otherwise impossible to confirm or
  // refute from a log; this reports only when the rate is genuinely poor, so a
  // healthy session stays silent.
  let rateFrames = 0, rateAt = performance.now(), rateWarned = 0;
  setInterval(() => {
    const now = performance.now(), seconds = (now - rateAt) / 1000;
    if (seconds < 3) return;
    const fps = Math.round((frame - rateFrames) / seconds);
    rateFrames = frame; rateAt = now;
    if (fps < 45 && now - rateWarned > 30000) { rateWarned = now; report({ type: 'render-rate', fps }); }
  }, 3000);
  // Bounded telemetry of model parameters only, never transcript/audio/frame contents.
  let lastTrace = 0;
  setInterval(() => { if (playback.busy && performance.now() - lastTrace > 700) { lastTrace = performance.now(); report({ type: 'speaking-parameters', ...renderer.snapshot() }); } }, 500);
} catch (error) { $('loading').textContent = '模型加载失败'; view.error = error.message; report({ type: 'model-error', message: error.message, stack: error.stack }); panel(true); renderUI(); }
