const vscode = acquireVsCodeApi();
const ui = Object.fromEntries(
  ['recent-runs', 'copy-report', 'start-run', 'stop-run', 'title', 'status', 'metadata', 'attention', 'workspace', 'stage', 'studio', 'list', 'agents',
    'run-summary', 'summary-toggle', 'summary-content', 'handoff-status', 'workstations', 'inspector', 'campus', 'campus-map', 'markers', 'timeline', 'ticks', 'event-count', 'fit', 'minus', 'plus']
    .map(id => [id, document.getElementById(id)])
);
const compact = matchMedia('(max-width: 760px)');
const districts = [
  { color: '#303748', crop: '0% 100%', icon: '⌘' },
  { color: '#5865d8', crop: '0% 0%', icon: '◇' },
  { color: '#af4a88', crop: '100% 0%', icon: '▤' },
  { color: '#258978', crop: '100% 100%', icon: '✓' }
];

let state = { status: 'Ready', run: null };
let view = vscode.getState()?.view;
let selectedId;
let scale = 1;
let fitMode = true;
const expandedOutput = new Set();
const summaryExpansion = new Map();
const campus = createCampus(ui, id => { selectedId = id === selectedId ? undefined : id; render(); });

function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function presentation(status) {
  switch (status) {
    case 'running':
    case 'inProgress': return { text: 'Working', tone: 'working', group: 'Working' };
    case 'completed': return { text: 'Completed', tone: 'done', group: 'Completed' };
    case 'failed':
    case 'errored': return { text: 'Failed', tone: 'failed', group: 'Needs attention' };
    case 'interrupted':
    case 'shutdown': return { text: 'Stopped', tone: 'waiting', group: 'Inactive' };
    default: return { text: 'Waiting', tone: 'waiting', group: 'Waiting' };
  }
}

function badge(label, tone) {
  return element('span', label, `badge ${tone}`);
}

function head(agent) {
  const row = element('div', '', 'agent-head');
  const icon = element('span', agent.district.icon, 'agent-icon');
  icon.style.setProperty('--accent', agent.district.color);
  icon.setAttribute('aria-hidden', 'true');
  row.append(icon, element('strong', agent.label), badge(agent.display.text, agent.display.tone));
  return row;
}

function card(agent, mode) {
  const button = element('button', '', `agent-card ${mode}-card`);
  button.type = 'button';
  button.dataset.agentId = agent.id;
  button.setAttribute('aria-pressed', String(agent.id === selectedId));
  button.addEventListener('click', () => {
    selectedId = agent.id === selectedId ? undefined : agent.id;
    render();
    [...ui.agents.querySelectorAll('button')].find(node => node.dataset.agentId === agent.id)?.focus();
  });
  const copy = element('div', '', 'list-copy');
  copy.append(head(agent));
  const current = agent.currentCommand ? `Running · ${agent.currentCommand}` : agent.current?.text || agent.assignment;
  if (current) copy.append(element('p', current, 'snippet current'));
  if (agent.update) copy.append(element('p', agent.update, 'snippet'));
  if (mode === 'list') {
    const thumbnail = element('span', '', 'thumbnail');
    thumbnail.style.backgroundImage = `url("${ui.campus.src}")`;
    thumbnail.style.backgroundPosition = agent.district.crop;
    button.append(thumbnail);
  }
  button.append(copy);
  return button;
}

function section(label, content) {
  const node = element('section');
  node.append(element('h3', label, 'section-label'), content);
  return node;
}

function failureDetail(agent) {
  const failure = element('div', '', 'failure');
  failure.append(element('h3', 'Failed command', 'section-label'), element('p', agent.failure.command));
  if (agent.failure.output) {
    const output = element('details');
    output.open = expandedOutput.has(agent.id);
    output.addEventListener('toggle', () => {
      if (output.open) expandedOutput.add(agent.id);
      else expandedOutput.delete(agent.id);
    });
    output.append(element('summary', 'View command output'), element('pre', agent.failure.output));
    failure.append(output);
  }
  return failure;
}

function renderInspector(agent) {
  ui.inspector.hidden = !agent;
  if (!agent) {
    ui.inspector.replaceChildren();
    return;
  }
  const header = element('header', '', 'inspector-head');
  const close = element('button', '×', 'close');
  close.type = 'button';
  close.setAttribute('aria-label', 'Close inspector');
  close.addEventListener('click', () => {
    selectedId = undefined;
    render();
    [...ui.agents.querySelectorAll('button')].find(node => node.dataset.agentId === agent.id)?.focus();
  });
  header.append(head(agent), close);
  const body = element('div', '', 'inspector-body');
  if (agent.failure) body.append(failureDetail(agent));
  if (agent.currentCommand) body.append(section('Running command', element('pre', agent.currentCommand)));
  if (agent.result) body.append(section('Reported result', element('p', agent.result)));
  if (agent.assignment) body.append(section('Assignment', element('p', agent.assignment)));
  if (agent.progress.length) {
    const progress = element('ol', '', 'progress-stream');
    for (const update of agent.progress.slice().reverse()) {
      const entry = element('li', '', `progress-${update.kind}`);
      entry.append(element('span', update.kind === 'reasoning' ? 'Reasoning summary' : 'Reported update', 'section-label'), element('p', update.text));
      progress.append(entry);
    }
    body.append(section('Agent progress', progress));
  } else {
    body.append(section('Agent progress', element('p', 'No progress updates or reasoning summaries have been exposed for this agent yet.', 'subtle')));
  }
  if (agent.events.length) {
    const events = element('ul');
    events.append(...agent.events.slice(-8).reverse().map(event => element('li', event.text)));
    body.append(section('Recent activity', events));
  }
  ui.inspector.replaceChildren(header, body);
}

function fileAction(label, type, path) {
  const button = element('button', label, 'file-action');
  button.type = 'button';
  button.dataset.action = type;
  button.dataset.path = path;
  button.setAttribute('aria-label', `${label}: ${path}`);
  button.addEventListener('click', () => vscode.postMessage({ type, path }));
  return button;
}

function renderSummary(run, agents) {
  ui['run-summary'].hidden = !run;
  if (!run) {
    ui['summary-content'].replaceChildren();
    return;
  }
  const commands = run.commands;
  const files = run.changedFiles;
  const uniqueFiles = new Set(files.map(file => file.path));
  const completed = commands.filter(command => command.status === 'completed').length;
  const failed = commands.filter(command => command.status === 'failed' && !command.resolved).length;
  const running = commands.filter(command => command.status === 'running').length;
  const sections = [];
  const result = agents.find(agent => agent.id === run.rootId)?.result;
  if (result) {
    const details = element('details', '', 'result-summary');
    details.dataset.section = 'result';
    details.open = summaryExpansion.get('result') ?? run.status !== 'running';
    details.append(element('summary', 'Reported result'), element('p', result));
    sections.push(details);
  }
  const review = element('details', '', 'file-review');
  review.dataset.section = 'files';
  review.open = summaryExpansion.get('files') ?? files.length > 0;
  review.append(element('summary', `Changed files · ${uniqueFiles.size}`));
  if (!files.length) review.append(element('p', 'No file changes observed.', 'subtle'));
  for (const agent of agents) {
    const changes = files.filter(file => file.agentId === agent.id);
    if (!changes.length) continue;
    const group = element('section', '', 'file-group');
    group.append(element('h3', agent.label, 'section-label'));
    for (const file of changes) {
      const row = element('div', '', 'file-row');
      row.append(element('code', file.path), fileAction('Open file', 'openFile', file.path), fileAction('Review diff', 'reviewDiff', file.path));
      group.append(row);
    }
    review.append(group);
  }
  sections.push(review);
  const evidence = element('details', '', 'command-evidence');
  evidence.dataset.section = 'commands';
  evidence.open = summaryExpansion.get('commands') ?? false;
  evidence.append(element('summary', `Observed commands · ${commands.length}`));
  if (!commands.length) evidence.append(element('p', 'No command outcomes observed. Checks have not been verified here.', 'subtle'));
  for (const command of commands.slice().reverse()) {
    const entry = element('details', '', 'command-entry');
    entry.dataset.section = `command:${command.id}`;
    entry.open = summaryExpansion.get(entry.dataset.section) ?? false;
    const label = agents.find(agent => agent.id === command.agentId)?.label ?? command.agentId;
    const heading = element('summary');
    heading.append(badge(command.resolved ? 'Resolved by retry' : command.status, command.status === 'failed' && !command.resolved ? 'failed' : ''), element('code', command.command));
    entry.append(heading, element('p', `${label}${typeof command.exitCode === 'number' ? ` · Exit ${command.exitCode}` : ''}`, 'subtle'));
    if (command.output) entry.append(element('pre', command.output));
    evidence.append(entry);
  }
  sections.push(evidence);
  ui['summary-toggle'].textContent = `${run.status === 'running' ? 'Run overview' : 'Run summary'} · ${uniqueFiles.size} changed ${uniqueFiles.size === 1 ? 'file' : 'files'} · ${completed} ${completed === 1 ? 'command' : 'commands'} succeeded${failed ? ` · ${failed} unresolved ${failed === 1 ? 'failure' : 'failures'}` : ''}${running ? ` · ${running} running` : ''}`;
  ui['summary-content'].replaceChildren(...sections);
}

function render() {
  const mode = view ?? 'studio';
  ui.workspace.classList.toggle('list', mode === 'list');
  ui.studio.setAttribute('aria-pressed', String(mode === 'studio'));
  ui.list.setAttribute('aria-pressed', String(mode === 'list'));
  const run = state.run;
  ui['recent-runs'].replaceChildren(new Option('Follow latest run', ''), ...(state.recentRuns ?? []).map(entry =>
    new Option(`${entry.status} · ${entry.label}`, entry.id)));
  ui['recent-runs'].value = state.selectedRunId ?? '';
  ui['copy-report'].disabled = !run;
  ui['start-run'].disabled = Boolean(state.canStop);
  ui['stop-run'].hidden = !state.canStop;
  const events = run?.timeline ?? [];
  const agents = (run?.agents ?? []).map((agent, index) => {
    const activity = events.filter(event => event.agentId === agent.id);
    const failure = run.commands.findLast(command => command.agentId === agent.id && command.status === 'failed' && !command.resolved);
    const display = presentation(agent.status);
    return {
      ...agent, events: activity, current: activity.at(-1), failure,
      display: failure
        ? { text: 'Unresolved failure', tone: 'failed', group: 'Needs attention' } : display,
      district: districts[index === 0 ? 0 : (index - 1) % 3 + 1]
    };
  });
  const attention = agents.filter(agent => agent.display.tone === 'failed');
  const title = agents[0]?.assignment.split('\n').find(line => line.trim())?.trim();
  ui.title.textContent = title || 'Agent Campus';
  ui.title.title = title || '';
  const status = presentation(run?.status);
  const live = run?.status === 'running' && ['running', 'Codex chat · running'].includes(state.status);
  const stopped = run?.status === 'running' && !live;
  ui.status.className = `badge ${stopped ? 'waiting' : status.tone}`;
  ui.status.textContent = live ? 'Live' : stopped ? 'Stopped' : run ? status.text : state.status;
  ui.metadata.textContent = run
    ? `${agents.length} ${agents.length === 1 ? 'agent' : 'agents'}${stopped ? ` · ${state.status}` : ''}`
    : 'Send a message in Codex to start.';
  ui.attention.hidden = attention.length === 0;
  ui.attention.textContent = `${attention.length} ${attention.length === 1 ? 'needs' : 'need'} attention →`;
  ui.attention.onclick = () => { selectedId = attention[0]?.id; render(); };

  renderSummary(run, agents);
  const focusedId = document.activeElement?.dataset.agentId;
  campus.render(run, agents, selectedId);
  if (fitMode && mode === 'studio') fitCampus();
  if (!agents.length) {
    ui.agents.replaceChildren(element('p', 'Waiting for a Codex turn in this workspace.', 'empty'));
  } else if (mode === 'studio') {
    ui.agents.replaceChildren();
  } else {
    const groups = ['Needs attention', 'Working', 'Waiting', 'Completed', 'Inactive'];
    ui.agents.replaceChildren(...groups.flatMap(label => {
      const members = agents.filter(agent => agent.display.group === label);
      if (!members.length) return [];
      const group = element('section', '', 'list-group');
      group.append(element('h2', `${label}  ${members.length}`, 'group-label'));
      for (const agent of members) {
        const row = element('div', '', 'list-row');
        row.append(card(agent, mode));
        if (agent.id === selectedId && agent.failure) row.append(failureDetail(agent));
        group.append(row);
      }
      return [group];
    }));
  }
  if (focusedId) [...ui.agents.querySelectorAll('button')].find(node => node.dataset.agentId === focusedId)?.focus();
  renderInspector(agents.find(agent => agent.id === selectedId));
  ui['event-count'].textContent = `${events.length} ${events.length === 1 ? 'event' : 'events'}`;
  ui.ticks.replaceChildren(...events.slice(-24).map(event => element('i', '', event.failed ? 'failed' : '')));
  ui.timeline.replaceChildren(...events.map(event => {
    const label = agents.find(agent => agent.id === event.agentId)?.label ?? event.agentId;
    return element('li', `${label} · ${event.text}`);
  }));
}

function selectView(next) {
  view = next;
  vscode.setState({ view });
  render();
}

function zoom(next) {
  scale = Math.max(.2, Math.min(2, next));
  ui['campus-map'].style.zoom = String(scale);
  ui['campus-map'].parentElement.style.setProperty('--campus-scale', String(scale));
  ui.minus.disabled = scale <= .2;
  ui.plus.disabled = scale >= 2;
}

function fitCampus() {
  fitMode = true;
  const width = ui.stage.clientWidth - 20;
  const height = ui.stage.clientHeight - ui['handoff-status'].offsetHeight - 76;
  zoom(Math.min(1, width / ui['campus-map'].offsetWidth, Math.max(100, height) / ui['campus-map'].offsetHeight));
}

ui['run-summary'].addEventListener('toggle', event => {
  if (event.target === ui['run-summary'] && fitMode && view !== 'list') fitCampus();
  if (event.target.isConnected && event.target.dataset.section) summaryExpansion.set(event.target.dataset.section, event.target.open);
}, true);
ui['recent-runs'].addEventListener('change', () => vscode.postMessage({ type: 'selectRun', id: ui['recent-runs'].value }));
ui['start-run'].addEventListener('click', () => vscode.postMessage({ type: 'start' }));
ui['stop-run'].addEventListener('click', () => vscode.postMessage({ type: 'stop' }));
ui['copy-report'].addEventListener('click', () => vscode.postMessage({ type: 'copyReport' }));
ui.studio.addEventListener('click', () => selectView('studio'));
ui.list.addEventListener('click', () => selectView('list'));
ui.fit.addEventListener('click', fitCampus);
ui.minus.addEventListener('click', () => { fitMode = false; zoom(scale - .15); });
ui.plus.addEventListener('click', () => { fitMode = false; zoom(scale + .15); });
compact.addEventListener('change', render);
window.addEventListener('resize', () => { if (fitMode && view !== 'list') fitCampus(); });
window.addEventListener('message', ({ data }) => {
  if (state.run?.rootId !== data.run?.rootId || state.run?.turnId !== data.run?.turnId) {
    selectedId = undefined;
    summaryExpansion.clear();
    expandedOutput.clear();
    ui['run-summary'].open = false;
    campus.reset();
  }
  state = data;
  render();
});
zoom(1);
render();
vscode.postMessage('ready');
