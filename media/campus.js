function createCampus(elements, selectAgent) {
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  const stations = [
    { x: 29, y: 81, roadX: 43, roadY: 74 },
    { x: 34, y: 46, roadX: 44, roadY: 54 },
    { x: 68, y: 46, roadX: 61, roadY: 54 },
    { x: 73, y: 81, roadX: 62, roadY: 74 },
    { x: 16, y: 38, roadX: 33, roadY: 51 },
    { x: 85, y: 38, roadX: 70, roadY: 53 },
    { x: 60, y: 88, roadX: 56, roadY: 78 },
    { x: 45, y: 33, roadX: 50, roadY: 45 },
    { x: 88, y: 88, roadX: 73, roadY: 78 }
  ];
  let people = [];
  let handoffs = [];
  let seen = new Set();
  let queue = [];
  let active;
  let motion;
  let generation = 0;

  function stationAt(index) {
    if (index < stations.length) return stations[index];
    const annexIndex = index - stations.length;
    return { x: 14 + annexIndex % 4 * 24, y: 110 + Math.floor(annexIndex / 4) * 21, roadX: 52, roadY: 98 };
  }

  function locate(id) {
    return stationAt(people.findIndex(agent => agent.id === id));
  }

  function robotFor(id) {
    return [...elements.markers.children].find(node => node.dataset.markerId === id);
  }

  function workstationFor(id) {
    return [...elements.workstations.children].find(node => node.dataset.stationId === id);
  }

  function placeRobot(robot, point) {
    robot.style.left = `${point.x}%`;
    robot.style.top = `${point.y}%`;
  }

  function createRobot(id) {
    const button = element('button', '', 'map-marker');
    button.type = 'button';
    button.dataset.markerId = id;
    const robot = element('span', '', 'robot');
    robot.setAttribute('aria-hidden', 'true');
    for (const part of ['shadow', 'antenna', 'head', 'body', 'arm left', 'arm right', 'foot left', 'foot right', 'console', 'packet']) {
      robot.append(element('span', '', `robot-${part}`));
    }
    button.append(robot);
    button.addEventListener('click', () => selectAgent(id));
    button.addEventListener('focus', () => button.scrollIntoView({ block: 'nearest', inline: 'nearest' }));
    return button;
  }

  function createStation(id) {
    const button = element('button', '', 'workstation');
    button.type = 'button';
    button.dataset.stationId = id;
    button.addEventListener('click', () => selectAgent(id));
    button.addEventListener('focus', () => button.scrollIntoView({ block: 'nearest', inline: 'nearest' }));
    return button;
  }

  function describeHandoff(handoff) {
    const parentId = handoff.kind === 'assignment' ? handoff.fromId : handoff.toId;
    const childId = handoff.kind === 'assignment' ? handoff.toId : handoff.fromId;
    const parent = people.find(agent => agent.id === parentId);
    const child = people.find(agent => agent.id === childId);
    return { parent, child };
  }

  function renderBanner() {
    const handoff = active ?? handoffs.at(-1);
    if (!handoff) {
      elements['handoff-status'].replaceChildren(element('span', people.length ? 'Agents work at their stations. Select one to follow its progress.' : 'Waiting for a Codex turn.', 'campus-guidance'));
      return;
    }
    const { parent, child } = describeHandoff(handoff);
    if (!parent || !child) return;
    const text = active
      ? handoff.kind === 'assignment' ? `${parent.label} → assigning ${child.label}` : `${parent.label} ← collecting ${child.label}’s reported result`
      : handoff.kind === 'assignment' ? `${parent.label} assigned ${child.label}` : `Result reported · ${child.label} → ${parent.label}`;
    const label = element('span', text, 'handoff-copy');
    const count = element('span', queue.length ? `${queue.length} queued` : 'Observed handoff', 'subtle');
    elements['handoff-status'].replaceChildren(element('span', handoff.kind === 'assignment' ? '↗' : '▤', 'handoff-icon'), label, count);
    elements['handoff-status'].title = handoff.text;
    elements['handoff-status'].dataset.handoffId = handoff.id;
    elements['handoff-status'].dataset.phase = active ? 'travelling' : 'idle';
  }

  function route(from, to) {
    const arrival = { x: to.x - 6, y: to.y + 2 };
    return [from, { x: from.roadX, y: from.roadY }, { x: 52, y: 62 }, { x: to.roadX, y: to.roadY }, arrival];
  }

  async function travel(robot, points, duration) {
    const animation = robot.animate(points.map(point => ({ left: `${point.x}%`, top: `${point.y}%` })), { duration, easing: 'linear', fill: 'forwards' });
    motion = animation;
    await animation.finished;
    placeRobot(robot, points.at(-1));
    animation.cancel();
    if (motion === animation) motion = undefined;
  }

  async function performHandoff(handoff, token) {
    const { parent, child } = describeHandoff(handoff);
    const robot = robotFor(parent.id);
    const station = workstationFor(child.id);
    const home = locate(parent.id);
    const target = locate(child.id);
    const path = route(home, target);
    robot.dataset.travelId = handoff.id;
    robot.classList.add('travelling');
    station.dataset.handoff = handoff.kind;
    if (handoff.kind === 'assignment') robot.classList.add('carrying-packet');
    renderBanner();
    try {
      const duration = reducedMotion.matches ? 1 : 1700;
      await travel(robot, path, duration);
      if (token !== generation) return;
      elements['handoff-status'].dataset.phase = 'handoff';
      robot.classList.toggle('carrying-packet', handoff.kind === 'result');
      station.classList.add('handoff-received');
      await travel(robot, [path.at(-1), path.at(-1)], reducedMotion.matches ? 1 : 650);
      if (token !== generation) return;
      elements['handoff-status'].dataset.phase = 'returning';
      await travel(robot, path.slice().reverse(), duration);
    } catch (error) {
      if (token !== generation && error.name === 'AbortError') return;
      throw error;
    } finally {
      if (token === generation) {
        robot.classList.remove('travelling', 'carrying-packet');
        delete robot.dataset.travelId;
        delete station.dataset.handoff;
        station.classList.remove('handoff-received');
        placeRobot(robot, home);
      }
    }
  }

  function playNext() {
    if (active || !queue.length) {
      renderBanner();
      return;
    }
    const handoff = queue[0];
    const { parent, child } = describeHandoff(handoff);
    if (!parent || !child) throw new Error(`Cannot animate handoff ${handoff.id}: parent or child is missing.`);
    queue = queue.slice(1);
    active = handoff;
    const token = generation;
    void performHandoff(handoff, token).then(() => {
      if (token !== generation) return;
      active = undefined;
      playNext();
    }).catch(error => {
      if (token !== generation) return;
      active = undefined;
      elements['handoff-status'].textContent = `Campus animation failed: ${error.message}`;
      throw error;
    });
  }

  function render(run, agents, selectedId) {
    people = agents;
    handoffs = run?.handoffs ?? [];
    const annexRows = Math.ceil(Math.max(0, agents.length - stations.length) / 4);
    elements['campus-map'].style.setProperty('--annex-top', `${300 / (3 + annexRows * .63)}%`);
    elements['campus-map'].style.setProperty('--board-ratio', `4 / ${3 + annexRows * .63}`);
    elements['campus-map'].parentElement.style.setProperty('--board-min', agents.length > 4 ? '1080px' : '800px');
    elements['campus-map'].classList.toggle('has-annex', annexRows > 0);
    const oldRobots = new Map([...elements.markers.children].map(node => [node.dataset.markerId, node]));
    const oldStations = new Map([...elements.workstations.children].map(node => [node.dataset.stationId, node]));
    agents.forEach((agent, index) => {
      const location = stationAt(index);
      const robot = oldRobots.get(agent.id) ?? createRobot(agent.id);
      const station = oldStations.get(agent.id) ?? createStation(agent.id);
      oldRobots.delete(agent.id);
      oldStations.delete(agent.id);
      robot.style.setProperty('--accent', agent.district.color);
      robot.classList.toggle('working', agent.display.tone === 'working');
      robot.classList.toggle('failed', agent.display.tone === 'failed');
      robot.setAttribute('aria-label', `Inspect ${agent.label}`);
      robot.setAttribute('aria-pressed', String(agent.id === selectedId));
      robot.title = agent.currentCommand || agent.update || agent.display.text;
      if (!robot.dataset.travelId) placeRobot(robot, location);
      station.style.left = `${location.x}%`;
      station.style.top = `${location.y}%`;
      station.style.setProperty('--accent', agent.district.color);
      station.setAttribute('aria-pressed', String(agent.id === selectedId));
      station.classList.toggle('failed', agent.display.tone === 'failed');
      const name = element('span', agent.label, 'station-name');
      const task = agent.assignment || (agent.status === 'running' ? 'Task details unavailable' : 'No task details exposed');
      const hasResult = agent.status === 'completed' && handoffs.some(handoff => handoff.kind === 'result' && handoff.fromId === agent.id);
      station.replaceChildren(element('span', index === 0 ? '⌘ Lead station' : '▤ Workstation', 'station-type'), name,
        element('span', task, 'station-task'), badge(hasResult ? 'Result reported' : agent.display.text, agent.display.tone));
      station.title = `${agent.label}\n${task}\n${agent.currentCommand || agent.update}`;
      if (!station.isConnected) elements.workstations.append(station);
      if (!robot.isConnected) elements.markers.append(robot);
    });
    for (const robot of oldRobots.values()) robot.remove();
    for (const station of oldStations.values()) station.remove();
    for (const handoff of handoffs) {
      if (seen.has(handoff.id)) continue;
      seen.add(handoff.id);
      queue = [...queue, handoff];
    }
    playNext();
  }

  function reset() {
    generation += 1;
    motion?.cancel();
    motion = undefined;
    active = undefined;
    seen = new Set();
    queue = [];
    handoffs = [];
    people = [];
    elements.markers.replaceChildren();
    elements.workstations.replaceChildren();
    delete elements['handoff-status'].dataset.handoffId;
    delete elements['handoff-status'].dataset.phase;
  }

  return { render, reset };
}
