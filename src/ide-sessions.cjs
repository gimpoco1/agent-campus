const { open, readdir, stat } = require('node:fs/promises');
const { resolve, join, isAbsolute } = require('node:path');
const { homedir } = require('node:os');
const { startRun, reduceActivity } = require('./activity.cjs');

function matchesWorkspace(meta, folders) {
  if (typeof meta.cwd !== 'string') return false;
  const roots = Array.isArray(meta.runtime_workspace_roots) ? meta.runtime_workspace_roots : [];
  return folders.some(folder => [meta.cwd, ...roots].some(root =>
    typeof root === 'string' && isAbsolute(root) && resolve(root) === folder));
}

async function readEvents(path, previous) {
  const file = await open(path, 'r');
  try {
    const { size, ino } = await file.stat();
    const cursor = previous?.ino === ino && size >= previous.offset ? previous : undefined;
    if (cursor && cursor.meta?.originator !== 'codex_vscode') return { cursor, events: [] };
    const offset = cursor?.offset ?? 0;
    const bytes = Buffer.alloc(size - offset);
    const { bytesRead } = await file.read(bytes, 0, bytes.length, offset);
    const end = bytes.subarray(0, bytesRead).lastIndexOf(10);
    if (end < 0) return { cursor, events: [] };
    const lines = bytes.subarray(0, end).toString('utf8').split('\n').filter(Boolean);
    const meta = cursor?.meta ?? JSON.parse(lines.shift()).payload;
    const events = meta?.originator === 'codex_vscode' ? lines.map(line => JSON.parse(line)) : [];
    return { cursor: { ino, offset: offset + end + 1, meta }, events };
  } finally {
    await file.close();
  }
}

function applyEvent(run, meta, event) {
  const payload = event.payload;
  const threadId = meta.id;
  if (typeof threadId !== 'string' || event.type !== 'event_msg' || !payload) return run;
  if (payload.type === 'task_started' && threadId !== run.rootId) {
    const nickname = meta.agent_nickname;
    const next = reduceActivity(run, 'item/completed', {
      threadId, item: { type: 'subAgentActivity', agentThreadId: threadId, kind: 'started' }
    });
    return typeof nickname === 'string' && nickname.trim()
      ? { ...next, agents: next.agents.map(agent => agent.id === threadId ? { ...agent, label: nickname } : agent) }
      : next;
  }
  if (payload.type === 'task_complete' || payload.type === 'turn_aborted') {
    const status = payload.type === 'task_complete' ? 'completed' : 'interrupted';
    return reduceActivity(run, 'turn/completed', { threadId, turn: { status } });
  }
  if (payload.type === 'user_message' && threadId === run.rootId && typeof payload.message === 'string') {
    return { ...run, agents: run.agents.map(agent =>
      agent.id === threadId ? { ...agent, assignment: payload.message } : agent) };
  }
  if (payload.type === 'agent_message' && typeof payload.message === 'string') {
    return reduceActivity(run, 'item/completed', { threadId, item: { type: 'agentMessage', text: payload.message } });
  }
  if (payload.type !== 'item_completed') return run;
  const item = payload.item;
  if (item?.type === 'UserMessage' || item?.type === 'AgentMessage') {
    if (!Array.isArray(item.content)) throw new TypeError('Codex chat message lacks content.');
    const text = item.content.filter(part => typeof part?.text === 'string').map(part => part.text).join('\n');
    return applyEvent(run, meta, {
      type: 'event_msg',
      payload: item.type === 'UserMessage' ? { type: 'user_message', message: text } : { type: 'agent_message', message: text }
    });
  }
  const types = { SubAgentActivity: 'subAgentActivity', CommandExecution: 'commandExecution', FileChange: 'fileChange' };
  if (!item || !Object.hasOwn(types, item.type)) return run;
  return reduceActivity(run, 'item/completed', {
    threadId,
    item: {
      ...item, type: types[item.type], agentThreadId: item.agent_thread_id,
      exitCode: item.exit_code, aggregatedOutput: item.aggregated_output,
      ...(item.type === 'FileChange' && item.changes && !Array.isArray(item.changes)
        ? { changes: Object.keys(item.changes).map(path => ({ path })) } : {})
    }
  });
}

function observeIdeSessions(folders, onRun, onError) {
  const base = resolve(process.env.CODEX_HOME ?? join(homedir(), '.codex'));
  const sessions = join(base, 'sessions');
  const startedAt = Date.now();
  const cursors = new Map();
  const family = new Set();
  let run;
  let turnId;
  let runStartedAt = startedAt;
  let timer;
  let disposed = false;

  async function flush(paths) {
    const batch = [];
    for (const path of paths) {
      try {
        const { cursor, events } = await readEvents(path, cursors.get(path));
        if (!cursor) continue;
        cursors.set(path, cursor);
        if (cursor.meta?.originator !== 'codex_vscode') continue;
        for (const event of events) {
          const at = Date.parse(event.timestamp);
          if (at >= startedAt) batch.push({ at, meta: cursor.meta, event });
        }
      } catch (error) {
        if (error.code === 'ENOENT') cursors.delete(path);
        else onError(error);
      }
    }

    const previous = run;
    for (const { at, meta, event } of batch.sort((a, b) => a.at - b.at)) {
      if (disposed) return;
      if (typeof meta.id !== 'string') continue;
      const payload = event.payload;
      if (meta.source === 'vscode' && !meta.parent_thread_id && matchesWorkspace(meta, folders) &&
          event.type === 'event_msg' && payload?.type === 'task_started' &&
          typeof payload.turn_id === 'string' && at >= runStartedAt) {
        run = startRun(meta.id, '');
        turnId = payload.turn_id;
        runStartedAt = at;
        family.clear();
        family.add(meta.id);
      }
      if (!run || at < runStartedAt) continue;
      if (meta.source?.subagent?.thread_spawn && family.has(meta.parent_thread_id)) family.add(meta.id);
      if (!family.has(meta.id) || (payload?.root_turn_id && payload.root_turn_id !== turnId)) continue;
      if (meta.id === run.rootId && payload?.turn_id && payload.turn_id !== turnId) continue;
      // Forked child logs can contain the parent's earlier turn and an inherited abort.
      if (meta.id !== run.rootId && payload?.turn_id === turnId) continue;
      if (typeof payload?.thread_id === 'string' && payload.thread_id !== meta.id) continue;
      run = applyEvent(run, meta, event);
    }
    if (!disposed && run !== previous) onRun(run, turnId);
  }

  async function poll() {
    try {
      const entries = await readdir(sessions, { recursive: true, withFileTypes: true });
      const paths = [];
      for (const entry of entries) {
        if (disposed) return;
        if (!entry.isFile() || !/^rollout-.*\.jsonl$/.test(entry.name)) continue;
        const path = join(entry.parentPath, entry.name);
        try {
          const info = await stat(path);
          const cursor = cursors.get(path);
          if (info.mtimeMs >= startedAt && (!cursor || cursor.ino !== info.ino ||
              (cursor.meta?.originator === 'codex_vscode' && cursor.offset !== info.size))) paths.push(path);
        } catch (error) {
          if (error.code !== 'ENOENT') onError(error);
        }
      }
      if (!disposed) await flush(paths);
    } catch (error) {
      if (error.code !== 'ENOENT') onError(error);
    } finally {
      if (!disposed) timer = setTimeout(poll, 1500);
    }
  }

  void poll();
  return { dispose() { disposed = true; clearTimeout(timer); } };
}

module.exports = { observeIdeSessions };
