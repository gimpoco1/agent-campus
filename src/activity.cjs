// @ts-check
const { record, string } = require('./client.cjs');

/** @typedef {{ id: string, label: string, status: string, assignment: string, update: string }} Agent */
/** @typedef {{ agentId: string, text: string, failed?: boolean, output?: string }} Activity */
/** @typedef {{ rootId: string, status: string, agents: Agent[], timeline: Activity[] }} Run */

/** @param {string} rootId @param {string} prompt @returns {Run} */
function startRun(rootId, prompt) {
  return {
    rootId, status: 'running', timeline: [],
    agents: [{ id: rootId, label: 'Lead agent', status: 'running', assignment: prompt, update: '' }]
  };
}

/** @param {Run} run @param {string} id @param {Partial<Agent>} changes @returns {Run} */
function updateAgent(run, id, changes) {
  const current = run.agents.find(agent => agent.id === id);
  const agent = {
    id, label: `Subagent ${run.agents.length}`, status: 'observed',
    assignment: '', update: '', ...current, ...changes
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

/** @param {Run} run @param {string} method @param {object} params @returns {Run} */
function reduceActivity(run, method, params) {
  if (!['turn/completed', 'item/started', 'item/completed'].includes(method)) return run;
  const event = record(params);
  const threadId = string(event.threadId);
  if (method === 'turn/completed') {
    const turn = record(event.turn);
    const status = string(turn.status);
    const next = updateAgent(run, threadId, { status });
    const detail = turn.error ? ` · ${string(record(turn.error).message)}` : '';
    return addActivity({ ...next, status: threadId === run.rootId ? status : run.status }, { agentId: threadId, text: `Turn ${status}${detail}` });
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
        next = updateAgent(next, id, {
          ...(tool === 'spawnAgent' && typeof item.prompt === 'string' ? { assignment: item.prompt } : {}),
          ...(typeof state.status === 'string' ? { status: state.status } : {}),
          ...(typeof state.message === 'string' ? { update: state.message } : {})
        });
      }
      return addActivity(next, { agentId: sender, text: `Delegation · ${tool} · ${string(item.status)}` });
    }
    case 'subAgentActivity': {
      const id = string(item.agentThreadId);
      const kind = string(item.kind);
      const changes = kind === 'interacted' ? {} : { status: kind === 'started' ? 'running' : kind };
      const next = updateAgent(run, id, changes);
      return completed ? addActivity(next, { agentId: id, text: `Subagent ${kind}` }) : next;
    }
    case 'agentMessage':
      return completed ? updateAgent(run, threadId, { update: string(item.text) }) : run;
    case 'commandExecution': {
      const status = completed ? string(item.status) : 'running';
      const failed = completed && (status === 'failed' ||
        (typeof item.exitCode === 'number' && item.exitCode !== 0));
      const output = failed && typeof item.aggregatedOutput === 'string'
        ? item.aggregatedOutput.slice(-12000) : undefined;
      return addActivity(updateAgent(run, threadId, {}), {
        agentId: threadId, text: `${failed ? 'Failed' : status} · ${string(item.command)}`, failed, output
      });
    }
    case 'fileChange':
      if (!Array.isArray(item.changes)) throw new TypeError('Codex file change item lacks changes.');
      return addActivity(updateAgent(run, threadId, {}), {
        agentId: threadId, text: `File change · ${item.changes.map(change => string(record(change).path)).join(', ')}`
      });
    default:
      return run;
  }
}

module.exports = { startRun, reduceActivity };
