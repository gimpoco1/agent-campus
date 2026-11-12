# Agent Campus

A local VS Code visualizer that turns Codex chats and their subagents into a live agent campus.

The **Campus** gives each agent a workstation. Observed assignments send the delegating agent to the recipient's station; completed work triggers a visit to collect the reported result and return home. These visits visualize recorded handoffs, rather than controlling when Codex agents communicate. A **List** groups agents by status. Select a station or agent to inspect its assignment, reported progress, available reasoning summaries, active command, and result. Raw reasoning content is excluded.

The expandable run overview collects reported results, observed commands with output and exit codes, and changed files grouped by agent. Open files or review their **HEAD ↔ working tree** differences in VS Code; these differences include any existing local edits. File attribution depends on Codex emitting file-change events. Failed commands stay visible until the same agent successfully retries that command. The **Activity** timeline preserves recent observed events.

## Install

Requires desktop **VS Code 1.95 or later** and a trusted local workspace.

Open the [Agent Campus Marketplace listing](https://marketplace.visualstudio.com/items?itemName=agent-campus.agent-campus) and select **Install**, or open **Extensions** in VS Code, search for **Agent Campus** by publisher **agent-campus**, and select **Install**.

You can also install from a terminal:

```sh
code --install-extension agent-campus.agent-campus
```

The extension ID is `agent-campus.agent-campus`. If a new release is still being validated by the Marketplace, use the VSIX installation below while it becomes available.

To install a packaged release before it is available in the Marketplace:

1. Download `agent-campus-0.0.2.vsix` from the release provider, or build it using the development instructions below.
2. In VS Code, open **Extensions**, select the **…** menu, then **Install from VSIX…**.
3. Select the downloaded `.vsix` file and reload VS Code if prompted.

## Follow a Codex chat

1. Install and sign in to the [official OpenAI Codex extension](https://marketplace.visualstudio.com/items?itemName=openai.chatgpt).
2. Open a trusted local workspace. If you installed Codex after Agent Campus was activated, run **Developer: Reload Window** from the Command Palette.
3. Send a new message in the Codex sidebar. Agent Campus opens beside the editor when the new turn is recorded, leaving focus in the chat. There is no separate command to start observation.

Agent Campus observes the latest turn that starts in the workspace by reading the official extension’s local session records. Their format may change with Codex updates. Turn off `agentWorkspace.autoOpen` to keep observing without automatically opening the panel. Run **Agent Campus: Open Campus** to open it at any time.

Use the run selector to revisit the last 20 observed runs in the current VS Code window, or choose **Follow latest run** to follow new turns. Recent runs remain available after closing and reopening the panel; reloading the window clears them. **Copy report** copies the selected run’s assignments, results, changed files, and command evidence to the clipboard. The panel also provides controls to start a read-only standalone run and stop it.

## Run a standalone demo

The standalone mode starts its own read-only Codex run and requires a signed-in **Codex CLI with App Server support**.

1. Open a trusted local workspace with Agent Campus installed and the Codex CLI signed in.
2. Run **Agent Campus: Start Run** from the Command Palette.
3. Enter a task such as:

   > Spawn two subagents in parallel. Have one count the contributed commands in package.json and the other identify the activity reducer entry point in src/activity.cjs. Wait for both and summarize their findings.

4. Watch the agents and expand **Activity** to inspect events. Use **Agent Campus: Stop Run** to stop this standalone run early.

If VS Code cannot find `codex`, set `agentWorkspace.codexExecutable` in user settings to the absolute path reported by `command -v codex`.

Agent assignments, statuses, and updates reflect what Codex exposes in its records or event stream. When task details are encrypted or absent, the campus shows the observed assignment without inventing its contents. Standalone runs read child thread snapshots on subagent activity to collect exposed progress and results. Activity stays in the extension’s memory; Codex manages its own session storage.

## Development

Run `npm ci` to install development tools. Open this repository in VS Code and press **F5** to launch the Extension Development Host.

Run `npm run package` to check the source and create `agent-campus-0.0.2.vsix`. Run `npx vsce ls` to inspect the files included in the package. Runtime files are in `src/` and `media/`.

To publish the first release, sign in to [Marketplace publisher management](https://marketplace.visualstudio.com/manage), create or select publisher **agent-campus**, choose **New extension → Visual Studio Code**, and upload the `.vsix`. For later releases, increase `version` in `package.json`, package again, and upload through the existing extension's update action. Packaging does not publish or create a Git commit.

### Checks

- `npm run check` checks JavaScript syntax.
- `npm test` replays command retries, file changes, delegation cycles, result handoffs, and summary-only progress through the activity model.
- `npm run smoke` performs a real App Server handshake and creates a read-only thread.
- `npm run smoke -- '<delegation prompt>'` additionally requires a completed run with at least two observed subagents, a task assignment, and a returned result.
