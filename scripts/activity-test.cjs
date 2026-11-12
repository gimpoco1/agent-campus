const assert = require('node:assert/strict');
const { startRun, reduceActivity } = require('../src/activity.cjs');

function item(run, method, value) {
  return reduceActivity(run, method, { threadId: 'lead', item: value });
}

const initial = startRun('lead', 'Implement the feature');
const started = item(initial, 'item/started', { type: 'commandExecution', id: 'test-1', command: 'npm test' });
assert.equal(started.agents[0].currentCommand, 'npm test');
assert.equal(initial.commands.length, 0);
const failed = item(started, 'item/completed', {
  type: 'commandExecution', id: 'test-1', command: 'npm test', status: 'completed', exitCode: 1, aggregatedOutput: 'Assertion failed'
});
assert.equal(failed.commands.length, 1);
assert.equal(failed.commands[0].status, 'failed');
assert.equal(failed.commands[0].output, 'Assertion failed');
assert.equal(failed.agents[0].currentCommand, '');
const unrelated = item(failed, 'item/completed', {
  type: 'commandExecution', id: 'lint-1', command: 'npm run lint', status: 'completed', exitCode: 0
});
assert.equal(unrelated.commands[0].resolved, false);
const retried = item(unrelated, 'item/completed', {
  type: 'commandExecution', id: 'test-2', command: 'npm test', status: 'completed', exitCode: 0, aggregatedOutput: 'All tests passed'
});
assert.equal(retried.commands[0].resolved, true);
assert.equal(failed.commands[0].resolved, false);
const changed = item(retried, 'item/completed', {
  type: 'fileChange', changes: [{ path: 'src/feature.js' }, { path: 'src/feature.js' }], status: 'completed'
});
const repeated = item(changed, 'item/completed', {
  type: 'fileChange', changes: [{ path: 'src/feature.js' }], status: 'completed'
});
assert.deepEqual(repeated.changedFiles, [{ agentId: 'lead', path: 'src/feature.js' }]);
const final = item(repeated, 'item/completed', { type: 'agentMessage', text: 'Feature ready', phase: 'final_answer' });
const commentary = item(final, 'item/completed', { type: 'agentMessage', text: 'More detail', phase: 'commentary' });
assert.equal(commentary.agents[0].result, 'Feature ready');
const finished = reduceActivity(commentary, 'turn/completed', { threadId: 'lead', turn: { status: 'completed' } });
assert.equal(finished.status, 'completed');
assert.equal(finished.commands.at(-1).output, 'All tests passed');
console.log('Activity replay preserves file evidence, command retries, and final results.');

function collaboration(run, id, sender, receiver, prompt, state) {
  return reduceActivity(run, 'item/completed', { threadId: sender, item: {
    type: 'collabAgentToolCall', id, tool: 'spawnAgent', senderThreadId: sender,
    receiverThreadIds: [receiver], prompt, status: 'completed', agentsStates: { [receiver]: state }
  } });
}
const delegated = collaboration(initial, 'spawn-1', 'lead', 'child', 'Inspect feature', { status: 'running' });
const nested = collaboration(delegated, 'spawn-2', 'child', 'grandchild', 'Inspect checks', { status: 'running' });
assert.equal(nested.agents.find(agent => agent.id === 'grandchild').parentId, 'child');
assert.equal(nested.handoffs.length, 2);
const summary = reduceActivity(nested, 'item/completed', { threadId: 'grandchild', item: {
  type: 'reasoning', summary: ['Checking the existing tests', { text: 'The integration covers the main path' }],
  content: [{ text: 'Never expose this raw reasoning' }]
} });
assert.deepEqual(summary.agents.find(agent => agent.id === 'grandchild').progress, [{
  kind: 'reasoning', text: 'Checking the existing tests\nThe integration covers the main path'
}]);
const result = reduceActivity(summary, 'item/completed', { threadId: 'grandchild', item: {
  type: 'agentMessage', text: 'Checks pass', phase: 'final_answer'
} });
const collected = reduceActivity(result, 'turn/completed', { threadId: 'grandchild', turn: { status: 'completed' } });
assert.deepEqual(collected.handoffs.at(-1), {
  id: 'result:grandchild:assignment:spawn-2:grandchild', fromId: 'grandchild', toId: 'child', kind: 'result', text: 'Checks pass'
});
const duplicate = reduceActivity(collected, 'turn/completed', { threadId: 'grandchild', turn: { status: 'completed' } });
assert.equal(duplicate.handoffs.length, collected.handoffs.length);
const resumed = collaboration(duplicate, 'spawn-3', 'child', 'grandchild', 'Inspect another check', { status: 'running' });
assert.equal(resumed.agents.find(agent => agent.id === 'grandchild').result, '');
const returned = collaboration(resumed, 'spawn-3', 'child', 'grandchild', 'Inspect another check', { status: 'completed', message: 'Second check passes' });
assert.equal(returned.handoffs.filter(handoff => handoff.kind === 'result').length, 2);
assert.equal(returned.handoffs.at(-1).text, 'Second check passes');
assert.equal(nested.handoffs.length, 2);
console.log('Delegation replay preserves parent links, safe summaries, and deduplicated result handoffs across resumed work.');
const followup = reduceActivity(returned, 'item/completed', { threadId: 'child', item: {
  type: 'collabAgentToolCall', id: 'followup-1', tool: 'sendInput', senderThreadId: 'child',
  receiverThreadIds: ['grandchild'], prompt: 'Check one more path', status: 'completed',
  agentsStates: { grandchild: { status: 'completed', message: 'Second check passes' } }
} });
assert.equal(followup.agents.find(agent => agent.id === 'grandchild').result, '');
assert.equal(followup.agents.find(agent => agent.id === 'grandchild').status, 'running');
assert.equal(followup.handoffs.filter(handoff => handoff.kind === 'result').length, 2);
const explicitParent = reduceActivity(startRun('lead', ''), 'item/completed', { threadId: 'grandchild', item: {
  type: 'subAgentActivity', agentThreadId: 'grandchild', parentThreadId: 'child', kind: 'started'
} });
assert.equal(explicitParent.agents.find(agent => agent.id === 'grandchild').parentId, 'child');
const observedThread = reduceActivity(initial, 'thread/started', { thread: {
  id: 'child', parentThreadId: 'lead', preview: 'Inspect feature', agentNickname: 'Scout'
} });
assert.equal(observedThread.agents.find(agent => agent.id === 'child').label, 'Scout');
assert.equal(observedThread.handoffs.length, 0);
const observedTask = reduceActivity(observedThread, 'item/completed', { threadId: 'child', item: {
  type: 'userMessage', id: 'child-task', content: [{ type: 'text', text: 'Inspect feature' }]
} });
assert.equal(observedTask.handoffs.length, 1);
assert.equal(reduceActivity(initial, 'thread/started', { thread: {
  id: 'other', parentThreadId: 'unrelated', preview: 'Other task'
} }), initial);
const visibleStart = reduceActivity(initial, 'item/completed', { threadId: 'lead', item: {
  type: 'subAgentActivity', id: 'observed-spawn', agentThreadId: 'child', kind: 'started'
} });
assert.equal(visibleStart.handoffs[0].text, 'Task details are not exposed by Codex.');
const enrichedStart = reduceActivity(visibleStart, 'item/completed', { threadId: 'child', item: {
  type: 'agentAssignment', text: 'Actual observed task', parentThreadId: 'lead'
} });
assert.equal(enrichedStart.handoffs.length, 1);
assert.equal(enrichedStart.handoffs[0].id, visibleStart.handoffs[0].id);
assert.equal(enrichedStart.handoffs[0].text, 'Actual observed task');
const hydratedResult = reduceActivity(visibleStart, 'item/completed', { threadId: 'child', item: {
  type: 'agentMessage', text: 'Finished task', phase: 'final_answer'
} });
const hydratedComplete = reduceActivity(hydratedResult, 'turn/completed', { threadId: 'child', turn: { status: 'completed' } });
const replayedStart = reduceActivity(hydratedComplete, 'item/completed', { threadId: 'lead', item: {
  type: 'subAgentActivity', id: 'observed-spawn', agentThreadId: 'child', kind: 'started'
} });
assert.equal(replayedStart.agents.find(agent => agent.id === 'child').status, 'completed');
assert.equal(replayedStart.handoffs.length, 2);
const hydratedMetadata = reduceActivity(initial, 'item/completed', { threadId: 'lead', item: {
  type: 'subAgentActivity', agentThreadId: 'child', parentThreadId: 'lead', agentNickname: 'Scout', kind: 'interacted'
} });
const beforeStartMessage = reduceActivity(hydratedMetadata, 'item/completed', { threadId: 'child', item: {
  type: 'agentMessage', text: 'Hydrated completed result', phase: 'final_answer'
} });
const beforeStartComplete = reduceActivity(beforeStartMessage, 'turn/completed', { threadId: 'child', turn: { status: 'completed' } });
const lateStart = reduceActivity(beforeStartComplete, 'item/completed', { threadId: 'lead', item: {
  type: 'subAgentActivity', id: 'late-start', agentThreadId: 'child', kind: 'started'
} });
assert.equal(lateStart.agents.find(agent => agent.id === 'child').status, 'completed');
assert.equal(lateStart.handoffs.filter(handoff => handoff.kind === 'result').length, 1);
assert.equal(lateStart.handoffs.filter(handoff => handoff.kind === 'assignment').length, 1);
