'use strict';

const { spawn } = require('node:child_process');
const readline = require('node:readline');
const { EventEmitter } = require('node:events');

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

class AppServerBridge extends EventEmitter {
  constructor({ command, args = [], env = {} }) {
    super();
    this.command = command;
    this.args = args;
    this.env = env;
    this.proc = null;
    this.nextId = 1;
    this.pending = new Map();
    this.started = false;
  }

  start() {
    if (this.started && this.proc) return this;
    const child = spawn(this.command, this.args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...this.env },
      windowsHide: true,
    });
    this.proc = child;
    this.started = true;

    const rl = readline.createInterface({
      input: child.stdout,
      crlfDelay: Infinity,
    });
    rl.on('line', (line) => this._onLine(line));

    child.stderr.on('data', (chunk) => this.emit('stderr', chunk.toString()));
    child.stdin.on('error', (err) => {
      this.emit('error', err);
      this._failAll(err);
    });
    child.on('error', (err) => this.emit('error', err));
    child.on('exit', (code, signal) => {
      this.started = false;
      this.emit('exit', { code, signal });
      this._failAll(new Error(`app-server exited (code=${code}, signal=${signal})`));
    });

    return this;
  }

  _onLine(line) {
    const raw = line.trim();
    if (!raw) return;

    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      this.emit('unparseable', raw);
      return;
    }

    if (msg.id != null && this.pending.has(msg.id)) {
      const waiter = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      clearTimeout(waiter.timer);
      if (msg.error) {
        waiter.reject(
          new Error(msg.error.message || JSON.stringify(msg.error)),
        );
      } else {
        waiter.resolve(msg.result);
      }
      return;
    }

    // 服务端主动发起的请求（带 id + method）：需要客户端响应
    if (msg.id != null && msg.method) {
      this.emit('request', msg);
      return;
    }

    if (msg.method) {
      this.emit('notification', msg);
    }
  }

  request(method, params, timeoutMs = DEFAULT_TIMEOUT_MS) {
    if (!this.proc || !this.started) {
      return Promise.reject(new Error('app-server 未启动'));
    }
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const timer = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`请求超时: ${method}`));
        }
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this._write({ id, method, params });
    });
  }

  notify(method, params) {
    this._write({ method, params });
  }

  respond(id, result) {
    this._write({ id, result });
  }

  _write(msg) {
    if (!this.proc || !this.started || this.proc.stdin.destroyed) {
      throw new Error('app-server 未启动或输入流已关闭');
    }
    try {
      this.proc.stdin.write(JSON.stringify(msg) + '\n');
    } catch (err) {
      this.emit('error', err);
      throw err;
    }
  }

  async initialize(clientInfo, extra = {}) {
    const result = await this.request('initialize', { clientInfo, ...extra });
    this.notify('initialized', {});
    return result;
  }

  _failAll(err) {
    for (const waiter of this.pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(err);
    }
    this.pending.clear();
  }

  stop() {
    if (this.proc) {
      this.proc.kill();
    }
    this.started = false;
  }
}

module.exports = { AppServerBridge };
