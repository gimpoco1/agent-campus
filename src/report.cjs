// @ts-check

/** @param {import('./activity.cjs').Run} run @returns {string} */
function formatReport(run) {
  const lines = ['# Agent Campus run', '', `Status: ${run.status}`, `Workspace: ${run.workspacePath ?? 'Not recorded'}`];
  for (const agent of run.agents) {
    lines.push('', `## ${agent.label}`, '', `Status: ${agent.status}`, '', agent.assignment);
    if (agent.result) lines.push('', '### Reported result', '', agent.result);
    else if (agent.update) lines.push('', '### Latest update', '', agent.update);
  }
  lines.push('', '## Changed files', '', 'Review compares HEAD with the working tree, including existing local edits.');
  for (const file of run.changedFiles) {
    const agent = run.agents.find(entry => entry.id === file.agentId);
    lines.push(`- ${file.path} (${agent?.label ?? file.agentId})`);
  }
  if (!run.changedFiles.length) lines.push('', 'No file changes observed.');
  lines.push('', '## Observed commands');
  for (const command of run.commands) {
    lines.push('', `- ${command.command}: ${command.status}${command.resolved ? ' (resolved by retry)' : ''}${typeof command.exitCode === 'number' ? `; exit ${command.exitCode}` : ''}`);
    if (command.output) lines.push('', command.output);
  }
  if (!run.commands.length) lines.push('', 'No command outcomes observed. Checks have not been verified here.');
  return lines.join('\n');
}

module.exports = { formatReport };
