# OpenCode Codex Bridge

Use OpenCode as a terminal frontend for Codex CLI, with local prompt suggestions from [opencode-ghost](https://github.com/racinette/opencode-ghost).

Codex executes tasks and stores conversation history. The bridge connects OpenCode's HTTP/SSE client to a local `codex app-server`; the TUI plugin supplies native command and approval dialogs. Authentication, instructions, skills, MCP tools, sandboxing, and approval policy come from Codex.

## Requirements

- Bun 1.3.14 or later and Node 22 or later for development checks.
- Codex CLI 0.161.0, installed on `PATH` and authenticated with `codex login`.
- OpenCode with the prompt ghost API, and `opencode-ghost`.
- A local llama.cpp completion server for ghost suggestions; default: `http://127.0.0.1:8080`.

The local launcher expects sibling `opencode`, `opencode-ghost`, and `opencode-codex-bridge` directories.

## Run locally

Install the bridge dependencies:

```sh
cd opencode-codex-bridge
bun install
bun run ui /path/to/project
```

From the shared workspace, start the frontend for a project:

```sh
./try-codex.sh /path/to/project
```

Resume the latest conversation in that directory, or a specific native Codex thread:

```sh
./try-codex.sh /path/to/project --continue
./try-codex.sh /path/to/project --thread <codex-thread-uuid>
```

To continue a conversation owned by your running Codex client, connect to its managed daemon:

```sh
./try-codex.sh /path/to/project --daemon --thread <codex-thread-uuid>
```

`--daemon` uses the existing Codex backend and requires Node on `PATH`. Exiting OpenCode closes only the bridge connection; the daemon keeps running. Finish the current turn before submitting from another frontend.

Without `--daemon`, the bridge starts a separate app-server. Codex permits one writer process per thread, so it cannot resume a thread still loaded by another backend. Closing a chat can leave it loaded for a 30-minute inactivity grace period after the last subscriber disconnects.

The launcher chooses an available loopback port, loads both plugins, and stops the bridge when OpenCode exits. To use another completion server, add `--ghost-endpoint http://127.0.0.1:8080`.

## Using the frontend

Type normally. Ghost suggestions use the prompt and recent user/assistant conversation from the current Codex thread. At the end of the real input, Right Arrow accepts one word; a second quick press accepts the remaining suggestion. Ghost text is never submitted until accepted or typed.

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

## Run the components separately

```sh
cd opencode-codex-bridge
bun start --cwd /path/to/project --port 4097
```

Add `--daemon` to attach to the running managed daemon. The server inherits Codex's configuration. Explicit overrides are available with `--approval-policy`, `--sandbox`, and `--approvals-reviewer`.

Load the TUI plugin alongside `opencode-ghost` in `tui.json`, with absolute paths to the plugin entry points:

```json
{
  "plugin": [
    [
      "/path/to/opencode-ghost/src/index.tsx",
      { "endpoint": "http://127.0.0.1:8080" }
    ],
    [
      "/path/to/opencode-codex-bridge/src/tui.tsx",
      { "endpoint": "http://127.0.0.1:4097" }
    ]
  ]
}
```

The bridge plugin discovers the attached server through the OpenCode SDK. Then run `opencode attach http://127.0.0.1:4097 --dir /path/to/project`.

## Supported scope

This frontend supports conversation creation and resume, streamed responses and tool results, steering, interruption, native Plan mode, model/effort selection, approvals, questions, reviews, compaction, and whole-thread forks. History remains in Codex's thread store and can be resumed by Codex CLI.

Full Codex CLI command and UI parity is not implemented. OpenCode snapshot undo/redo, sharing, shell mode, and forks at arbitrary messages are unavailable. Native subagent navigation is provided by the bridge; OpenCode's separate background-agent execution API is not exposed. MCP execution remains native to Codex. Standard and OpenAI form elicitation are supported with JSON Schema draft 7, 2019-09, or 2020-12 validation; unsupported schema extensions fail validation rather than being silently ignored. File search and diff/todo sidebars are not populated; native tool output remains visible in the conversation. Billing and context limits are not estimated by this adapter.

## Development and verification

```sh
bun run check
bun script/parity-smoke.ts
bun script/native-controls-smoke.ts
bun script/live-smoke.ts
bun script/terminal-smoke.ts
```

`check` runs typechecking and automated tests with a fixture app-server subprocess and the real OpenCode SDK. `parity-smoke` uses tmux and the real OpenCode frontend with the fixture backend to exercise command dialogs, typed MCP forms, and subagent navigation. `native-controls-smoke` checks the installed Codex backend with an isolated thread and a local stdio MCP peer, including permission changes and a real elicitation round-trip; it does not make model requests.

`live-smoke` and `terminal-smoke` use your authenticated Codex account and make model requests in isolated temporary workspaces and native test threads. `terminal-smoke` also needs tmux and the local completion server. All checks close the processes they start.

The checked-in protocol bindings were generated by Codex CLI 0.161.0:

```sh
codex app-server generate-ts --experimental --out src/protocol
```
