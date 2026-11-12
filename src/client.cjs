// @ts-check
const { spawn } = require('node:child_process');
const { createInterface } = require('node:readline');

class CodexProtocolError extends Error {}

/** @param {object} value @returns {Record<string, object | string | number | boolean | null>} */
function record(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new CodexProtocolError('Expected a Codex protocol object.');
  }
  return value;
}

/** @param {object | string | number | boolean | null} value */
function string(value) {
  if (typeof value !== 'string') throw new CodexProtocolError('Expected a Codex protocol string.');
  return value;
}

class CodexClient {
  /** @param {string} executable @param {string} cwd @param {(method: string, params: object) => void} onEvent @param {(error: Error) => void} onFailure */
  constructor(executable, cwd, onEvent, onFailure) {
    this.process = spawn(executable, ['app-server', '--listen', 'stdio://'], { cwd });
    /** @type {Map<number, {method: string, resolve: (value: object) => void, reject: (error: Error) => void, timer: ReturnType<typeof setTimeout>}>} */
    this.pending = new Map();
    this.nextId = 0;
    this.closed = false;
    let diagnostics = '';
    this.process.stderr.setEncoding('utf8').on('data', (chunk) => {
      diagnostics = (diagnostics + chunk).slice(-4000);
    });
    const fail = (/** @type {Error} */ error) => {
      if (this.closed) return;
      this.close(error);
      onFailure(error);
    };
    this.process.on('error', fail);
    this.process.stdin.on('error', fail);
    this.process.on('close', (code, signal) => {
      fail(new CodexProtocolError(`Codex app-server exited (${code ?? signal}). ${diagnostics}`));
    });
    createInterface({ input: this.process.stdout }).on('line', (line) => {
      if (this.closed) return;
      try {
        const message = record(JSON.parse(line));
        if (typeof message.method === 'string') {
          if (message.id !== undefined) {
            throw new CodexProtocolError(`Codex requested ${message.method}. This read-only prototype cannot answer it, so the run stopped.`);
          }
          onEvent(message.method, message.params);
          return;
        }
        if (typeof message.id !== 'number') throw new CodexProtocolError('Codex returned a response without a numeric request ID.');
        const request = this.pending.get(message.id);
        if (!request) return;
        this.pending.delete(message.id);
        clearTimeout(request.timer);
        if (message.error) {
          request.reject(new CodexProtocolError(`${request.method} failed: ${JSON.stringify(message.error)}`));
          return;
        }
        request.resolve(message.result);
      } catch (error) {
        fail(error instanceof Error ? error : new CodexProtocolError(String(error)));
      }
    });
  }

  /** @param {object} message */
  send(message) {
    if (this.closed) throw new CodexProtocolError('Codex connection is closed.');
    this.process.stdin.write(JSON.stringify(message) + '\n');
  }

  /** @param {string} method @param {object} params @returns {Promise<object>} */
  request(method, params) {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      this.send({ id, method, params });
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new CodexProtocolError(`${method} timed out waiting for Codex app-server.`));
      }, 30_000);
      this.pending.set(id, { method, resolve, reject, timer });
    });
  }

  async initialize() {
    await this.request('initialize', {
      clientInfo: { name: 'agent_campus', title: 'Agent Campus', version: '0.0.1' },
      capabilities: null
    });
    this.send({ method: 'initialized' });
  }

  /** @param {string} cwd */
  async startThread(cwd) {
    const result = record(await this.request('thread/start', {
      cwd, sandbox: 'read-only', approvalPolicy: 'never'
    }));
    return string(record(result.thread).id);
  }

  /** @param {string} threadId @param {string} prompt */
  startTurn(threadId, prompt) {
    return this.request('turn/start', {
      threadId, input: [{ type: 'text', text: prompt, text_elements: [] }]
    });
  }

  /** @param {Error} reason */
  close(reason) {
    if (this.closed) return;
    this.closed = true;
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer);
      reject(reason);
    }
    this.pending.clear();
    this.process.kill();
  }
}

module.exports = { CodexClient, CodexProtocolError, record, string };
