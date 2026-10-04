// Ambient liveliness for the desktop pet.
//
// The pet used to sit perfectly still between conversations. This scheduler
// occasionally plays a short action together with a preset line, and it picks
// the line set by time of day: a morning group greets you, a late-night group
// tells you to sleep, and a fallback group keeps the character company any time.
//
// Everything is data-driven from ambient.json so the wording and the schedule
// can be changed without touching code. No network calls and no model tokens
// are involved: the lines are local presets.

// Which actions take the eyes over is a property of the motion table, so it is
// asked for rather than duplicated here.
import { scriptsGaze } from './interaction-motion.mjs';

const DAY_MS = 24 * 60 * 60 * 1000;

const int = (value, fallback, min) =>
  Number.isSafeInteger(value) && value >= min ? value : fallback;

/** Keeps a bad config from failing silently; the reason is visible in devtools. */
const note = (message) => { try { console.warn('[ambient] ' + message); } catch {} };

/**
 * Actions that move the rig's limbs through its physics chains.
 *
 * Kept in one place so reaction() can prefer them: they are the visible gestures,
 * and picking one at random against a facial tweak left the limbs idle half the
 * time.
 */
export const LIMB_ACTIONS = new Set([
  'raiseArm', 'lowerArm', 'coverUp', 'skirtSway', 'turnBody', 'waveArm', 'shrinkArms', 'stretchArms',
]);

/** Actions the renderer knows how to play; anything else is ignored. */

const AMBIENT_ACTIONS = [
  // 模型自带姿态参数（0-100）
  'raiseHand', 'angryFace', 'sleepy', 'pout', 'gloomy', 'deadEyes', 'shades', 'spin', 'witch',
  // 面部细节（标准 Cubism 参数）
  'smileEyes', 'raiseBrow', 'furrowBrow', 'crookedMouth', 'squint',
  // 组合动作
  'happyGreeting', 'tired', 'grumpy', 'blank', 'tease',
  // 动作组（多段序列）
  'seqGreet', 'seqSleepy', 'seqAngry', 'seqShy', 'seqCheer', 'seqCool', 'seqWitch', 'seqTired', 'seqThink', 'seqSurprise',
  // 头部
  'nod', 'shake', 'tilt', 'lookAway', 'lookUp', 'lookDown', 'perk', 'think', 'shy', 'listen',
  // 身体
  'sway', 'bounce', 'stretch', 'breathe', 'sigh',
  // 表情
  'yawn', 'surprise',
  'bothArmsUp', 'bigWave', 'fullCover', 'pointAway', 'shrugOpen',
  'shyAvert', 'hideFace', 'handOnCheek', 'reachOut', 'tiltWave',
  'handToFace', 'peaceSign', 'salute', 'handsTogether',
  // 物理链驱动的手臂 / 手 / 裙子动作
  'raiseArm', 'lowerArm', 'coverUp', 'skirtSway', 'turnBody', 'waveArm', 'shrinkArms', 'stretchArms',
];

/**
 * One line of dialogue: what to say, the moves that go with it, and the state it
 * reads or writes.
 *
 * - `requires`  names a flag that must be set (recently) for this line to be
 *               eligible. This is how a line can refer back to what happened
 *               earlier, e.g. "昨晚睡得晚吧" only after last night's reminder was
 *               ignored.
 * - `setFlag`   records a flag when the line is actually spoken.
 * - `waiting`   opens a short exchange: `reply` when the user taps, `ignored`
 *               when they stay quiet, and `remind` to come back to the subject
 *               later. Branches may carry their own `waiting`, which is what
 *               makes a 3-4 turn back-and-forth possible.
 */
function parseLine(entry, depth = 0) {
  if (typeof entry === 'string') return { text: entry.trim(), actions: [] };
  if (!entry || typeof entry !== 'object' || typeof entry.text !== 'string') return null;
  const text = entry.text.trim();
  if (!text) return null;
  const actions = (Array.isArray(entry.actions) ? entry.actions : []).filter(a => AMBIENT_ACTIONS.includes(a));
  const line = { text, actions };
  if (typeof entry.setFlag === 'string' && entry.setFlag) line.setFlag = entry.setFlag;
  if (typeof entry.requires === 'string' && entry.requires) line.requires = entry.requires;
  // Optional mood override; otherwise the spoken action decides how it sounds.
  if (typeof entry.emotion === 'string' && entry.emotion) line.emotion = entry.emotion;
  // Relationship stages: a line can be reserved for a rapport level, so content
  // unlocks as the two of you get used to each other.
  if (Number.isSafeInteger(entry.minStage) && entry.minStage >= 0 && entry.minStage <= 4) line.minStage = entry.minStage;
  // Mood gating: 'warm' lines only when things are going well, 'reserved' only
  // when the pet has been ignored a lot. Either may be listed.
  if (entry.mood === 'warm' || entry.mood === 'reserved') line.mood = entry.mood;
  if (typeof entry.kind === 'string' && entry.kind) line.kind = entry.kind;
  // Days of the week this line belongs to, 0 = Sunday, matching Date#getDay().
  if (Array.isArray(entry.whenDay) && entry.whenDay.every(d => Number.isSafeInteger(d) && d >= 0 && d <= 6)) {
    line.whenDay = entry.whenDay;
  }
  if (Array.isArray(entry.whenMonthDay) && entry.whenMonthDay.every(d => Number.isSafeInteger(d) && d >= 1 && d <= 31)) {
    line.whenMonthDay = entry.whenMonthDay;
  }
  // A chain: after this line, the pet keeps talking through the listed lines in
  // order. This is what turns "one sentence" into an actual exchange.
  if (Array.isArray(entry.chain) && entry.chain.length > 0) {
    const chain = entry.chain.filter(t => typeof t === 'string' && t.trim()).slice(0, 4).map(t => t.trim());
    if (chain.length > 0) line.chain = chain;
  }
  // Long-term memory, which survives restarts and does NOT expire on the flag
  // TTL. This is what lets her bring up something from a previous conversation:
  // a reply can record a topic, and a later line can require it.
  if (typeof entry.remember === 'string' && entry.remember) line.remember = { key: entry.remember, strength: 1 };
  else if (entry.remember && typeof entry.remember === 'object' && typeof entry.remember.key === 'string') {
    line.remember = { key: entry.remember.key, strength: Number.isFinite(entry.remember.strength) ? entry.remember.strength : 1 };
  }
  else if (Array.isArray(entry.remember)) {
    const keys = entry.remember.filter(k => typeof k === 'string' && k);
    if (keys.length > 0) line.remember = keys;
  }
  if (Array.isArray(entry.rememberAlso)) {
    const keys = entry.rememberAlso.filter(k => typeof k === 'string' && k);
    if (keys.length > 0) line.rememberAlso = keys;
  }
  // remembersAll: every listed memory must still be alive. Association lines use
  // this - "you said you were tired, so work must be heavy" needs both.
  if (Array.isArray(entry.remembersAll) && entry.remembersAll.length > 0) {
    const keys = entry.remembersAll.filter(k => typeof k === 'string' && k);
    if (keys.length > 0) line.remembersAll = keys;
  }
  if (typeof entry.remembers === 'string' && entry.remembers) line.remembers = { key: entry.remembers, tier: 'faint' };
  else if (typeof entry.remembersClearly === 'string' && entry.remembersClearly) line.remembers = { key: entry.remembersClearly, tier: 'clear' };
  else if (typeof entry.remembersVaguely === 'string' && entry.remembersVaguely) line.remembers = { key: entry.remembersVaguely, tier: 'faint' };
  else if (entry.remembers && typeof entry.remembers === 'object' && typeof entry.remembers.key === 'string') {
    line.remembers = { key: entry.remembers.key, ...(Number.isFinite(entry.remembers.withinMs) ? { withinMs: entry.remembers.withinMs } : {}) };
  }
  if (Array.isArray(entry.moods)) line.moods = entry.moods.filter(m => ['warm', 'neutral', 'reserved'].includes(m));
  // Context gating: match the foreground application, or how long the user has
  // been away. Both make a line feel like a reaction to the moment.
  if (Array.isArray(entry.whenApp)) {
    const apps = entry.whenApp.filter(a => typeof a === 'string' && a).map(a => a.toLowerCase());
    if (apps.length > 0) line.whenApp = apps;
  }
  if (Array.isArray(entry.notApp)) {
    const apps = entry.notApp.filter(a => typeof a === 'string' && a).map(a => a.toLowerCase());
    if (apps.length > 0) line.notApp = apps;
  }
  if (Array.isArray(entry.whenAway) && entry.whenAway.length > 0 && entry.whenAway.every(v => Number.isFinite(v) && v >= 0)) {
    line.whenAway = entry.whenAway.slice(0, 2);
  }
  if (depth >= 2) return line;
  const waiting = entry.waiting && typeof entry.waiting === 'object' ? entry.waiting : null;
  if (!waiting) return line;
  const reply = parseLine(waiting.reply, depth + 1);
  const ignored = parseLine(waiting.ignored, depth + 1);
  const timeoutMs = Number.isSafeInteger(waiting.timeoutMs) && waiting.timeoutMs >= 2000 && waiting.timeoutMs <= 60000
    ? waiting.timeoutMs : 12000;
  // A reminder brings the subject back later instead of dropping it, so being
  // ignored at 23:00 can lead to a second, softer nudge half an hour on.
  const raw = waiting.remind;
  const remindLine = raw && typeof raw === 'object' ? parseLine({ ...raw, waiting: undefined }, depth + 1) : null;
  const remind = remindLine ? {
    ...remindLine,
    afterMs: Number.isSafeInteger(raw.afterMs) && raw.afterMs >= 60000 && raw.afterMs <= 6 * 3600 * 1000 ? raw.afterMs : 900000,
  } : null;
  line.waiting = { reply, ignored, remind, timeoutMs };
  return line;
}

/** Parses lines that may be plain strings (legacy) or objects with actions. */
function parseLines(entries) {
  return (Array.isArray(entries) ? entries : []).map(entry => parseLine(entry)).filter(Boolean);
}

/**
 * Actions driven by the rig's own pose parameters. These read as a real gesture
 * from across the room, unlike a few degrees of head turn, so the idle gesture
 * timer prefers them.
 */
export const POSE_ACTIONS = new Set([
  'raiseHand', 'sleepy', 'angryFace', 'pout', 'gloomy', 'deadEyes', 'shades', 'spin', 'witch',
  'happyGreeting', 'tired', 'grumpy', 'blank', 'tease',
]);

export function normalizeConfig(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const groups = (Array.isArray(source.groups) ? source.groups : [])
    .filter(group => group && typeof group === 'object')
    .map((group, index) => {
      // A line may be a plain string (legacy) or { text, actions }. Binding the
      // actions to the line keeps the two in agreement: drawing them
      // independently produced pairings like "该准备睡了哦" + a bounce.
      const lines = parseLines(group.lines);
      return {
        id: typeof group.id === 'string' && group.id ? group.id : `group-${index}`,
        hours: Array.isArray(group.hours)
          ? group.hours.filter(hour => Number.isSafeInteger(hour) && hour >= 0 && hour <= 23)
          : [],
        // Calendar days this group is reserved for, as 'MM-DD'. The birthday and
        // holiday group uses this so it only speaks up on the actual day.
        dates: Array.isArray(group.dates)
          ? group.dates.filter(d => typeof d === 'string' && /^\d{2}-\d{2}$/.test(d))
          : [],
        // Whole-group context gate, so the coding or meeting lines never appear
        // while something else is in front.
        ...(Array.isArray(group.whenApp) && group.whenApp.some(a => typeof a === 'string' && a)
          ? { whenApp: group.whenApp.filter(a => typeof a === 'string' && a).map(a => a.toLowerCase()) }
          : {}),
        ...(Array.isArray(group.whenDay) && group.whenDay.every(d => Number.isSafeInteger(d) && d >= 0 && d <= 6)
          ? { whenDay: group.whenDay }
          : {}),
        ...(Array.isArray(group.whenAway) && group.whenAway.length > 0 && group.whenAway.every(v => Number.isFinite(v) && v >= 0)
          ? { whenAway: group.whenAway.slice(0, 2) }
          : {}),
        lines,
        actions: (Array.isArray(group.actions) ? group.actions : []).filter(action => AMBIENT_ACTIONS.includes(action)),
      };
    })
    .filter(group => group.lines.length > 0);
  // Reactions answer a click on the character, so they are short and responsive.
  const reactions = parseLines(source.reactions);
  // Optional称呼. Lines may contain {name}; when no name is set the placeholder
  // and its trailing punctuation are dropped so nothing reads oddly.
  const userName = typeof source.profile?.userName === 'string' ? source.profile.userName.trim().slice(0, 24) : '';
  // A value below the floor used to be replaced by the default without a word,
  // which made a typo look like the feature was broken. Say so instead.
  if (source.minIntervalMs !== undefined && !(Number.isSafeInteger(source.minIntervalMs) && source.minIntervalMs >= 1000))
    note(`minIntervalMs ${JSON.stringify(source.minIntervalMs)} is invalid (need an integer >= 1000); using the default`);
  if (source.maxIntervalMs !== undefined && !(Number.isSafeInteger(source.maxIntervalMs) && source.maxIntervalMs >= 1000))
    note(`maxIntervalMs ${JSON.stringify(source.maxIntervalMs)} is invalid (need an integer >= 1000); using the default`);
  const minIntervalMs = int(source.minIntervalMs, 90000, 1000);
  return {
    enabled: source.enabled !== false && groups.length > 0,
    minIntervalMs,
    // Never let the upper bound fall below the lower one.
    maxIntervalMs: Math.max(minIntervalMs, int(source.maxIntervalMs, 210000, 1000)),
    idleAfterMs: int(source.idleAfterMs, 25000, 0),
    lineDurationMs: int(source.lineDurationMs, 9000, 1000),
    // A click reaction is brief: enough to answer, short enough not to linger.
    reactionDurationMs: int(source.reactionDurationMs, 5200, 1000),
    userName,
    // Actions played between lines, and how often. Without a gesture timer the
    // only movement was a mild idle sway, because actions were tied to speech.
    gestures: (Array.isArray(source.gestures) ? source.gestures : []).filter(a => AMBIENT_ACTIONS.includes(a)),
    gestureMinIntervalMs: int(source.gestureMinIntervalMs, 9000, 2000),
    gestureMaxIntervalMs: int(source.gestureMaxIntervalMs, 22000, 3000),
    reactions,
    groups,
  };
}

export class AmbientScheduler {
  #config;
  #now;
  #random;
  #nextAt = 0;
  #lastInteractionAt = 0;
  // What the user is doing right now, for the context-gated lines.
  #apps = '';
  // The last few lines actually spoken. Repeating the same sentence twice in a
  // row is the fastest way to break the illusion, so a line that was used within
  // the last five is skipped while any alternative remains.
  #recentLines = [];
  #recentLimit = 5;
  #away = NaN;
  #active = null;

  constructor(rawConfig, deps = {}) {
    this.#config = normalizeConfig(rawConfig);
    this.#now = deps.now ?? (() => Date.now());
    this.#random = deps.random ?? Math.random;
    this.#lastInteractionAt = this.#now();
    this.#nextAt = this.#lastInteractionAt + this.#delay();
  }

  get enabled() { return this.#config.enabled; }
  /** Current mood and relationship stage, for callers that colour the voice. */
  get mood() { return this.#mood(); }
  get stage() { return this.#stage(); }

  /** Hour of the local wall clock, used to pick the time-of-day group. */
  #hour(now) { return new Date(now).getHours(); }

  /**
   * Time-of-day groups outweigh the always-available group so a morning line
   * actually appears in the morning instead of being drowned out by generic
   * small talk. A weighted draw also keeps the order from being predictable.
   */
  /** Does this group's own context gate allow it right now? */
  #groupAllowed(group) {
    if (group.whenApp && !group.whenApp.includes(this.#apps)) return false;
    const day = new Date(this.#now()).getDay();
    if (Array.isArray(group.whenDay) && !group.whenDay.includes(day)) return false;
    if (Array.isArray(group.whenAway)) {
      if (!Number.isFinite(this.#away)) return false;
      if (this.#away < group.whenAway[0] || (group.whenAway.length > 1 && this.#away > group.whenAway[1])) return false;
    }
    return true;
  }

  #groupFor(now) {
    const hour = this.#hour(now);
    const today = this.#today(now);
    // A group pinned to today's date takes priority outright: a birthday line
    // should be the thing that gets said, not one voice among many.
    const dated = this.#config.groups.filter(group => group.dates.includes(today) && group.lines.some(line => this.#eligible(line)));
    if (dated.length > 0) return this.#pick(dated);
    const scored = this.#config.groups
      .filter(group => group.dates.length === 0 && this.#groupAllowed(group))
      .map(group => ({
        group,
        weight: group.hours.length === 0 ? 1 : group.hours.includes(hour) ? 3 : 0,
      })).filter(entry => entry.weight > 0);
    if (scored.length === 0) return null;
    const total = scored.reduce((sum, entry) => sum + entry.weight, 0);
    let roll = this.#random() * total;
    for (const entry of scored) {
      roll -= entry.weight;
      if (roll <= 0) return entry.group;
    }
    return scored[scored.length - 1].group;
  }

  #pick(list) { return list[Math.floor(this.#random() * list.length)]; }

  /**
   * Pick a line that has not been used in the last few turns.
   *
   * Falls back to the full set once everything eligible has been used, so a thin
   * group (a single Monday line, say) still speaks rather than going silent.
   */
  #pickLine(list) {
    if (!Array.isArray(list) || list.length === 0) return undefined;
    const fresh = list.filter(line => line?.text && !this.#recentLines.includes(line.text));
    const chosen = this.#pick(fresh.length > 0 ? fresh : list);
    if (chosen?.text) {
      this.#recentLines.push(chosen.text);
      while (this.#recentLines.length > this.#recentLimit) this.#recentLines.shift();
    }
    return chosen;
  }

  /**
   * Call when the user does anything (typing, clicking, talking). It silences
   * the pet for idleAfterMs so an ambient line never interrupts a real turn.
   */
  noteInteraction() {
    this.#lastInteractionAt = this.#now();
    this.#active = null;
    this.#nextAt = this.#lastInteractionAt + this.#delay();
  }

  /** The line currently on screen, or null. */
  active(now = this.#now()) {
    if (!this.#active) return null;
    if (now >= this.#active.endsAt) { this.#active = null; return null; }
    return this.#active;
  }

  /** Drop the current line early (for example when a real turn starts). */
  dismiss() { this.#active = null; }

  /** Attach the persisted rapport state (how the user has been responding). */
  setRapport(rapport) { this.rapport = rapport && typeof rapport === 'object' ? rapport : null; }

  /** A flag stays meaningful for a while, then goes stale on its own. */
  static FLAG_TTL_MS = 14 * 3600 * 1000;
  /**
   * Base half-life of a memory: after this long, retention falls to 0.5.
   *
   * Ebbinghaus' curve, R = e^(-age / halfLife). Each successful recall makes the
   * memory more stable — the "hits" term doubles and triples the half-life — so
   * things you actually talk about stay sharp while things mentioned once fade.
   */
  static MEMORY_HALF_LIFE_MS = 2 * 24 * 3600 * 1000;
  /** Retention above this reads as a clear memory, below as a hazy one. */
  static MEMORY_CLEAR = 0.6;
  static MEMORY_FAINT = 0.22;
  /**
   * Memories that change how talkative she is.
   *
   * Association is not only about what she says: if she remembers you are busy or
   * exhausted, the right response is to speak less. A companion that keeps
   * chattering through a remembered bad week has not understood anything.
   */
  static MEMORY_QUIETER = ['topic:busy', 'topic:tired', 'topic:worry', 'topic:health'];
  /**
   * Is this long-term memory present, and recent enough if a window was given?
   *
   * Unlike #flagFresh there is no default expiry: the whole point is that
   * something said three days ago is still available today.
   */
  /** How well this memory is retained right now, 0..1. */
  memoryRetention(key) {
    const entry = this.rapport?.memory?.[key];
    if (entry === undefined) return 0;
    const at = typeof entry === 'number' ? entry : entry?.at;
    if (typeof at !== 'number') return 0;
    const hits = typeof entry === 'object' ? Math.max(0, entry.hits | 0) : 0;
    const strength = typeof entry === 'object' && Number.isFinite(entry.strength) ? Math.max(.2, Math.min(3, entry.strength)) : 1;
    // Each recall makes the memory more stable, with diminishing returns. The step
    // is deliberately generous: something discussed four or five times should still
    // be there a fortnight later, which is the whole point of the curve.
    const halfLife = AmbientScheduler.MEMORY_HALF_LIFE_MS * strength * (1 + Math.min(8, hits) * 1.1);
    return Math.exp(-(this.#now() - at) / halfLife);
  }
  /** 'clear' | 'faint' | 'gone' — the tier a memory is currently in. */
  memoryTier(key) {
    const r = this.memoryRetention(key);
    if (r >= AmbientScheduler.MEMORY_CLEAR) return 'clear';
    if (r >= AmbientScheduler.MEMORY_FAINT) return 'faint';
    return 'gone';
  }

  #remembers(spec) {
    const key = spec?.key;
    if (typeof key !== 'string' || !key) return false;
    const retention = this.memoryRetention(key);
    // 'faint' accepts anything still above the faint threshold, which is what a
    // hazy recollection line wants.
    const floor = spec.tier === 'clear' ? AmbientScheduler.MEMORY_CLEAR
      : spec.tier === 'faint' ? AmbientScheduler.MEMORY_FAINT : AmbientScheduler.MEMORY_FAINT;
    if (retention < floor) return false;
    if (spec.tier === 'faint' && retention >= AmbientScheduler.MEMORY_CLEAR) return false;
    if (spec.tier === 'clear' && retention < AmbientScheduler.MEMORY_CLEAR) return false;
    return true;
  }
  /** How long ago a memory was recorded, in ms, or null when absent. */
  memoryAge(key) {
    const at = this.rapport?.memory?.[key];
    return typeof at === 'number' ? this.#now() - at : null;
  }
  /** Every memory key currently held, for diagnostics. */
  memoryKeys() { return Object.keys(this.rapport?.memory ?? {}); }

  #flagFresh(name) {
    const at = this.rapport?.flags?.[name];
    return typeof at === 'number' && this.#now() - at < AmbientScheduler.FLAG_TTL_MS;
  }
  /** How well things are going, from the running streak of replies vs ignores. */
  #mood() {
    const streak = this.rapport?.streak ?? 0;
    if (streak >= 2) return 'warm';
    if (streak <= -2) return 'reserved';
    return 'neutral';
  }
  /** 0 = brand new, 4 = the two of you are used to each other. */
  #stage() {
    const total = (this.rapport?.answered ?? 0) + (this.rapport?.ignored ?? 0);
    if (total >= 200) return 4;
    if (total >= 80) return 3;
    if (total >= 25) return 2;
    if (total >= 6) return 1;
    return 0;
  }
  /** Today as 'MM-DD' in local time, for date-restricted groups and lines. */
  #today(now = this.#now()) { const d = new Date(now); return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }

  /**
   * Describe what the user is doing right now, so context-gated lines can match.
   *
   * `app` is the foreground process name, `away` the system-wide idle seconds.
   * Both are optional; a missing value simply leaves those lines ineligible.
   */
  observe(context = {}) {
    if (typeof context.app === 'string') this.#apps = context.app.toLowerCase();
    else if (context.app === null) this.#apps = '';
    if (Number.isFinite(context.away)) this.#away = context.away;
  }
  /** Whether the pet has a line written specifically for the current context. */
  hasContextLine() {
    return this.#config.groups.some(group => group.lines.some(line => (line.whenApp || line.whenAway) && this.#eligible(line)));
  }

  #eligible(line) {
    if (line.requires && !this.#flagFresh(line.requires)) return false;
    if (line.remembers && !this.#remembers(line.remembers)) return false;
    if (line.remembersAll && !line.remembersAll.every(key => this.memoryRetention(key) >= AmbientScheduler.MEMORY_FAINT)) return false;
    if (Number.isSafeInteger(line.minStage) && this.#stage() < line.minStage) return false;
    const mood = this.#mood();
    if (line.mood && line.mood !== mood) return false;
    if (line.moods && !line.moods.includes(mood)) return false;
    // Context awareness. A line may be reserved for a particular foreground
    // application, or for the moment the user has been away for a while. This is
    // what makes the pet feel like it noticed what you are doing rather than
    // reciting from a list.
    const dayOfWeek = new Date(this.#now()).getDay();
    if (Array.isArray(line.whenDay) && !line.whenDay.includes(dayOfWeek)) return false;
    if (Array.isArray(line.whenMonthDay) && !line.whenMonthDay.includes(new Date(this.#now()).getDate())) return false;
    if (line.whenApp && !line.whenApp.includes(this.#apps)) return false;
    if (line.notApp && line.notApp.includes(this.#apps)) return false;
    if (Array.isArray(line.whenAway)) {
      const away = this.#away;
      if (!Number.isFinite(away)) return false;
      if (away < line.whenAway[0] || (line.whenAway.length > 1 && away > line.whenAway[1])) return false;
    }
    return true;
  }

  /**
   * How long to wait before speaking up again, adjusted by how the user has been
   * responding. Somebody who keeps ignoring the pet gets fewer interruptions; an
   * engaged user gets a livelier companion. This is the "memory" made visible.
   */
  #delay() {
    const base = this.#config.minIntervalMs + Math.random() * (this.#config.maxIntervalMs - this.#config.minIntervalMs);
    const streak = this.rapport?.streak ?? 0;
    let result = base;
    if (streak <= -2) result = base * 1.9;
    else if (streak === -1) result = base * 1.35;
    else if (streak >= 3) result = base * 0.62;
    else if (streak >= 1) result = base * 0.8;
    // If something heavy is still remembered, give the user more room. The factor
    // grows with how strongly the memory is retained, so this fades on its own.
    let quietFactor = 1;
    for (const key of AmbientScheduler.MEMORY_QUIETER) {
      const r = this.memoryRetention(key);
      if (r >= AmbientScheduler.MEMORY_FAINT) quietFactor = Math.max(quietFactor, 1 + r * 0.9);
    }
    return quietFactor > 1 ? result * quietFactor : result;
  }

  #personalise(text) { return AmbientScheduler.personalise(text, this.#config.userName); }

  /**
   * Rewrites {name} in a line, dropping the placeholder cleanly when unset.
   * Static so the speech prefetch can produce exactly the same string and the
   * cache key it writes is the one playback looks up.
   */
  static personalise(text, userName) {
    const name = typeof userName === 'string' ? userName.trim() : '';
    if (typeof text !== 'string' || !text.includes('{name}')) return text;
    if (name) return text.replaceAll('{name}', name);
    return text.replace(/[，,、\s]*\{name\}[，,、]?/g, '').replace(/^[，,、\s]+/, '').replace(/[，,、\s]+$/, '').trim();
  }

  /**
   * A gesture to play between lines.
   *
   * Actions were tied to speech, and speech only happens every 25-60 seconds, so
   * most of the time the pet just stood there. This draws from the same groups but
   * weighted toward the big pose sequences, which are the ones that actually read
   * as "doing something" rather than an idle sway.
   *
   * `options.excludeGaze` drops the actions that drive the eyes themselves: while
   * the pointer is moving the user is watching the pet follow it, and those
   * actions cancel exactly that.
   */
  gesture(options = {}) {
    if (!this.#config.enabled) return null;
    const now = this.#now();
    let pool = this.#gesturePool();
    if (options.excludeGaze) {
      const safe = pool.filter(name => !scriptsGaze(name));
      if (safe.length > 0) pool = safe;
    }
    if (pool.length === 0) return null;
    return { groupId: 'gesture', text: '', action: this.#pick(pool), startedAt: now, endsAt: now + 4000 };
  }

  #gesturePool() {
    const configured = this.#config.gestures;
    if (configured.length > 0) return configured;
    // Default: prefer full pose sequences, then the pose parameters, then the
    // expressive single moves. Small head-only moves are deliberately last.
    const fromLines = [...new Set(this.#config.groups.flatMap(group => group.lines).flatMap(line => line.actions))].filter(Boolean);
    const preferred = fromLines.filter(name => name.startsWith('seq') || name.startsWith('raiseHand') || POSE_ACTIONS.has(name));
    const base = preferred.length > 0 ? preferred : fromLines;
    // Gaze-driving actions appear once, the rest twice, so they show up about a
    // third as often without being removed outright.
    const weighted = [];
    for (const name of base) { weighted.push(name); if (!scriptsGaze(name)) weighted.push(name); }
    return weighted;
  }

  /**
   * Answer a click on the character immediately, ignoring the interval and the
   * idle delay. Returns the event to play, or null when nothing can be said.
   */
  reaction(options = {}) {
    if (!this.#config.enabled) return null;
    const now = this.#now();
    let pool = this.#config.reactions.length > 0 ? this.#config.reactions : this.#groupFor(now)?.lines;
    // A double tap, a drag and a return each want their own register. When the
    // caller names a kind, prefer those lines and fall back to the general pool so
    // the pet never stays silent just because a category is thin.
    if (options.kind) {
      const typed = pool.filter(line => line.kind === options.kind);
      if (typed.length > 0) pool = typed;
      else if (options.exclusive) return null;
    } else {
      pool = pool.filter(line => !line.kind);
      if (pool.length === 0) pool = this.#config.reactions;
    }
    if (!pool || pool.length === 0) return null;
    const line = this.#pickLine(pool);
    const fallback = this.#groupFor(now)?.actions ?? [];
    const actionPool = line.actions.length > 0 ? line.actions : fallback;
    const event = {
      groupId: 'reaction',
      text: this.#personalise(line.text),
      action: actionPool.length > 0
        ? (actionPool.find(name => LIMB_ACTIONS.has(name)) ?? this.#pick(actionPool))
        : null,
      ...(line.emotion ? { emotion: line.emotion } : {}),
      ...(line.setFlag ? { setFlag: line.setFlag } : {}),
      ...(line.remember ? { remember: line.remember } : {}),
      ...(line.rememberAlso ? { rememberAlso: line.rememberAlso } : {}),
      startedAt: now,
      endsAt: now + this.#config.reactionDurationMs,
    };
    this.#active = event;
    // A click should not shorten the wait for the next unprompted line by much,
    // but it does push it out so the pet does not talk twice in a row.
    this.#nextAt = now + this.#delay();
    return event;
  }

  /**
   * Advance the schedule. `busy` must be true whenever the character is
   * speaking, thinking, listening, or showing a work card; ambient lines stay
   * out of the way until it is false again.
   */
  tick(busy = false) {
    const now = this.#now();
    if (!this.#config.enabled) return null;
    if (this.active(now)) return null;
    if (busy) {
      // Push the next attempt out instead of firing the instant the turn ends.
      this.#nextAt = now + this.#delay();
      return null;
    }
    if (now - this.#lastInteractionAt < this.#config.idleAfterMs) return null;
    if (now < this.#nextAt) return null;
    const group = this.#groupFor(now);
    if (!group) return null;
    // Pick a line first, then one of ITS actions, so the movement always matches
    // what the line says. Lines whose `requires` flag is stale are skipped, which
    // is how the pet refers back to something that actually happened earlier.
    const eligible = group.lines.filter(line => this.#eligible(line));
    const line = this.#pickLine(eligible.length > 0 ? eligible : group.lines);
    const actionPool = line.actions.length > 0 ? line.actions : group.actions;
    const event = {
      groupId: group.id,
      text: this.#personalise(line.text),
      action: actionPool.length > 0 ? this.#pick(actionPool) : null,
      // The exchange and the flag must travel with the event; rebuilding the
      // object by hand used to drop them.
      ...(line.waiting ? { waiting: line.waiting } : {}),
      ...(line.setFlag ? { setFlag: line.setFlag } : {}),
      ...(line.emotion ? { emotion: line.emotion } : {}),
      startedAt: now,
      endsAt: now + this.#config.lineDurationMs,
    };
    this.#active = event;
    this.#nextAt = now + this.#delay();
    return event;
  }
}

/**
 * Loads ambient.json through the pet:// asset route. A missing or malformed
 * file is not an error: the pet simply stays quiet rather than failing to boot.
 */
export async function loadAmbientConfig(url = 'ambient.json') {
  try {
    const response = await fetch(url, { cache: 'no-store' });
    if (!response.ok) { console.warn('[ambient] config HTTP', response.status); return null; }
    return await response.json();
  } catch (error) {
    console.warn('[ambient] config unavailable:', error?.message ?? error);
    return null;
  }
}
