const vscode = require('vscode');
const { readFileSync } = require('node:fs');
const { CodexClient } = require('./client.cjs');
const { startRun, reduceActivity } = require('./activity.cjs');
const { observeIdeSessions } = require('./ide-sessions.cjs');

/** @param {import('vscode').ExtensionContext} context */
function activate(context) {
  let panel;
  let client;
  let state = { status: 'Ready', run: null };

  function publish(next) {
    state = next;
    if (panel) void panel.webview.postMessage(state);
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
      style: uri('panel.css'), script: uri('panel.js'), art: uri('campus.jpg')
    };
    const template = readFileSync(vscode.Uri.joinPath(media, 'panel.html').fsPath, 'utf8');
    panel.webview.html = template.replace(/{{(\w+)}}/g, (_token, key) => resources[key]);
    panel.webview.onDidReceiveMessage(message => {
      if (message === 'ready') void panel.webview.postMessage(state);
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

    showPanel(false);
    publish({ status: 'Connecting', run: null });
    const executable = vscode.workspace.getConfiguration('agentWorkspace').get('codexExecutable');
    let run;
    const connection = new CodexClient(executable, folder.uri.fsPath, (method, params) => {
      if (!run || client !== connection) return;
      const next = reduceActivity(run, method, params);
      if (next === run) return;
      run = next;
      publish({ status: run.status, run });
      if (run.status !== 'running') {
        connection.close(new Error('Run finished.'));
        client = undefined;
      }
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
          showPanel(true);
        }
        publish({ status: `Codex chat · ${run.status}`, run });
      }, reportError));
    } catch (error) {
      reportError(error);
    }
  }

  context.subscriptions.push(
    vscode.commands.registerCommand('agentWorkspace.start', start),
    vscode.commands.registerCommand('agentWorkspace.stop', stop),
    { dispose: stop }
  );
}

module.exports = { activate };
