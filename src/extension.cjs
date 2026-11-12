const vscode = require('vscode');
const { readFileSync } = require('node:fs');
const { resolve, relative, isAbsolute, sep } = require('node:path');
const { CodexClient } = require('./client.cjs');
const { startRun, reduceActivity } = require('./activity.cjs');
const { formatReport } = require('./report.cjs');
const { observeIdeSessions } = require('./ide-sessions.cjs');

/** @param {import('vscode').ExtensionContext} context */
function activate(context) {
  let panel;
  let client;
  let state = { status: 'Ready', run: null };
  const recentRuns = new Map();
  let selectedRunId;
  const revisions = new Map();
  let revisionId = 0;
  context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider('agent-campus-review', {
    provideTextDocumentContent: uri => {
      if (!revisions.has(uri.toString())) throw new Error(`Review content is no longer available: ${uri.path}`);
      return revisions.get(uri.toString());
    }
  }));

  async function copyReport() {
    const run = selectedRunId ? recentRuns.get(selectedRunId)?.run : state.run;
    if (!run) throw new Error('Select an observed run before copying a report.');
    await vscode.env.clipboard.writeText(formatReport(run));
    void vscode.window.showInformationMessage('Agent Campus report copied to clipboard.');
  }

  async function reviewFile(message) {
    if (!message || !['openFile', 'reviewDiff'].includes(message.type) || typeof message.path !== 'string') {
      throw new TypeError('File review requires an action and an observed file path.');
    }
    const run = selectedRunId ? recentRuns.get(selectedRunId)?.run : state.run;
    if (!run?.workspacePath || !run.changedFiles.some(file => file.path === message.path)) {
      throw new Error(`Cannot review a file outside the observed run: ${message.path}`);
    }
    const root = resolve(run.workspacePath);
    const path = resolve(root, message.path);
    const local = relative(root, path);
    if (local === '..' || local.startsWith(`..${sep}`) || isAbsolute(local)) {
      throw new Error(`Observed file is outside the run workspace: ${message.path}`);
    }
    const uri = vscode.Uri.file(path);
    if (message.type === 'openFile') {
      await vscode.window.showTextDocument(uri, { preview: true });
      return;
    }
    const git = vscode.extensions.getExtension('vscode.git');
    if (!git) throw new Error('Enable the built-in Git extension to review file differences.');
    const api = (await git.activate()).getAPI(1);
    const repository = api.getRepository(uri);
    if (!repository) throw new Error(`No Git repository found for ${path}.`);
    const repoPath = relative(repository.rootUri.fsPath, path).split(sep).join('/');
    // An added file has no HEAD revision; its review starts with an empty document.
    const object = await repository.getObjectDetails('HEAD', repoPath).catch(error => {
      if (error.gitErrorCode === 'UnknownPath') return null;
      throw error;
    });
    const content = object ? await repository.show('HEAD', repoPath) : '';
    const before = vscode.Uri.from({ scheme: 'agent-campus-review', path: `/${++revisionId}/${repoPath}` });
    revisions.set(before.toString(), content);
    const exists = await vscode.workspace.fs.stat(uri).then(() => true, error => {
      if (error.code === 'FileNotFound') return false;
      throw error;
    });
    const after = exists ? uri : vscode.Uri.from({ scheme: 'agent-campus-review', path: `/${++revisionId}/${repoPath}` });
    if (!exists) revisions.set(after.toString(), '');
    await vscode.commands.executeCommand('vscode.diff', before, after, `${repoPath} · HEAD ↔ working tree`);
  }

  function sendState() {
    const selected = selectedRunId ? recentRuns.get(selectedRunId) : state;
    if (panel) void panel.webview.postMessage({
      ...selected,
      recentRuns: [...recentRuns].reverse().map(([id, entry]) => ({
        id, label: entry.run.agents[0].assignment.split('\n').find(line => line.trim()) || 'Codex run',
        status: entry.run.status
      })),
      selectedRunId: selectedRunId ?? '',
      canStop: Boolean(client)
    });
  }

  function publish(next) {
    state = next;
    if (next.run) {
      const id = JSON.stringify([next.run.rootId, next.run.turnId ?? '']);
      recentRuns.set(id, next);
      if (recentRuns.size > 20) {
        const oldest = recentRuns.keys().next().value;
        recentRuns.delete(oldest);
        if (selectedRunId === oldest) selectedRunId = undefined;
      }
    }
    sendState();
  }

  function stop() {
    if (!client) return;
    client.close(new Error('Run stopped by the user.'));
    client = undefined;
    publish({ ...state, status: 'Stopped' });
  }

  function showPanel(preserveFocus) {
    if (panel) {
      panel.reveal(panel.viewColumn, preserveFocus);
      return;
    }
    const media = vscode.Uri.joinPath(context.extensionUri, 'media');
    panel = vscode.window.createWebviewPanel('agentWorkspace', 'Agent Campus', { viewColumn: vscode.ViewColumn.Beside, preserveFocus }, {
      enableScripts: true, localResourceRoots: [media]
    });
    const uri = name => panel.webview.asWebviewUri(vscode.Uri.joinPath(media, name)).toString();
    const source = panel.webview.cspSource;
    const resources = {
      csp: `default-src 'none'; script-src ${source}; style-src ${source} 'unsafe-inline'; img-src ${source}`,
      style: uri('panel.css'), script: uri('panel.js'), campusScript: uri('campus.js'), art: uri('campus.jpg')
    };
    const template = readFileSync(vscode.Uri.joinPath(media, 'panel.html').fsPath, 'utf8');
    panel.webview.html = template.replace(/{{(\w+)}}/g, (_token, key) => resources[key]);
    panel.webview.onDidReceiveMessage(message => {
      if (message === 'ready') sendState();
      else if (message?.type === 'copyReport') void copyReport().catch(error => vscode.window.showErrorMessage(`Agent Campus report failed: ${error.message}`));
      else if (message?.type === 'start') void start();
      else if (message?.type === 'stop') stop();
      else if (message?.type === 'selectRun') {
        if (message.id === '' || recentRuns.has(message.id)) {
          selectedRunId = message.id || undefined;
          sendState();
        }
      }
      else void reviewFile(message).catch(error => vscode.window.showErrorMessage(`Agent Campus file review failed: ${error.message}`));
    });
    panel.onDidDispose(() => { panel = undefined; });
  }

  async function start() {
    if (client) {
      showPanel(false);
      return;
    }
    const folders = vscode.workspace.workspaceFolders ?? [];
    const folder = folders.length === 1 ? folders[0] : await vscode.window.showWorkspaceFolderPick();
    if (!folder) {
      if (!folders.length) void vscode.window.showErrorMessage('Open a workspace folder before starting a Codex run.');
      return;
    }
    const prompt = await vscode.window.showInputBox({
      title: 'Start a read-only Codex run',
      prompt: 'Describe the task and which work to delegate to subagents.',
      validateInput: value => value.trim() ? undefined : 'Enter a task.'
    });
    if (!prompt?.trim() || client) return;

    selectedRunId = undefined;
    showPanel(false);
    publish({ status: 'Connecting', run: null });
    const executable = vscode.workspace.getConfiguration('agentWorkspace').get('codexExecutable');
    let run;
    const connection = new CodexClient(executable, folder.uri.fsPath, (method, params) => {
      if (!run || client !== connection) return;
      const next = reduceActivity(run, method, params);
      if (next === run) return;
      run = next;
      if (run.status !== 'running') {
        connection.close(new Error('Run finished.'));
        client = undefined;
      }
      publish({ status: run.status, run });
    }, error => {
      if (client !== connection) return;
      client = undefined;
      publish({ status: error.message, run });
    });
    client = connection;

    try {
      await connection.initialize();
      const threadId = await connection.startThread(folder.uri.fsPath);
      if (client !== connection) return;
      run = startRun(threadId, prompt.trim());
      run = { ...run, workspacePath: folder.uri.fsPath };
      publish({ status: run.status, run });
      await connection.startTurn(threadId, prompt.trim());
    } catch (error) {
      if (client !== connection) return;
      connection.close(error);
      client = undefined;
      publish({ status: error.message, run });
    }
  }

  const folders = (vscode.workspace.workspaceFolders ?? [])
    .filter(folder => folder.uri.scheme === 'file').map(folder => folder.uri.fsPath);
  if (folders.length && vscode.extensions.getExtension('openai.chatgpt')) {
    const output = vscode.window.createOutputChannel('Agent Campus');
    context.subscriptions.push(output);
    const reportError = error => output.appendLine(`Could not observe Codex IDE sessions: ${error.message}`);
    let observedTurn;
    try {
      context.subscriptions.push(observeIdeSessions(folders, (run, turnId) => {
        if (client) return;
        if (turnId !== observedTurn) {
          observedTurn = turnId;
          if (vscode.workspace.getConfiguration('agentWorkspace').get('autoOpen')) showPanel(true);
        }
        publish({ status: `Codex chat · ${run.status}`, run });
      }, reportError));
    } catch (error) {
      reportError(error);
    }
  }

  context.subscriptions.push(
    vscode.commands.registerCommand('agentWorkspace.open', () => showPanel(false)),
    vscode.commands.registerCommand('agentWorkspace.start', start),
    vscode.commands.registerCommand('agentWorkspace.stop', stop),
    { dispose: stop }
  );
}

module.exports = { activate };
