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
    this.notifications = Promise.resolve();
    this.rootThreadId = '';
    /** @type {Set<string>} */
    this.rootTurnIds = new Set();
    /** @type {Map<string, string>} */
    this.observedItems = new Map();
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
          const method = message.method;
          const params = record(message.params);
          this.notifications = this.notifications.then(async () => {
            if (this.closed) return;
            if (method === 'turn/started' && params.threadId === this.rootThreadId) {
              this.rootTurnIds.add(string(record(params.turn).id));
            }
            if ((method === 'item/started' || method === 'item/completed') &&
                record(params.item).type === 'subAgentActivity') {
              await this.readSubagent(record(params.item), onEvent);
            }
            if (!this.closed) onEvent(method, params);
          }).catch(error => fail(error instanceof Error ? error : new CodexProtocolError(String(error))));
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

  /** @param {object} activity @param {(method: string, params: object) => void} onEvent */
  async readSubagent(activity, onEvent) {
    const observed = record(activity);
    const threadId = string(observed.agentThreadId);
    const response = record(await this.request('thread/read', { threadId, includeTurns: true }));
    if (this.closed) return;
    const thread = record(response.thread);
    if (thread.id !== threadId) throw new CodexProtocolError(`thread/read returned a different thread for subagent ${threadId}.`);
    const parentThreadId = string(thread.parentThreadId);
    if (!Array.isArray(thread.turns)) throw new CodexProtocolError(`thread/read lacks turns for subagent ${threadId}.`);
    onEvent('item/completed', {
      threadId, item: {
        type: 'subAgentActivity', agentThreadId: threadId, parentThreadId,
        agentNickname: thread.agentNickname, kind: 'interacted'
      }
    });
    if (observed.kind === 'started') {
      onEvent('item/completed', {
        threadId, item: { ...observed, parentThreadId, agentNickname: thread.agentNickname }
      });
    }
    const latest = thread.turns.at(-1);
    if (!latest) return;
    const turn = record(latest);
    if (this.rootTurnIds.has(string(turn.id))) return;
    if (!Array.isArray(turn.items)) throw new CodexProtocolError(`thread/read lacks items for subagent ${threadId}, turn ${string(turn.id)}.`);
    for (const value of turn.items) {
      const item = record(value);
      const type = string(item.type);
      if (!['userMessage', 'agentMessage', 'reasoning', 'commandExecution', 'fileChange'].includes(type)) continue;
      let normalized;
      if (type === 'userMessage') {
        if (!Array.isArray(item.content)) throw new CodexProtocolError(`Subagent ${threadId} assignment lacks content.`);
        const text = item.content.map(part => record(part)).filter(part => part.type === 'text')
          .map(part => string(part.text)).join('\n');
        if (!text.trim()) continue;
        normalized = { type: 'agentAssignment', id: item.id, text, parentThreadId };
      } else if (type === 'reasoning') {
        if (!Array.isArray(item.summary) || !item.summary.every(part => typeof part === 'string')) {
          throw new CodexProtocolError(`Subagent ${threadId} reasoning summary is not a string array.`);
        }
        normalized = { type, id: item.id, summary: item.summary };
      } else {
        normalized = item;
      }
      const key = `${threadId}:${string(item.id)}`;
      const signature = JSON.stringify(normalized);
      if (this.observedItems.get(key) === signature) continue;
      this.observedItems.set(key, signature);
      onEvent(['commandExecution', 'fileChange'].includes(type) && item.status === 'inProgress' ? 'item/started' : 'item/completed', {
        threadId, item: normalized
      });
    }
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
    this.rootThreadId = string(record(result.thread).id);
    return this.rootThreadId;
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
