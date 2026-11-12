// @ts-check
const { record, string } = require('./client.cjs');

/** @typedef {{ id: string, label: string, status: string, assignment: string, update: string, currentCommand: string, result: string, parentId: string, progress: Progress[] }} Agent */
/** @typedef {{ kind: 'update'|'reasoning', text: string }} Progress */
/** @typedef {{ id: string, fromId: string, toId: string, kind: 'assignment'|'result', text: string }} Handoff */
/** @typedef {{ id: string, agentId: string, command: string, status: string, output: string, exitCode?: number, resolved: boolean }} Command */
/** @typedef {{ agentId: string, path: string }} ChangedFile */
/** @typedef {{ agentId: string, text: string, failed?: boolean, output?: string }} Activity */
/** @typedef {{ rootId: string, status: string, agents: Agent[], timeline: Activity[], commands: Command[], changedFiles: ChangedFile[], handoffs: Handoff[], workspacePath?: string, turnId?: string }} Run */

/** @param {string} rootId @param {string} prompt @returns {Run} */
function startRun(rootId, prompt) {
  return {
    rootId, status: 'running', timeline: [], commands: [], changedFiles: [], handoffs: [],
    agents: [{ id: rootId, label: 'Lead agent', status: 'running', assignment: prompt, update: '', currentCommand: '', result: '', parentId: '', progress: [] }]
  };
}

/** @param {Run} run @param {string} id @param {Partial<Agent>} changes @returns {Run} */
function updateAgent(run, id, changes) {
  const current = run.agents.find(agent => agent.id === id);
  const agent = {
    id, label: `Subagent ${run.agents.length}`, status: 'observed',
    assignment: '', update: '', currentCommand: '', result: '', parentId: '', progress: [], ...current, ...changes
  };
  return {
    ...run,
    agents: current ? run.agents.map(entry => entry.id === id ? agent : entry) : [...run.agents, agent]
  };
}

/** @param {Run} run @param {Activity} activity @returns {Run} */
function addActivity(run, activity) {
  return { ...run, timeline: [...run.timeline.slice(-99), activity] };
}

/** @param {Run} run @param {Handoff} handoff @returns {Run} */
function recordHandoff(run, handoff) {
  const previous = run.handoffs.find(entry => entry.id === handoff.id);
  if (previous?.text === handoff.text) return run;
  return { ...run, handoffs: previous
    ? run.handoffs.map(entry => entry.id === handoff.id ? handoff : entry)
    : [...run.handoffs, handoff] };
}

/** @param {Run} run @param {string} id @returns {Run} */
function collectResult(run, id) {
  const agent = run.agents.find(entry => entry.id === id);
  if (!agent?.parentId || agent.status !== 'completed') return run;
  const assignment = run.handoffs.findLast(entry => entry.kind === 'assignment' && entry.toId === id);
  const firstObservedResult = run.handoffs.find(entry => entry.id === `result:${id}:observed`);
  const assignments = run.handoffs.filter(entry => entry.kind === 'assignment' && entry.toId === id);
  return recordHandoff(run, {
    id: firstObservedResult && assignments.length <= 1 ? firstObservedResult.id : `result:${id}:${assignment?.id ?? 'observed'}`, fromId: id, toId: agent.parentId,
    kind: 'result', text: agent.result || agent.update || 'Completed without a reported result.'
  });
}

/** @param {Run} run @param {string} id @param {Progress} progress @returns {Run} */
function recordProgress(run, id, progress) {
  const entries = run.agents.find(agent => agent.id === id)?.progress ?? [];
  if (entries.at(-1)?.kind === progress.kind && entries.at(-1)?.text === progress.text) return run;
  return updateAgent(run, id, { progress: [...entries.slice(-49), progress] });
}

/** @param {Run} run @param {string} method @param {object} params @returns {Run} */
function reduceActivity(run, method, params) {
  if (!['thread/started', 'turn/completed', 'item/started', 'item/completed'].includes(method)) return run;
  const event = record(params);
  if (method === 'thread/started') {
    const thread = record(event.thread);
    const id = string(thread.id);
    if (id === run.rootId || typeof thread.parentThreadId !== 'string' ||
        !run.agents.some(agent => agent.id === thread.parentThreadId)) return run;
    const next = updateAgent(run, id, {
      parentId: thread.parentThreadId, status: 'running',
      ...(typeof thread.agentNickname === 'string' ? { label: thread.agentNickname } : {})
    });
    return next;
  }
  const threadId = string(event.threadId);
  if (method === 'turn/completed') {
    const turn = record(event.turn);
    const status = string(turn.status);
    const next = updateAgent(run, threadId, { status, currentCommand: '' });
    const detail = turn.error ? ` · ${string(record(turn.error).message)}` : '';
    return addActivity({ ...collectResult(next, threadId), status: threadId === run.rootId ? status : run.status }, { agentId: threadId, text: `Turn ${status}${detail}` });
  }

  const item = record(event.item);
  const completed = method === 'item/completed';
  const type = string(item.type);
  switch (type) {
    case 'collabAgentToolCall': {
      const sender = string(item.senderThreadId);
      const tool = string(item.tool);
      if (!Array.isArray(item.receiverThreadIds)) throw new TypeError('Codex collaboration item lacks receiver thread IDs.');
      let next = updateAgent(run, sender, {});
      const states = record(item.agentsStates);
      for (const receiver of item.receiverThreadIds) {
        const id = string(receiver);
        const state = Object.hasOwn(states, id) ? record(states[id]) : {};
        const assignmentId = `assignment:${typeof item.id === 'string' ? item.id : `${sender}:${id}:${item.prompt}`}:${id}`;
        const deliversAssignment = ['spawnAgent', 'sendInput', 'resumeAgent', 'followupTask', 'sendMessage'].includes(tool) && typeof item.prompt === 'string' && item.prompt.trim().length > 0;
        const newAssignment = deliversAssignment && !next.handoffs.some(entry => entry.id === assignmentId);
        const priorResult = next.agents.find(agent => agent.id === id)?.result;
        const staleCompletion = newAssignment && state.status === 'completed' && state.message === priorResult;
        next = updateAgent(next, id, {
          ...(deliversAssignment ? { assignment: string(item.prompt), parentId: tool === 'spawnAgent' ? sender : next.agents.find(agent => agent.id === id)?.parentId || sender, ...(newAssignment ? { result: '', status: 'running' } : {}) } : {}),
          ...(!staleCompletion && typeof state.status === 'string' ? { status: state.status } : {}),
          ...(!staleCompletion && typeof state.message === 'string' ? { update: state.message, ...(state.status === 'completed' ? { result: state.message } : {}) } : {})
        });
        if (deliversAssignment) {
          next = recordHandoff(next, {
            id: assignmentId,
            fromId: sender, toId: id, kind: 'assignment', text: string(item.prompt)
          });
        }
        if (!staleCompletion && (!newAssignment || typeof state.message === 'string')) next = collectResult(next, id);
      }
      return addActivity(next, { agentId: sender, text: `Delegation · ${tool} · ${string(item.status)}` });
    }
    case 'subAgentActivity': {
      const id = string(item.agentThreadId);
      const kind = string(item.kind);
      const current = run.agents.find(agent => agent.id === id);
      const changes = {
        ...(kind !== 'interacted' && !(kind === 'started' && current?.status === 'completed')
          ? { status: kind === 'started' ? 'running' : kind } : {}),
        ...(id !== run.rootId && (typeof item.parentThreadId === 'string' || (kind === 'started' && !current?.parentId))
          ? { parentId: typeof item.parentThreadId === 'string' ? item.parentThreadId : run.rootId } : {}),
        ...(typeof item.agentNickname === 'string' ? { label: item.agentNickname } : {})
      };
      let next = updateAgent(run, id, changes);
      const parentId = next.agents.find(agent => agent.id === id)?.parentId;
      if (kind === 'started' && parentId && !next.handoffs.some(entry => entry.kind === 'assignment' && entry.toId === id)) {
        next = recordHandoff(next, {
          id: `assignment:observed:${typeof item.id === 'string' ? item.id : id}`,
          fromId: parentId, toId: id, kind: 'assignment', text: 'Task details are not exposed by Codex.'
        });
      }
      next = collectResult(next, id);
      return completed ? addActivity(next, { agentId: id, text: `Subagent ${kind}` }) : next;
    }
    case 'userMessage': {
      if (!completed || threadId === run.rootId || !Array.isArray(item.content)) return run;
      const parentId = run.agents.find(agent => agent.id === threadId)?.parentId;
      if (!parentId) return run;
      const text = item.content.filter(part => record(part).type === 'text')
        .map(part => string(record(part).text)).join('\n');
      return text.trim() ? reduceActivity(run, 'item/completed', { threadId, item: {
        type: 'agentAssignment', id: item.id, parentThreadId: parentId, text
      } }) : run;
    }
    case 'agentAssignment': {
      if (!completed) return run;
      const text = string(item.text);
      const parentId = string(item.parentThreadId);
      const previous = run.handoffs.findLast(entry => entry.kind === 'assignment' && entry.toId === threadId);
      if (previous?.id.startsWith('assignment:observed:') && previous.text === 'Task details are not exposed by Codex.' && previous.fromId === parentId) {
        return recordHandoff(updateAgent(run, threadId, { assignment: text, parentId }), { ...previous, text });
      }
      if (previous?.text === text && previous.fromId === parentId) {
        return updateAgent(run, threadId, { assignment: text, parentId });
      }
      const next = updateAgent(run, threadId, { assignment: text, parentId, result: '', status: 'running' });
      return recordHandoff(next, {
        id: `assignment:${typeof item.id === 'string' ? item.id : `observed-${run.handoffs.length}`}:${threadId}`,
        fromId: parentId, toId: threadId, kind: 'assignment', text
      });
    }
    case 'agentMessage': {
      if (!completed) return run;
      const text = string(item.text);
      const next = updateAgent(run, threadId, {
        update: text,
        ...(item.phase === 'final_answer' || item.phase === 'final' || item.phase == null ? { result: text } : {})
      });
      return collectResult(recordProgress(next, threadId, { kind: 'update', text }), threadId);
    }
    case 'reasoning': {
      if (!completed || !Array.isArray(item.summary)) return run;
      const text = item.summary.map(part => typeof part === 'string' ? part : string(record(part).text)).join('\n');
      return text.trim() ? recordProgress(run, threadId, { kind: 'reasoning', text }) : run;
    }
    case 'commandExecution': {
      const command = string(item.command);
      const status = completed ? string(item.status) : 'running';
      const failed = completed && (status === 'failed' ||
        (typeof item.exitCode === 'number' && item.exitCode !== 0));
      const output = typeof item.aggregatedOutput === 'string' ? item.aggregatedOutput.slice(-12000) : '';
      const active = run.commands.findLast(entry => entry.agentId === threadId && entry.command === command && entry.status === 'running');
      const id = typeof item.id === 'string' ? item.id : active?.id ?? `command-${run.commands.length}`;
      const succeeded = completed && !failed && status === 'completed' &&
        (item.exitCode === undefined || item.exitCode === 0);
      const evidence = {
        id, agentId: threadId, command, status: failed ? 'failed' : status, output, resolved: false,
        ...(typeof item.exitCode === 'number' ? { exitCode: item.exitCode } : {})
      };
      const previous = run.commands.filter(entry => !(entry.id === id && entry.agentId === threadId));
      const commands = [...previous.map(entry =>
        succeeded && entry.agentId === threadId && entry.command === command && entry.status === 'failed'
          ? { ...entry, resolved: true } : entry), evidence];
      const next = updateAgent({ ...run, commands }, threadId, {
        currentCommand: commands.findLast(entry => entry.agentId === threadId && entry.status === 'running')?.command ?? ''
      });
      return addActivity(next, {
        agentId: threadId, text: `${failed ? 'Failed' : status} · ${command}`, failed,
        ...(failed && output ? { output } : {})
      });
    }
    case 'fileChange': {
      if (!Array.isArray(item.changes)) throw new TypeError('Codex file change item lacks changes.');
      if (!completed || item.status === 'failed') return run;
      const paths = item.changes.map(change => string(record(change).path));
      const additions = [...new Set(paths)].filter(path =>
        !run.changedFiles.some(file => file.agentId === threadId && file.path === path));
      return addActivity(updateAgent({ ...run,
        changedFiles: [...run.changedFiles, ...additions.map(path => ({ agentId: threadId, path }))]
      }, threadId, {}), {
        agentId: threadId, text: `File change · ${paths.join(', ')}`
      });
    }
    default:
      return run;
  }
}

module.exports = { startRun, reduceActivity };
