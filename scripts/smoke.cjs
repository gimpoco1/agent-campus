const assert = require('node:assert/strict');
const { CodexClient } = require('../src/client.cjs');
const { startRun, reduceActivity } = require('../src/activity.cjs');

const cwd = process.cwd();
const prompt = process.argv[2];
let run;
let finish;
let fail;
const completed = new Promise((resolve, reject) => { finish = resolve; fail = reject; });
void completed.catch(() => { process.exitCode = 1; });

const client = new CodexClient(process.env.CODEX_EXECUTABLE ?? 'codex', cwd, (method, params) => {
  if (!run) return;
  const next = reduceActivity(run, method, params);
  if (next === run) return;
  run = next;
  if (run.status !== 'running') finish();
}, fail);

async function smoke() {
  const timeout = setTimeout(() => fail(new Error('Codex run exceeded the four-minute smoke-test limit.')), 240_000);
  try {
    await client.initialize();
    const threadId = await client.startThread(cwd);
    assert.ok(threadId);
    console.log('Codex initialized and created a read-only thread.');
    if (prompt) {
      run = startRun(threadId, prompt);
      await client.startTurn(threadId, prompt);
      await completed;
      assert.equal(run.status, 'completed', run.timeline.at(-1)?.text);
      assert.ok(run.agents.length >= 3, `Expected a lead and two observed subagents, saw ${run.agents.length} agents.`);
      assert.ok(run.handoffs.some(handoff => handoff.kind === 'assignment'), 'Expected an observed task assignment.');
      assert.ok(run.handoffs.some(handoff => handoff.kind === 'result'), 'Expected an observed subagent result handoff.');
      assert.ok(run.agents.some(agent => agent.id !== run.rootId && agent.result.trim()), 'Expected a recorded subagent result, not only a completion signal.');
      console.log(`Completed a live run with ${run.agents.length - 1} observed subagents.`);
    }
  } finally {
    clearTimeout(timeout);
    client.close(new Error('Smoke test finished.'));
  }
}

smoke().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
