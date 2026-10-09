# OpenCode Codex Bridge

Use OpenCode as a terminal frontend for Codex CLI.

Codex executes tasks and stores conversation history. The bridge connects OpenCode's HTTP/SSE client to a local `codex app-server`; the TUI plugin supplies native command and approval dialogs. Authentication, instructions, skills, MCP tools, sandboxing, and approval policy come from Codex.

## Requirements

- Bun 1.3.14 or later.
- Codex CLI on `PATH`, authenticated with `codex login`. The protocol bindings target version 0.161.0.
- OpenCode with TUI plugin support. The frontend integration has been tested with version 1.18.35.
- Node on `PATH` when connecting to a managed Codex daemon; Node 22 or later for development checks.

## Setup

Clone this repository anywhere and install its dependencies:

```sh
git clone https://github.com/racinette/opencode-codex-bridge.git
cd opencode-codex-bridge
bun install
```

Add the bridge's TUI plugin to your project's `.opencode/tui.json`. Replace the path with the absolute path to your clone and preserve existing plugin entries:

```json
{
  "plugin": ["/absolute/path/opencode-codex-bridge/src/tui.tsx"]
}
```

From the bridge repository, start the backend for your project:

```sh
bun start --cwd /absolute/path/to/project --port 4097
```

In another terminal, connect your installed OpenCode frontend:

```sh
opencode attach http://127.0.0.1:4097 --dir /absolute/path/to/project
```

The TUI plugin discovers the attached server through the OpenCode SDK. Use `/resume` to select an existing Codex conversation for that directory. Keep the bridge running while using the frontend; stop it with Ctrl+C after exiting OpenCode.

### Connecting to an existing Codex daemon

To use the backend shared by a running Codex client, start the bridge with `--daemon`:

```sh
bun start --cwd /absolute/path/to/project --port 4097 --daemon
```

Attach OpenCode with the same command above, then select the conversation with `/resume`. This requires a running managed Codex daemon and Node on `PATH`. Stopping the bridge closes its connection; the daemon keeps running. Finish the current turn before submitting from another frontend.

Without `--daemon`, the bridge starts a separate app-server. Codex permits one writer process per thread, so it cannot resume a thread still loaded by another backend. A disconnected thread can remain loaded until the native backend's inactivity grace period expires.

The server inherits Codex's configuration. Explicit overrides are available with `--approval-policy`, `--sandbox`, and `--approvals-reviewer`.

## Using the frontend

Submitting during an active turn steers that Codex turn. OpenCode's interrupt action calls Codex's native interruption method. Tab switches between Codex and native Plan mode; the model and reasoning selectors use Codex's model catalog.

| Command        | Behavior                                                              |
| -------------- | --------------------------------------------------------------------- |
| `/plan`        | Toggle native Codex Plan mode for the next turn, like Tab.            |
| `/resume`      | Open the native Codex conversation picker for this directory.         |
| `/model`       | Select a model from Codex's model catalog.                            |
| `/quit`        | Close the frontend.                                                   |
| `/compact`     | Compact the native Codex context.                                     |
| `/fork`        | Fork the entire native conversation and open the new thread.          |
| `/review`      | Review uncommitted changes or enter custom review instructions.       |
| `/goal`        | Set a native Codex goal.                                              |
| `/goal-status` | Show the current native goal.                                         |
| `/goal-clear`  | Clear the goal.                                                       |
| `/status`      | Show native model, permissions, account limits, and token usage.      |
| `/permissions` | Change native permissions for subsequent turns in this thread.        |
| `/mcp`         | Inspect MCP servers and tools, authenticate, or reload configuration. |
| `/agent`       | Switch between the main conversation and its native subagents.        |
| `/requests`    | Reopen pending native approval or MCP request dialogs.                |
| `/connect`     | Show how to authenticate the Codex CLI.                               |

Approval dialogs show the choices supplied by Codex, including proposed command or network rules when offered. Permission grants stay within the native scope selected. Native user questions retain their option and free-text answers.

`/status` reads Codex's effective thread settings and available account limits. Context and token counts use native usage notifications; before Codex reports usage on this connection, the dialog says it is unavailable. Account discovery failures do not prevent viewing thread settings.

`/permissions` lists Codex's permission profiles and approval policies. Managed restrictions disable unavailable choices. Changes affect subsequent turns in the selected thread, preserve its approval reviewer, and do not edit `config.toml`. Finish the current turn before changing permissions.

`/mcp` shows connection and authentication status, tools, resources, and resource templates. OAuth login displays the native authorization URL to open in your browser; refresh afterward to check authentication. Reload asks the connected Codex backend to reload its MCP configuration. Edit server definitions in Codex's configuration, then use reload to apply them.

MCP form requests open an editor with typed fields, a JSON editor for nested responses, and schema validation before submission. Esc dismisses the dialog without answering; `/requests` reopens it and retains the draft while the frontend stays open. URL requests display their external flow and require an explicit response after completing it. Native user-verification challenges require a frontend that supports that verification flow; this bridge offers decline or cancel.

`/agent` (also `/subagents`) lists the main thread and its descendants, including nested subagents. Selecting one loads its native conversation and live output. Parent-controlled subagents are read-only: use Up Arrow to return to their parent, or open the command palette and select “Switch Codex agent thread” to navigate elsewhere. Send instructions through the parent thread.

`/sessions` and `/continue` remain aliases of `/resume`; `/models` remains an alias of `/model`; `/exit` remains an alias of `/quit`. These names use the existing frontend handlers and shortcuts. They do not add a general Codex CLI command parser. `/plan` currently toggles the mode only; enter the planning prompt afterward rather than using CLI-style inline `/plan <text>` arguments.

OpenCode's theme, layout, copy, and other display commands continue to control the frontend.

## Optional prompt suggestions

[opencode-ghost](https://github.com/racinette/opencode-ghost) is a separate plugin that adds inline prompt suggestions. Install and configure it following its own README, preserving the bridge entry in `tui.json`. It requires OpenCode's prompt ghost API and a completion endpoint.

The ghost plugin uses the prompt and recent user/assistant conversation exposed by OpenCode, including conversations served by this bridge. Each plugin can be installed and used independently.

## Supported scope

This frontend supports conversation creation and resume, streamed responses and tool results, steering, interruption, native Plan mode, model/effort selection, approvals, questions, reviews, compaction, and whole-thread forks. History remains in Codex's thread store and can be resumed by Codex CLI.

Full Codex CLI command and UI parity is not implemented. OpenCode snapshot undo/redo, sharing, shell mode, and forks at arbitrary messages are unavailable. Native subagent navigation is provided by the bridge; OpenCode's separate background-agent execution API is not exposed. MCP execution remains native to Codex. Standard and OpenAI form elicitation are supported with JSON Schema draft 7, 2019-09, or 2020-12 validation; unsupported schema extensions fail validation rather than being silently ignored. File search and diff/todo sidebars are not populated; native tool output remains visible in the conversation. Billing and context limits are not estimated by this adapter.

## Development and verification

```sh
bun run check
bun script/native-controls-smoke.ts
bun script/live-smoke.ts
```

`check` runs typechecking and automated tests with a fixture app-server subprocess and the OpenCode SDK. `native-controls-smoke` checks the installed Codex backend with an isolated thread and a local stdio MCP peer, including permission changes and a real elicitation round-trip; it does not make model requests.

`live-smoke` uses your authenticated Codex account and makes model requests in isolated temporary workspaces and native test threads. Both smoke scripts close the processes they start.

The checked-in protocol bindings were generated by Codex CLI 0.161.0:

```sh
codex app-server generate-ts --experimental --out src/protocol
```
