# Agent Campus

A local VS Code visualizer that turns Codex chats and their subagents into a live agent campus.

The **Campus** gives each agent a workstation. Observed assignments send the delegating agent to the recipient's station; completed work triggers a visit to collect the reported result and return home. These visits visualize recorded handoffs, rather than controlling when Codex agents communicate. A **List** groups agents by status. Select a station or agent to inspect its assignment, reported progress, available reasoning summaries, active command, and result. Raw reasoning content is excluded.

The expandable run overview collects reported results, observed commands with output and exit codes, and changed files grouped by agent. Open files or review their **HEAD ↔ working tree** differences in VS Code; these differences include any existing local edits. File attribution depends on Codex emitting file-change events. Failed commands stay visible until the same agent successfully retries that command. The **Activity** timeline preserves recent observed events.

## Follow a Codex chat

1. Open this folder in desktop **VS Code 1.95 or later** and press **F5** to launch the Extension Development Host.
2. In that window, open a trusted local workspace with the official Codex extension enabled.
3. Send a message in the Codex sidebar. Agent Campus opens beside the editor when the new turn is recorded, leaving focus in the chat.

Agent Campus observes the latest turn that starts in the workspace by reading the official extension’s local session records. Their format may change with Codex updates. Disable Agent Campus in VS Code to stop automatic opening.

## Run a standalone demo

The standalone mode starts its own read-only Codex run and requires a signed-in **Codex CLI with App Server support**.

1. Launch the Extension Development Host with **F5**.
2. Run **Agent Campus: Start Run** from the Command Palette.
3. Enter a task such as:

   > Spawn two subagents in parallel. Have one count the contributed commands in package.json and the other identify the activity reducer entry point in src/activity.cjs. Wait for both and summarize their findings.

4. Watch the agents and expand **Activity** to inspect events. Use **Agent Campus: Stop Run** to stop this standalone run early.

If VS Code cannot find `codex`, set `agentWorkspace.codexExecutable` in user settings to the absolute path reported by `command -v codex`.

Agent assignments, statuses, and updates reflect what Codex exposes in its records or event stream. When task details are encrypted or absent, the campus shows the observed assignment without inventing its contents. Standalone runs read child thread snapshots on subagent activity to collect exposed progress and results. Activity stays in the extension’s memory; Codex manages its own session storage.

## Development checks

- `npm run check` checks JavaScript syntax.
- `npm test` replays command retries, file changes, delegation cycles, result handoffs, and summary-only progress through the activity model.
- `npm run smoke` performs a real App Server handshake and creates a read-only thread.
- `npm run smoke -- '<delegation prompt>'` additionally requires a completed run with at least two observed subagents, a task assignment, and a returned result.
