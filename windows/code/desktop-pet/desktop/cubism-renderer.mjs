import { InteractionMotion } from './interaction-motion.mjs';
import { normalizePresentationIntent } from '../contracts/presentation.ts';
import { ModelFeather } from './model-feather.mjs';
import presetCatalog from './assets/local-model/presets.json';
import parameterMap from './config/parameter-map.json';
// Application adapter over the official SDK; SDK owns deformation, physics, blending and WebGL rendering.
import { CubismFramework } from './vendor/cubism/Framework/src/live2dcubismframework.ts';
import { CubismUserModel } from './vendor/cubism/Framework/src/model/cubismusermodel.ts';
import { CubismModelSettingJson } from './vendor/cubism/Framework/src/cubismmodelsettingjson.ts';
import { CubismMatrix44 } from './vendor/cubism/Framework/src/math/cubismmatrix44.ts';
import { CubismEyeBlink } from './vendor/cubism/Framework/src/effect/cubismeyeblink.ts';
import { CubismExpressionMotionManager } from './vendor/cubism/Framework/src/motion/cubismexpressionmotionmanager.ts';
import { CubismShaderManager_WebGL } from './vendor/cubism/Framework/src/rendering/cubismshader_webgl.ts';


const presets = new Map(presetCatalog.items.map(item => [item.id, item]));
const automaticItems = presetCatalog.items.filter(item => item.availability === 'automatic');
const faces = new Map(automaticItems.flatMap(item => (item.emotions ?? []).map(key => [key, item])));
const gestures = new Map(automaticItems.flatMap(item => (item.gestures ?? []).map(key => [key, item])));
const headParameters = [parameterMap.headYaw, parameterMap.headPitch, parameterMap.headRoll];
const interactionParameters = [...headParameters, 'ParamBodyAngleX', 'ParamEyeBallX', 'ParamEyeBallY'];
// How much of the idle clip's body-angle contribution survives each frame.
// This rig's idle clips open with a fast, large body swing (the "sleep" clip
// moves ParamBodyAngleY +5 then -2 inside 1.7s), and physics amplifies that into
// a chest jolt at the start of every loop. Lowering this makes the idle read as
// calm breathing. 1 disables the damping entirely.
const idleBodyDamping = 0.585;
const idleBodyParameters = ['ParamBodyAngleX', 'ParamBodyAngleY', 'ParamBodyAngleZ'];
const webglOwners = new Set();

/**
 * 各模型的初始参数值。
 *
 * 有些模型把「说明文字」「水印」做成了参数开关，默认是显示的。这里按模型目录
 * 名给出要关掉的参数 —— 不写死在渲染逻辑里，加模型时只加一行。
 */
const MODEL_INITIAL_PARAMETERS = {
  // 无尽夏：关掉台本式的使用规则文字和水印
  wujinxia: { ParamEyeHeart3: 0, ParamEyeHeart9: 0 },
};

/** 从 assetBase（如 assets/models/wujinxia/）取出模型 id，再查上面的表。 */
function modelInitialParameters(assetBase) {
  if (typeof assetBase !== 'string') return null;
  for (const id of Object.keys(MODEL_INITIAL_PARAMETERS)) {
    if (assetBase.includes('/' + id + '/') || assetBase.includes(id + '/')) return MODEL_INITIAL_PARAMETERS[id];
  }
  return null;
}
/**
 * Vertex-level arm posing.
 *
 * Off. The mechanism works, but this model's arms are single 0.64-long cloth pieces
 * with no elbow, so a hand cannot be folded up to the face - see the notes in
 * poseArmVertices(). Flip this to true to re-enable; the armLift values are still in
 * the action table, so nothing else needs touching.
 */
const ARM_POSING_ENABLED = false;
export class JellyfishRenderer extends CubismUserModel {
  constructor(canvas, report = () => {}, options = {}) {
    super(); this.canvas = canvas; this.report = report; this.options = options;
    this.textures = []; this.expressions = new Map(); this.faceKey = ''; this.gestureKey = '';
    this.expressionParameters = new Set(); this.expressionValues = new Map(); this.previewParameters = new Set(); this.appearanceParameters = new Set();
    this.interaction = new InteractionMotion(); this.elapsed = 0; this.gestureManager = new CubismExpressionMotionManager(); this.previewManager = new CubismExpressionMotionManager(); this.framing = 'full';
    // No policy yet means no automatic animation, including before backend ready.
    this.automaticIds = new Set(); this.policyRevision = -1; this.previewValues = new Map();
    // Live inputs driven from outside the action system.
    this.speechMouth = 0;      // mouth amplitude of locally played audio
    this.cursorGaze = null;    // { x, y } in -1..1 toward the pointer
  }
  async load() {
    this.gl = this.canvas.getContext('webgl', { alpha: true, premultipliedAlpha: true, antialias: true });
    if (!this.gl) throw new Error('这个窗口无法启用 WebGL');
    this.syncViewport();
    const base = new URL(this.options.assetBase ?? 'assets/local-model/', location.href);
    const read = async path => { const r = await fetch(new URL(path, base), { cache: 'no-store' }); if (!r.ok && r.status !== 0) throw new Error(`模型文件加载失败：${path}`); return r.arrayBuffer(); };
    await this.loadRig(read);
    await this.loadFeatures(read);
    this.createRenderer(this.canvas.width, this.canvas.height);
    webglOwners.add(this);
    const renderer = this.getRenderer(); renderer.startUp(this.gl); renderer.loadShaders(new URL(this.options.shaderBase ?? 'vendor/cubism/Framework/Shaders/WebGL/', location.href).href); renderer.setIsPremultipliedAlpha(true);
    for (let i = 0; i < this.settings.getTextureCount(); i++) {
      const img = new Image(); img.src = new URL(this.settings.getTextureFileName(i), base).href; await img.decode();
      // 留一份给面板取色用，省得为了几个颜色再下载一次 8192 的大图。
      (this.textureImages ??= []).push(img);
      if (Math.max(img.width, img.height) > this.gl.getParameter(this.gl.MAX_TEXTURE_SIZE)) throw new Error('设备不支持这张模型纹理的尺寸');
      const gl = this.gl, tex = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, tex); gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, 1);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE); renderer.bindTexture(i, tex); this.textures.push(tex);
    }
    this._modelMatrix.setHeight(1.9); this._modelMatrix.setPosition(0, 0);
    this.syncViewport(true);
    this.report({ type: 'model-loaded', parameters: this._model.getParameterCount(), drawables: this._model.getDrawableCount(), expressions: this.expressions.size, textures: this.textures.length, canvas: [this._model.getCanvasWidth(), this._model.getCanvasHeight()], maxTextureSize: this.gl.getParameter(this.gl.MAX_TEXTURE_SIZE), runtime: 'Cubism5-r.5' });
    this.ready = true; this.last = performance.now();
  }
  // Shared by the real WebGL loader and silent tests of the actual Cubism rig.
  async loadRig(readAsset) {
    CubismFramework.startUp({ logFunction: message => this.report({ type: 'sdk', message }), loggingLevel: 3 }); CubismFramework.initialize();
    const buffers = new Map();
    const read = async path => {
      if (typeof path !== 'string' || /^[/.]|[:%\\]/.test(path) || path.split('/').includes('..')) throw new Error('模型资源路径不可用');
      if (!buffers.has(path)) buffers.set(path, await readAsset(path));
      return buffers.get(path);
    };
    const settingsBuffer = await read('pet.model3.json');
    const refs = JSON.parse(new TextDecoder().decode(settingsBuffer)).FileReferences;
    const paths = [...new Set(['pet.model3.json', refs.Moc, refs.Physics, ...refs.Expressions.map(e => e.File), ...Object.values(refs.Motions ?? {}).flat().map(m => m.File)])].sort();
    const hash = async buffer => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', buffer)), byte => byte.toString(16).padStart(2, '0')).join('');
    let binding = '';
    for (const path of paths) binding += path + '\0' + await hash(await read(path)) + '\n';
    const fingerprint = await hash(new TextEncoder().encode(binding));
    // MODEL_FP_DEBUG - only reported when the values disagree, so a healthy load
    // stays silent. Kept because it is what found the stale-cache problem.
    if (fingerprint !== presetCatalog.modelFingerprint) {
      const parts = [];
      for (const path of paths) parts.push(path + '=' + (await hash(await read(path))).slice(0, 16));
      this.report({ type: 'model-fingerprint-debug',
        computed: fingerprint,
        expected: presetCatalog.modelFingerprint,
        bindingLength: binding.length,
        fileCount: paths.length,
        files: parts });
    }
    // MODEL_FP_MISMATCH - warn, do not throw.
    //
    // A mismatch means the catalog describes a different rig. Throwing used to take
    // the whole renderer down, which cost the user every action, reaction and line of
    // dialogue - far more than the stale catalog actually breaks. The policy layer
    // now skips entries this rig cannot satisfy, so loading can continue.
    if (fingerprint !== presetCatalog.modelFingerprint) {
      this.policyValid = false;
      this.automaticIds.clear();
      this.report({ type: 'model-fingerprint-mismatch',
        expected: presetCatalog.modelFingerprint, computed: fingerprint });
    }
    this.settings = new CubismModelSettingJson(settingsBuffer, settingsBuffer.byteLength);
    this.loadModel(await read(this.settings.getModelFileName()), true);
    if (!this._model) throw new Error('Cubism 未能解析模型');
    const physics = await read(this.settings.getPhysicsFileName()); this.loadPhysics(physics, physics.byteLength);
    this.blink = CubismEyeBlink.create(this.settings);
    this.parameterIndices = new Map(Array.from(this._model.getModel().parameters.ids, (id, i) => [id, i]));
    // Optional, model-specific switches belong in the ignored local mapping.
    this.parameterOverrides = new Map(Object.entries(parameterMap.parameterOverrides ?? {}));
    // 模型自带的初始参数（关掉说明文字、水印这类部件）。合并进 overrides，
    // 因为它每帧都会被应用 —— 只 set 一次会被 Cubism 的 update() 冲掉。
    for (const [id, value] of Object.entries(modelInitialParameters(this.options.assetBase) ?? {})) {
      this.parameterOverrides.set(id, value);
    }
    // 越界的覆盖值改成夹取，而不是抛错。
    //
    // 这个校验原本很严：只要有一个覆盖值不在参数范围内就抛。但覆盖表里现在有
    // 模型自带的开关（关水印、关说明文字），这些参数并不存在于每个模型 —— 换模型
    // 时一个越界值就会让整个切换回滚，表现为「功能面板不出现、配色不跟着变」。
    // 缺参数的项直接丢掉，越界的夹到范围内。
    for (const [id, value] of [...this.parameterOverrides]) {
      const index = this.parameterIndices.get(id), parameters = this._model.getModel().parameters;
      if (index === undefined || !Number.isFinite(value)) {
        this.parameterOverrides.delete(id);
        continue;
      }
      const lo = parameters.minimumValues[index], hi = parameters.maximumValues[index];
      if (value < lo || value > hi) {
        this.parameterOverrides.set(id, Math.min(hi, Math.max(lo, value)));
      }
    }
    const supported = new Set(automaticItems.map(item => item.expressionName));
    const appearance = new Set(presetCatalog.items.filter(item => item.category === 'appearance').map(item => item.expressionName));
    for (let i = 0; i < this.settings.getExpressionCount(); i++) {
      const name = this.settings.getExpressionName(i), b = await read(this.settings.getExpressionFileName(i));
      this.expressions.set(name, this.loadExpression(b, b.byteLength, name));
      for (const parameter of JSON.parse(new TextDecoder().decode(b)).Parameters) {
        // 缺参数就跳过这一条，不要抛。
        //
        // 表情文件是按它自己那个模型编的；换模型之后，旧表情引用的参数在新模型里
        // 可能根本不存在。原先这里直接抛错，结果是 applyPresentationPolicy 失败、
        // 整个切换被回滚 —— 换模型后面板配色一直停在上一个模型，就是这个原因。
        if (!this.parameterIndices.has(parameter.Id)) continue;
        // Mouth amplitude stays on the actual playback clock, never expression easing.
        if (parameter.Id === 'ParamMouthOpenY') continue;
        this.previewParameters.add(parameter.Id);
        if (supported.has(name)) this.expressionParameters.add(parameter.Id);
        if (appearance.has(name)) this.appearanceParameters.add(parameter.Id);
      }
    }
    // Loop the calmest available Idle motion. Index 0 is frequently a short
    // expression clip (this rig ships a 1.88s "surprise" there), and looping a
    // clip that short makes the body rise and fall roughly 32 times a minute,
    // which reads as heavy, exaggerated breathing. The longest clip is the
    // slowest and most natural idle, so pick that instead.
    // Rig packs that ship no motions at all are still usable: blinking, breathing
    // and the procedural head/body sway do not need one.
    const idleCount = this.settings.getMotionCount('Idle');
    let motion = null, idleDuration = -1;
    for (let index = 0; index < idleCount; index++) {
      const candidate = await read(this.settings.getMotionFileName('Idle', index));
      const duration = JSON.parse(new TextDecoder().decode(candidate)).Meta?.Duration ?? 0;
      if (duration > idleDuration) { idleDuration = duration; motion = candidate; }
    }
    if (motion) {
      this.idle = this.loadMotion(motion, motion.byteLength, 'Idle'); this.idle.setLoop(true); this.idle.setEffectIds([], []);
      this.motionParameters = new Set(JSON.parse(new TextDecoder().decode(motion)).Curves.filter(c => c.Target === 'Parameter').map(c => c.Id));
    } else this.motionParameters = new Set();
    this.runtimeParameters = new Set([...this.expressionParameters, ...this.motionParameters, ...interactionParameters, 'ParamBodyAngleX', 'ParamEyeLOpen', 'ParamEyeROpen', parameterMap.mouthForm, 'ParamMouthOpenY']);
    // 缺参数的动作名直接跳过。换模型后，动作表里引用的参数名不一定都在新模型里，
    // 抛错会让整个切换回滚（面板配色跟不上的真正原因）。
    for (const id of this.runtimeParameters) {
      if (!this.parameterIndices.has(id)) continue;
      this.previewParameters.add(id);
      this.appearanceParameters.delete(id);
    }
    for (const [id, value] of this.parameterOverrides) this.set(id, value);
    // TEMP DRIVER PROBE - removable
    if (!globalThis.__driverRanges) {
      globalThis.__driverRanges = ['Param85', 'Param86', 'Param87', 'Param23', 'Param2', 'Param89'].map(id => {
        const i = this._model.getParameterIndex(CubismFramework.getIdManager().getId(id));
        return i < 0 ? { id, missing: true }
          : { id, min: this._model.getParameterMinimumValue(i), max: this._model.getParameterMaximumValue(i), def: this._model.getParameterDefaultValue(i) };
      });
      globalThis.__setDriver = (id, v) => { this.set(id, v); };
    }
    this._model.update();
    this.defaults = Array.from(this._model.getModel().parameters.values);
  }
  /**
   * Write a parameter, ignoring names this rig does not have.
   *
   * The action table and the presets both name parameters directly (ParamAngleX,
   * Param85, ...). A different model will not have all of them, and that must not be
   * fatal: the actions that can run still run. Unknown names are counted once so the
   * mismatch is visible in the log rather than silent.
   */
  set(name, value) {
    const m = this._model;
    const id = CubismFramework.getIdManager().getId(name);
    const i = m.getParameterIndex(id);
    if (i >= 0 && i < m.getParameterCount()) { m.setParameterValueByIndex(i, value); return true; }
    this.countMissing(name);
    return false;
  }
  /** Record names this rig lacks, once each, so switching models is diagnosable. */
  countMissing(name) {
    if (!this._missingParameters) this._missingParameters = new Set();
    if (this._missingParameters.has(name)) return;
    this._missingParameters.add(name);
    if (this._missingParameters.size === 1) {
      this.report({ type: 'model-parameter-missing', message: name });
    }
  }
  get(name) { return this._model.getParameterValueById(CubismFramework.getIdManager().getId(name)); }
  setAutomaticPolicy(policy) {
    // The host sends this sentinel at a backend-generation boundary. Other
    // foreign model IDs must not silently reset the monotonic revision guard.
    if (policy?.modelId === 'disconnected') this.policyRevision = -1;
    if (policy?.modelId !== presetCatalog.modelId) { this.policyValid = false; this.automaticIds.clear(); this.interaction.release(); this.clearAutomatic(); return false; }
    if (!Number.isSafeInteger(policy.revision) || policy.revision < 0 || policy.revision < this.policyRevision) return false;
    if (!Array.isArray(policy.enabledIds) || policy.enabledIds.some(id => presets.get(id)?.availability !== 'automatic')) { this.policyValid = false; this.automaticIds.clear(); this.interaction.release(); this.clearAutomatic(); return false; }
    const next = new Set(policy.enabledIds);
    if (this.policyValid && policy.revision === this.policyRevision) return next.size === this.automaticIds.size && [...next].every(id => this.automaticIds.has(id));
    this.policyValid = true; this.policyRevision = policy.revision; this.automaticIds = next;
    if (!['proc-head', 'proc-body', 'proc-blink'].some(id => next.has(id))) this.interaction.release();
    if (!this.previewMode) {
      let released = false;
      if (this.faceKey && !automaticItems.some(item => item.expressionName === this.faceKey && next.has(item.id))) { this._expressionManager.stopAllMotions(); this.faceKey = ''; released = true; }
      if (this.gestureKey && !automaticItems.some(item => item.expressionName === this.gestureKey && next.has(item.id))) { this.gestureManager.stopAllMotions(); this.gestureKey = ''; released = true; }
      if (released) this.expressionValues.clear();
      if (!next.has('motion-idle-0')) this._motionManager.stopAllMotions();
    }
    return true;
  }
  clearAutomatic() {
    if (!this.previewMode) this._motionManager.stopAllMotions();
    this._expressionManager.stopAllMotions(); this.gestureManager.stopAllMotions();
    this.faceKey = ''; this.gestureKey = ''; this.expressionValues.clear();
  }
  captureAppearance() {
    if (!this.defaults) return;
    for (const id of this.appearanceParameters) this.defaults[this.parameterIndices.get(id)] = this.get(id);
  }
  beginAttention() {
    if (this.ready && !this.previewMode && this.policyValid && ['proc-head', 'proc-body', 'proc-blink'].some(id => this.automaticIds.has(id))) this.interaction.start(performance.now());
  }
  reset({ preserveAttention = false } = {}) {
    if (!preserveAttention) this.interaction.release();
    this.clearAutomatic();
    if (this.previewMode) { this.stopPreview(); return; }
    // Release transient controls only; clothing/accessory state is not a turn.
    if (this._model && this.defaults) for (const id of this.runtimeParameters) if (!interactionParameters.includes(id)) this.set(id, this.defaults[this.parameterIndices.get(id)]);
  }
  enterPreview() {
    if (this.previewMode) return;
    this.clearAutomatic(); this.previewMode = true;
    this.previewBaseline = Array.from(this._model.getModel().parameters.values);
    for (const id of this.previewParameters) this.previewValues.set(id, this.get(id));
  }
  selectPreset(id) {
    const item = presets.get(id);
    if (!this._model || !item?.previewable || item.availability === 'unavailable') throw new Error('这个预设暂时不能预览');
    this.enterPreview(); this.previewManager.stopAllMotions(); this._motionManager.stopAllMotions(); this.previewSelection = item;
    if (item.expressionName) this.previewManager.startMotion(this.expressions.get(item.expressionName), false);
    return true;
  }
  stopPreview() {
    if (!this._model) return;
    this.enterPreview(); this.previewSelection = null; this.previewManager.stopAllMotions(); this._motionManager.stopAllMotions();
  }
  restorePreview() { this.stopPreview(); }
  blendParameters(parameters, values, delta) {
    const blend = 1 - Math.exp(-Math.max(0, delta) / .12);
    for (const id of parameters) {
      if (id === 'ParamMouthOpenY') continue;
      const target = this.get(id), previous = values.get(id) ?? target;
      const value = Math.abs(target - previous) < .0001 ? target : previous + (target - previous) * blend;
      values.set(id, value); this.set(id, value);
    }
  }
  updateView(view, interactionState = view.state, workFocus = false) {
    if (!this.ready) return;
    const now = performance.now(), delta = Math.min((now - this.last) / 1000, .1); this.last = now; this.elapsed += delta;
    if (!this.previewMode) this.captureAppearance();
    this._model.getModel().parameters.values.set(this.previewMode ? this.previewBaseline : this.defaults);
    const enabled = id => this.previewMode ? this.previewSelection?.id === id : this.automaticIds.has(id);
    const workActive=enabled('proc-work-focus') && (this.previewMode || workFocus && ['idle','error'].includes(view.state));
    if (this.idle && enabled('motion-idle-0')) {
      if (this._motionManager.isFinished()) this._motionManager.startMotionPriority(this.idle, false, 1);
      this._motionManager.updateMotion(this._model, delta);
      // Ease the clip's body angles back toward the neutral pose. The
      // interaction layer adds its own body sway further down, so that stays
      // responsive; only the idle clip's jolt is softened.
      if (idleBodyDamping < 1) for (const id of idleBodyParameters) {
        const index = this.parameterIndices.get(id);
        if (index === undefined) continue;
        this.set(id, this.defaults[index] + (this.get(id) - this.defaults[index]) * idleBodyDamping);
      }
    } else this._motionManager.stopAllMotions();
    if (enabled('proc-blink')) this.blink.updateParameters(this._model, delta);
    const rawExpression = workActive ? {emotion:'neutral',intensity:0,delivery:'',gesture:null} : view.invitation && view.state === 'idle' ? { emotion: 'neutral', intensity: 0, delivery: '', gesture: view.invitation.gesture } : view.expression;
    const expression = normalizePresentationIntent(rawExpression);
    const faceItem = faces.get(expression.emotion), gestureItem = gestures.get(expression.gesture);
    let face = '', gesture = '';
    if (!this.previewMode) {
      if (Object.hasOwn(expression, 'presetId')) {
        // A present null/unknown/disabled ID is explicitly neutral. It must not
        // fall back to the TTS emotion or the legacy gesture on the same reply.
        const item = presets.get(expression.presetId);
        if (item?.availability === 'automatic' && enabled(item.id)) {
          if (item.category === 'expression') face = item.expressionName;
          if (item.category === 'pose') gesture = item.expressionName;
        }
      } else {
        face = faceItem && enabled(faceItem.id) ? faceItem.expressionName : '';
        gesture = gestureItem && enabled(gestureItem.id) ? gestureItem.expressionName : '';
      }
    }
    if (face !== this.faceKey) { this._expressionManager.stopAllMotions(); if (face) this._expressionManager.startMotion(this.expressions.get(face), false); this.faceKey = face; }
    if (gesture !== this.gestureKey) { this.gestureManager.stopAllMotions(); if (gesture) this.gestureManager.startMotion(this.expressions.get(gesture), false); this.gestureKey = gesture; }
    this._expressionManager.updateMotion(this._model, delta); this.gestureManager.updateMotion(this._model, delta);
    if (this.previewMode) this.previewManager.updateMotion(this._model, delta);
    // The SDK managers reset on intent changes. Carry only supported expression
    // parameters across frames, so changing a face/pose does not pop to defaults.
    if (!this.previewMode) this.blendParameters(this.expressionParameters, this.expressionValues, delta);
    const active = !this.previewMode && view.state === 'speaking';
    const movement = this.interaction.sample({ now, delta, elapsed: this.elapsed, state: this.previewMode ? 'idle' : interactionState,
      head: enabled('proc-head')||workActive, body: enabled('proc-body')||workActive, blink: enabled('proc-blink')||workActive, work:workActive, reducedMotion:globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches===true });
    if (this._physics) this._physics.evaluate(this._model, delta);
    // Head, gaze and blink MUST be applied after the physics step.
    //
    // This rig's physics chain resets ParamAngle* and ParamEye* to zero on every
    // evaluate(), so setting them beforehand was silently erased each frame: the
    // character could only ever move its mouth and the projection offset, which
    // is exactly what "动作看不出来" looked like. The body channel below already
    // ran after physics; the head had simply been left on the wrong side.
    if (enabled('proc-head') || workActive) {
      this.set(parameterMap.headYaw, movement.yaw); this.set(parameterMap.headPitch, movement.pitch); this.set(parameterMap.headRoll, movement.roll);
      this.set('ParamEyeBallX', movement.gazeX); this.set('ParamEyeBallY', movement.gazeY);
    }
    if (workActive || enabled('proc-blink') && !this.previewMode) {
      this.set('ParamEyeLOpen', Math.min(this.get('ParamEyeLOpen'), 1 - movement.blink * .95));
      this.set('ParamEyeROpen', Math.min(this.get('ParamEyeROpen'), 1 - movement.blink * .95));
    }
    // Eye contact with the cursor. A scripted action that moves the gaze itself
    // wins; otherwise the eyes follow the pointer and the whole head leans toward
    // it, which reads as attention without fighting the action layer.
    //
    // The curve expands the middle of the range (most cursor positions sit at
    // |x| ~ 0.3-0.6), and the head gains are close to this rig's +/-10 degree
    // clamp so the turn is unmistakable rather than a couple of degrees.
    // Ease the applied gaze toward the target the main process reported. Without
    // this the head stepped every time the 2 Hz system poll landed, which is the
    // stutter that made cursor tracking look choppy.
    if (this.cursorGazeTarget) {
      if (!this.cursorGaze) this.cursorGaze = { ...this.cursorGazeTarget };
      else {
        // ~110 ms time constant: fast enough that the eyes feel attached to the
        // pointer, slow enough to hide the 10 Hz sampling grid.
        const k = Math.min(1, delta * 9);
        this.cursorGaze.x += (this.cursorGazeTarget.x - this.cursorGaze.x) * k;
        this.cursorGaze.y += (this.cursorGazeTarget.y - this.cursorGaze.y) * k;
      }
    }
    if (this.cursorGaze && !this.previewMode && (enabled('proc-head') || workActive)) {
      const scripted = Math.abs(movement.gazeX ?? 0) + Math.abs(movement.gazeY ?? 0) > 0.02;
      // An action that drives the eyes itself used to cancel the cursor entirely,
      // which is what made a gesture "interrupt the following". It still gets
      // priority, but a share of the tracking survives so the pet never looks like
      // it stopped paying attention.
      const share = scripted ? .3 : 1;
      const shape = v => Number.isFinite(v) ? Math.sign(v) * Math.pow(Math.abs(v), 0.62) : 0;
      const gx = shape(this.cursorGaze.x) * share, gy = shape(this.cursorGaze.y) * share;
      if (!scripted) {
        this.set('ParamEyeBallX', gx);
        this.set('ParamEyeBallY', -gy * .85);
      }
      this.set(parameterMap.headYaw, this.get(parameterMap.headYaw) + gx * 16);
      this.set(parameterMap.headPitch, this.get(parameterMap.headPitch) - gy * 13);
      this.set(parameterMap.headRoll, this.get(parameterMap.headRoll) + gx * -5.5);
      // Lean the body toward the pointer too. The head reaches this rig's +/-30
      // degree range near the screen edges, and the body channel keeps the pose
      // reading as "turning to look" past that point.
      this.set('ParamBodyAngleX', this.get('ParamBodyAngleX') + gx * 8);
      this.set('ParamBodyAngleZ', this.get('ParamBodyAngleZ') + gx * -3);
    }
    // Whole-sprite motion for ambient actions. This model clamps its head angle
    // parameters to +/-10 degrees, so rotating alone barely reads; shifting the
    // projection is what makes an action obvious. Values are in projection units
    // and are applied in syncViewport() below.
    this.ambientPose = this.previewMode ? null : { x: movement.offsetX || 0, y: movement.offsetY || 0, zoom: movement.zoom || 0 };
    // Deliberate body movement layers after this model's physics; mouth remains last.
    if (enabled('proc-body') || workActive) this.set('ParamBodyAngleX', this.get('ParamBodyAngleX') + movement.body);
    if (this.previewMode) this.blendParameters(this.previewParameters, this.previewValues, delta);
    // This asset's MouthForm2 is a smile shape; only MouthOpenY receives output amplitude.
    this.set(parameterMap.mouthForm, face === '星星眼' ? .7 : face === '脸红' ? .25 : 0);
    // Yawn / sigh open the mouth through the ambient action channel; speech stays
    // additive so an action can never swallow a talking mouth. `speechMouth` is
    // the live amplitude of locally played audio.
    this.set('ParamMouthOpenY', Math.min(1, (active ? Math.min(1, Math.sqrt(view.mouth) * 1.9) : 0) + (movement.mouth || 0) + (this.speechMouth || 0)));
    for (const [id, value] of this.parameterOverrides) this.set(id, value);
    // Rig pose parameters from an ambient action (抬手 / 生气 / 睡觉 …). They use
    // the model's own 0..100 range and are applied last so nothing overwrites them.
    // The interaction object is consulted as well as the sampled result: the
    // channels live on the former, and reading only the latter silently dropped them.
    const switches = movement.switches ?? this.interaction?.switches ?? [];
    if (switches.length) for (const item of switches) this.set(item.id, item.value);
    // Limb drivers, written after the solver so they survive this frame. The
    // physics chains then carry the motion forward naturally.
    const phys = movement.phys ?? this.interaction?.phys ?? [];
    if (phys.length) {
      for (const item of phys) {
        if (item && Number.isFinite(item.value)) this.set(item.id, item.value);
      }
    }
    this._model.update();
    // Between update() and draw(): the only window where a vertex write survives,
    // because update() recomputes every drawable's positions.
    if (ARM_POSING_ENABLED) this.poseArmVertices(movement);
    this.draw();
  }
  /**
   * Discover the arm drawables once, by bounding box.
   *
   * The measurements were unambiguous: this model's twenty arm parameters, and the
   * three physics drivers that feed them, are named and read/write - yet none of
   * them displaces a single vertex. The arms are static art; only the head, face and
   * body sway are rigged.
   *
   * The vertices themselves ARE reachable. CubismModel.getDrawableVertexPositions()
   * returns the live Float32Array from model.drawables.vertexPositions, not a copy,
   * so writing to it moves the part.
   *
   * Drawables are classified by where they sit rather than by name, because this
   * build's part ids do not survive the framework in a readable form: the two large
   * mirrored vertical strips at x[-0.31,-0.08] and x[0.05,0.28], both y[-0.11,0.53],
   * are the sleeves, and the smaller pieces sharing th  /**
   * 读取当前模型的可切换功能。
   *
   * 有些模型把发型、动作、呆毛这些做成参数开关，并用表情文件暴露出来
   * （无尽夏就是这样）。安装模型时会扫一遍生成 features.json，这里读它。
   * 没有这个文件的模型就是不支持，面板里不会出现对应控件。
   */
  async loadFeatures(read) {
    this.features = null;
    try {
      const buf = await read('features.json');
      const parsed = JSON.parse(new TextDecoder().decode(buf));
      if (parsed?.groups && Object.keys(parsed.groups).length) this.features = parsed;
    } catch {
      // 没有 features.json 很正常，不是错误
      this.features = null;
    }
    this.featureSelection = {};
    if (this.features) {
      for (const [key, group] of Object.entries(this.features.groups)) {
        this.featureSelection[key] = group.exclusive ? -1 : group.options.map(() => false);
      }
    }
  }

  /** 面板据此渲染控件。 */
  getFeatures() { return this.features; }

  /**
   * 切换某个功能项。
   *
   * 互斥的组（发型、动作）先把整组归零，再点亮选中的那个，再点一次取消；
   * 非互斥的（呆毛）就是开关。参数写进 parameterOverrides，它每帧都会被应用 ——
   * 只 set 一次会被 Cubism 的 update() 冲掉。
   */
  setFeature(groupKey, optionIndex) {
    const group = this.features?.groups?.[groupKey];
    if (!group) return false;
    const option = group.options[optionIndex];
    if (!option) return false;

    if (group.exclusive) {
      const current = this.featureSelection[groupKey];
      const next = current === optionIndex ? -1 : optionIndex;
      for (const opt of group.options) {
        for (const p of opt.params) this.parameterOverrides.set(p.id, 0);
      }
      if (next >= 0) {
        for (const p of group.options[next].params) this.parameterOverrides.set(p.id, p.value);
      }
      this.featureSelection[groupKey] = next;
    } else {
      const on = !this.featureSelection[groupKey][optionIndex];
      for (const p of option.params) this.parameterOverrides.set(p.id, on ? p.value : 0);
      this.featureSelection[groupKey][optionIndex] = on;
    }
    return true;
  }

  findArmDrawables() {
    const model = this._model;
    const out = [];
    if (!model?.getDrawableCount) return out;
    for (let i = 0; i < model.getDrawableCount(); i++) {
      const v = model.getDrawableVertices(i);
      if (!v || v.length < 8) continue;
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      for (let k = 0; k < v.length; k += 2) {
        if (v[k] < minX) minX = v[k];
        if (v[k] > maxX) maxX = v[k];
        if (v[k + 1] < minY) minY = v[k + 1];
        if (v[k + 1] > maxY) maxY = v[k + 1];
      }
      const cx = (minX + maxX) / 2, w = maxX - minX, h = maxY - minY;
      // Tall AND clearly off-centre. Dumping every drawable of every part (part
      // names are reachable via CubismId.getString) showed exactly two pieces on the
      // whole rig satisfying both:
      //
      //   Part16 上衣  #111 cx=-0.192 w=0.231 y[-0.11,0.53] h=0.64   left sleeve
      //                #110 cx=+0.164 w=0.230 y[-0.11,0.53] h=0.64   right sleeve
      //   Part20 后发  #6 cx=-0.211 h=0.42 n=4, #7 cx=+0.171 h=0.42 n=4
      //
      // Those two hair strands are tall and off-centre too, and the previous filter
      // selected them - four-vertex slivers that swept across the face. The vertex
      // count is what separates them from a real sleeve.
      if (h < 0.5) continue;
      if (w > 0.30) continue;
      if (Math.abs(cx) < 0.14) continue;
      if (v.length / 2 < 32) continue;
      out.push({ index: i, side: cx < 0 ? -1 : 1, span: h });
    }
    return out;
  }
  /**
   * Rotate each arm about its shoulder by the requested amount.
   *
   * Rotation about a shoulder is what makes an arm read as raised rather than as a
   * picture that slid sideways.
   *
   * @param movement sampled movement; armLift is in degrees, positive raises.
   */
  poseArmVertices(movement) {
    // Disabled for now.
    //
    // The vertex write itself works - measuring the sleeves during bothArmsUp showed
    // the right one move from x[0.052,0.294] to x[0.144,0.769] - and the selection is
    // now exact (#110 and #111, the two sleeves, with every hair strand excluded).
    // What it cannot do is fold an arm: each sleeve is one 0.64-long piece of cloth
    // with no elbow, so a hand cannot be brought to the face. Rotating rigidly threw
    // the cuff outside the silhouette; bending only moved the lower half.
    //
    // Set ARM_POSING_ENABLED to true to bring it back. The armLift values stay in the
    // action table, so nothing else has to change.
    if (!ARM_POSING_ENABLED) return;
    const raw = movement?.armLift ?? this.interaction?.armLift ?? 0;
    const deg = Number.isFinite(raw) ? raw : 0;
    if (!this._armDrawables) this._armDrawables = this.findArmDrawables();
    if (Math.abs(deg) < 0.2) return;
    const model = this._model;
    // Bend the sleeve rather than swinging it rigidly.
    //
    // Measuring the vertices during bothArmsUp showed the write works - the right
    // sleeve went from x[0.052,0.294] to x[0.144,0.769] - but it also showed why it
    // looked wrong: a sleeve is a 0.64-long piece of cloth, and rotating all of it
    // about the shoulder threw the cuff out to x=0.77 on a character only ±0.36 wide.
    //
    // A real arm bends, so the rotation is graded along the sleeve: nothing at the
    // shoulder, the full angle at the cuff. Rigid rotation is this with the gradient
    // removed. The pivot is taken from the rest pose so it does not drift.
    for (const arm of this._armDrawables) {
      const v = model.getDrawableVertices(arm.index);
      if (!v) continue;
      if (arm.pivotY === undefined) {
        let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
        for (let k = 0; k < v.length; k += 2) {
          if (v[k] < minX) minX = v[k];
          if (v[k] > maxX) maxX = v[k];
          if (v[k + 1] < minY) minY = v[k + 1];
          if (v[k + 1] > maxY) maxY = v[k + 1];
        }
        arm.pivotX = (minX + maxX) / 2;
        arm.pivotY = maxY;
        arm.span = (maxY - minY) || 1;
        arm.rest = Float32Array.from(v);
      }
      const px = arm.pivotX, py = arm.pivotY, span = arm.span, rest = arm.rest;
      for (let k = 0; k < v.length; k += 2) {
        // Take the offset from the sleeve's OWN pivot. Using the absolute x as the
        // offset put the centre of rotation at x=0, the body's midline, so the sleeve
        // pivoted around the spine and swept across the body.
        const dx = rest[k] - px, dy = rest[k + 1] - py;
        // 0 at the shoulder, 1 at the cuff.
        const t = Math.min(1, Math.max(0, -dy / span));
        // Scaled to 45% of the requested angle. The sleeve is 0.64 long and the
        // character only ±0.36 wide, so a full 90-degree rotation threw the cuff
        // outside the silhouette.
        const rad = (deg * 0.45 * arm.side * t * Math.PI) / 180;
        const c = Math.cos(rad), sn = Math.sin(rad);
        v[k] = px + dx * c - dy * sn;
        v[k + 1] = py + dx * sn + dy * c;
      }
    }
  }
  /** Play a short ambient action (nod / tilt / lookAway / perk / sway / breathe).
   *  Returns false for unknown names so a bad config entry is harmless. */
  playAmbient(action) { return this.interaction?.play(action, performance.now()) === true; }
  /**
   * Live mouth amplitude (0..1) for audio this renderer plays itself, such as the
   * cached ambient clips. Those do not go through the app playback controller, so
   * without this the character spoke with a closed mouth.
   */
  setSpeechAmplitude(value) { this.speechMouth = Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0; }
  /**
   * Where the cursor is, as -1..1 across the pet. Eye contact is the single
   * cheapest thing that makes a character look alive, and it also makes the pet
   * feel like it is paying attention to whoever is using the computer.
   *
   * This is a TARGET. The system state arrives about twice a second, and applying
   * it straight made the head move in visible steps; updateView() eases the
   * applied gaze toward it so the motion reads as continuous.
   */
  setCursorGaze(x, y) {
    const clamp = v => Number.isFinite(v) ? Math.max(-1, Math.min(1, v)) : 0;
    this.cursorGazeTarget = { x: clamp(x), y: clamp(y) };
  }
  /** 半身模式下模型的上移量。数值越大越往上（露出更多头顶）。 */
  setFramingOffset(y) {
    const value = Number(y);
    if (!Number.isFinite(value)) return;
    this.framingOffsetY = Math.max(-3, Math.min(3, value));
    this.syncViewport(true);
  }

  setFraming(mode) {
    if (!['full', 'half'].includes(mode) || this.framing === mode && this.projection) return;
    if (mode === 'full') this.feather?.releaseTexture();
    this.framing = mode; if (this.framingOffsetY === undefined) this.framingOffsetY = -1.60; this.syncViewport(true);
  }
  syncViewport(force = false) {
    if (!this.canvas) return;
    // A bounded 2x canvas also antialiases the large supplied textures on 1x screens.
    // No mip chain is allocated for the 8192/4096 texture sources.
    // A bounded 2x canvas also antialiases the large supplied textures on 1x
    // screens; no mip chain is allocated for the 8192 source. Measured: dropping
    // to 1.5x changed nothing (41 vs 42 fps), so the frame rate is capped by the
    // compositor for this transparent always-on-top window, not by pixel count.
    const dpr = Math.max(2, globalThis.devicePixelRatio || 1);
    const limit = this.gl?.getParameter(this.gl.MAX_RENDERBUFFER_SIZE) || 4096;
    const scale = Math.min(dpr, limit / Math.max(1, this.canvas.clientWidth, this.canvas.clientHeight));
    const width = Math.max(1, Math.round(this.canvas.clientWidth * scale)), height = Math.max(1, Math.round(this.canvas.clientHeight * scale));
    if (!force && this.canvas.width === width && this.canvas.height === height) return;
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width; this.canvas.height = height;
      this.setRenderTargetSize(width, height);
    }
    if (!this._modelMatrix) return;
    const zoom = this.framing === 'half' ? 3.2 : 1;
    this.projection = new CubismMatrix44();
    const pose = this.ambientPose;
    // Ambient scaling happens before the base scale so the framed half-body view
    // keeps its anchor; a zoom of 0.05 is a visible five percent swell.
    this.projection.scale(height / width * zoom * (1 + (pose?.zoom ?? 0)), zoom * (1 + (pose?.zoom ?? 0)));
    this.projection.multiplyByMatrix(this._modelMatrix);
    // translateX/translateY ASSIGN the matrix translation rather than adding to
    // it. The half-body framing therefore has to own the vertical position and
    // fold the ambient pose in: previously the +/-0.1 idle sway ran afterwards
    // and overwrote the framing's -1.6 on every frame, which left the camera
    // centred on the model and showed the skirt instead of the upper body.
    const poseX = pose?.x ?? 0, poseY = pose?.y ?? 0;
    if (this.framing === 'half') {
      this.projection.translateX(poseX);
      // 半身模式的上移量可由面板调节：默认 -1.60，用户可按需上下移动，
      // 让头顶完整露出来。数值越大越往上。
      this.projection.translateY((this.framingOffsetY ?? -1.60) + poseY);
    } else if (poseX || poseY) {
      // The full-body framing keeps whatever offset the model matrix established.
      this.projection.translate(poseX, poseY);
    }
  }
  draw() {
    this.syncViewport();
    const gl = this.gl; gl.viewport(0, 0, this.canvas.width, this.canvas.height); gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    this.getRenderer().setMvpMatrix(this.projection); this.getRenderer().setRenderState(null, [0, 0, this.canvas.width, this.canvas.height]); this.getRenderer().drawModel();
    if (this.framing === 'half') {
      this.feather ??= new ModelFeather(gl);
      if (!this.feather.apply(this.canvas) && !this.featherWarning) {
        this.featherWarning = true; this.report({ type: 'model-feather-unavailable', reason: this.feather.status });
      }
    }
  }
  snapshot() { return { mouth: this.get('ParamMouthOpenY'), body: this.get('ParamBodyAngleX'), face: this.faceKey, gesture: this.gestureKey, breath: this.get('ParamBreath') }; }
  dispose() {
    if (this.disposed) return;
    this.disposed = true; this.ready = false; this.feather?.dispose();
    this.gestureManager.stopAllMotions(); this.gestureManager.release(); this.previewManager.stopAllMotions(); this.previewManager.release();
    for (const tex of this.textures) this.gl?.deleteTexture(tex);
    this.textures = []; this.textureImages = []; this.expressions.clear(); this.previewValues.clear(); this.release();
    // The SDK renderer releases buffers/masks, but shader programs belong to its
    // context manager. Release that manager after our last canvas is disposed.
    if (webglOwners.delete(this) && webglOwners.size === 0) CubismShaderManager_WebGL.deleteInstance();
  }
}
