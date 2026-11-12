const vscode = acquireVsCodeApi();
const ui = Object.fromEntries(
  ['title', 'status', 'metadata', 'attention', 'workspace', 'studio', 'list', 'agents',
    'inspector', 'campus', 'campus-map', 'markers', 'timeline', 'ticks', 'event-count', 'fit', 'minus', 'plus']
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
const expandedOutput = new Set();

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
  const current = agent.current?.text || agent.assignment;
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
  failure.append(element('h3', 'Failed command', 'section-label'), element('p', agent.failure.text));
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
  if (agent.assignment) body.append(section('Assignment', element('p', agent.assignment)));
  if (agent.update) body.append(section('Latest reported update', element('p', agent.update)));
  if (agent.events.length) {
    const events = element('ul');
    events.append(...agent.events.slice(-8).reverse().map(event => element('li', event.text)));
    body.append(section('Recent activity', events));
  }
  ui.inspector.replaceChildren(header, body);
}

function marker(agent, index) {
  const positions = [[24, 71], [27, 42], [73, 40], [73, 73]];
  const [x, y] = positions[index % positions.length];
  const row = Math.floor(index / positions.length);
  const button = element('button', '', `map-marker ${agent.display.tone}`);
  button.type = 'button';
  button.dataset.markerId = agent.id;
  button.style.left = `${x + (row % 3) * 6}%`;
  button.style.top = `${y + Math.min(row, 4) * 4}%`;
  button.style.setProperty('--accent', agent.district.color);
  button.setAttribute('aria-pressed', String(agent.id === selectedId));
  button.title = agent.current?.text || agent.update || agent.display.text;
  button.append(element('span', agent.district.icon, 'marker-pin'),
    element('span', `${agent.label} · ${agent.display.text}`, 'marker-label'));
  button.addEventListener('click', () => {
    selectedId = agent.id === selectedId ? undefined : agent.id;
    render();
  });
  return button;
}

function render() {
  const mode = view ?? (compact.matches ? 'list' : 'studio');
  ui.workspace.classList.toggle('list', mode === 'list');
  ui.studio.setAttribute('aria-pressed', String(mode === 'studio'));
  ui.list.setAttribute('aria-pressed', String(mode === 'list'));
  const run = state.run;
  const events = run?.timeline ?? [];
  const agents = (run?.agents ?? []).map((agent, index) => {
    const activity = events.filter(event => event.agentId === agent.id);
    const failure = activity.findLast(event => event.failed);
    const display = presentation(agent.status);
    return {
      ...agent, events: activity, current: activity.at(-1), failure,
      display: failure && display.tone === 'working'
        ? { text: 'Command failed', tone: 'failed', group: 'Needs attention' } : display,
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
  ui.attention.textContent = `${attention.length} need attention →`;
  ui.attention.onclick = () => { selectedId = attention[0]?.id; render(); };

  const focusedId = document.activeElement?.dataset.agentId;
  const focusedMarker = document.activeElement?.dataset.markerId;
  ui.markers.replaceChildren(...(mode === 'studio' ? agents.map(marker) : []));
  if (focusedMarker) [...ui.markers.children].find(node => node.dataset.markerId === focusedMarker)?.focus();
  if (!agents.length) {
    ui.agents.replaceChildren(element('p', 'Waiting for a Codex turn in this workspace.', 'empty'));
  } else if (mode === 'studio') {
    const ordered = agents.length >= 3 ? [...agents.slice(1, 3), agents[0], ...agents.slice(3)] : agents;
    ui.agents.replaceChildren(...ordered.map(agent => card(agent, mode)));
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
  renderInspector(agents.find(agent => agent.id === selectedId && (mode === 'studio' || !agent.failure)));
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
  scale = Math.max(1, Math.min(2, next));
  ui['campus-map'].style.transform = `scale(${scale})`;
  ui.minus.disabled = scale === 1;
  ui.plus.disabled = scale === 2;
}

ui.studio.addEventListener('click', () => selectView('studio'));
ui.list.addEventListener('click', () => selectView('list'));
ui.fit.addEventListener('click', () => zoom(1));
ui.minus.addEventListener('click', () => zoom(scale - .25));
ui.plus.addEventListener('click', () => zoom(scale + .25));
compact.addEventListener('change', render);
window.addEventListener('message', ({ data }) => {
  if (state.run?.rootId !== data.run?.rootId) selectedId = undefined;
  state = data;
  render();
});
zoom(1);
render();
vscode.postMessage('ready');
