import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';

/** The same bounded NDJSON protocol as the Swift shell, using a separate system Node. */
export class BackendConnection {
  generation = 0;
  state = 'disconnected';
  child = null;
  closing = new Set();
  // A cold backend start opens SQLite and re-verifies fingerprints; on a slow
  // disk (or with real-time antivirus scanning) that can exceed 15 seconds and
  // the pet then reports "对话服务连接失败" even though the backend is healthy.
  constructor({ onState, onMessage, timeoutMs = 60000, shutdownTimeoutMs = 10000, limit = 64 * 1024 * 1024 }) {
    Object.assign(this, { onState, onMessage, timeoutMs, shutdownTimeoutMs, limit });
    /** Messages that arrived before backend_ready; replayed once it lands. */
    this.pendingMessages = [];
  }
  start(executable, args, env = process.env) {
    this.close();
    const generation = ++this.generation;
    this.state = 'connecting';
    this.pendingMessages.length = 0;
    this.onState({ generation, state: this.state, canRetry: true });
    let child;
    try { child = spawn(executable, args, { env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }); }
    catch { this.fail(generation, 'failed', 'launch'); return; }
    this.child = child;
    const decoder = new StringDecoder('utf8');
    let pending = '', bytes = 0;
    this.deadline = setTimeout(() => this.fail(generation, 'failed', 'ready-timeout'), this.timeoutMs);
    child.on('error', () => this.fail(generation, 'failed', 'launch'));
    child.on('exit', () => this.fail(generation, 'disconnected', 'exit'));
    child.stdin.on('error', () => this.fail(generation, 'disconnected', 'write'));
    // Backend diagnostics are already redacted; stdout is reserved for protocol data.
    child.stderr.on('data', chunk => process.stderr.write(chunk));
    child.stdout.on('data', chunk => {
      if (!this.live(generation)) return;
      bytes += chunk.length;
      if (bytes > this.limit) { this.fail(generation, 'failed', 'message-too-large'); return; }
      pending += decoder.write(chunk);
      let newline;
      while ((newline = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, newline); pending = pending.slice(newline + 1);
        bytes = Buffer.byteLength(pending, 'utf8');
        let message;
        try { message = JSON.parse(line); if (!message || typeof message !== 'object' || Array.isArray(message)) throw Error(); }
        catch { this.fail(generation, 'failed', 'invalid-message'); return; }
        if (message.channel === 'backend_ready') {
          if (this.state !== 'connecting') continue;
          clearTimeout(this.deadline); this.state = 'ready';
          // The backend announces its presentation policy BEFORE backend_ready,
          // and everything that arrived while connecting used to be dropped. That
          // silently discarded the policy, leaving automaticIds empty so the
          // character barely moved. Replay the queued messages now that the
          // handshake is complete.
          const queued = this.pendingMessages.splice(0);
          for (const early of queued) {
            this.onMessage(early, generation);
            if (!this.live(generation)) return;
          }
        } else if (this.state !== 'ready') {
          this.pendingMessages.push(message);
          if (this.pendingMessages.length > 200) this.pendingMessages.shift();
          continue;
        }
        this.onMessage(message, generation);
        if (!this.live(generation)) return;
      }
    });
  }
  live(generation) { return generation === this.generation && ['ready', 'connecting'].includes(this.state); }
  send(message, generation) {
    if (generation !== this.generation || this.state !== 'ready' || !this.child) return false;
    let line;
    try { line = JSON.stringify(message) + '\n'; } catch { return false; }
    if (Buffer.byteLength(line) + this.child.stdin.writableLength > this.limit) {
      this.fail(generation, 'failed', 'write-overflow'); return false;
    }
    this.child.stdin.write(line); return true;
  }
  fail(generation, state, reason) {
    if (!this.live(generation)) return;
    this.close(); this.state = state;
    this.onState({ generation, state, reason, canRetry: true });
  }
  close() {
    clearTimeout(this.deadline); this.state = 'disconnected';
    const child = this.child; this.child = null;
    if (!child) return Promise.all(this.closing);
    // EOF lets the backend flush SQLite and remove its own lock on Windows.
    const done = new Promise(resolve => {
      if (child.exitCode !== null || child.signalCode !== null) { resolve(); return; }
      const timer = setTimeout(() => child.kill('SIGKILL'), this.shutdownTimeoutMs);
      child.once('exit', () => { clearTimeout(timer); resolve(); });
      child.once('error', () => { clearTimeout(timer); resolve(); });
    });
    this.closing.add(done);
    void done.then(() => this.closing.delete(done));
    child.stdin.end();
    return Promise.all(this.closing);
  }
}
