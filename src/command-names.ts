import type { TuiKeymap } from "@opencode-ai/plugin/tui"

/** Prefer Codex names for actions whose existing handlers already map to Codex. */
export function registerCodexCommandNames(keymap: TuiKeymap) {
  const names: Record<string, string> = {
    "session.list": "resume",
    "model.list": "model",
    "app.exit": "quit",
    "agent.cycle": "plan",
  }
  const commands = keymap
    .getCommands({ namespace: "palette" })
    .flatMap((command) => {
      const name = names[command.name]
      if (!name) return []
      const aliases = Array.isArray(command.slashAliases)
        ? command.slashAliases.filter(
            (alias): alias is string => typeof alias === "string",
          )
        : []
      if (typeof command.slashName === "string")
        aliases.unshift(command.slashName)
      return [
        {
          ...command,
          ...(name === "plan"
            ? { hidden: false, title: "Toggle Codex Plan mode" }
            : {}),
          slashName: name,
          slashAliases: [...new Set(aliases)].filter((alias) => alias !== name),
        },
      ]
    })
  // Keep the existing command IDs, handlers, fields, and keyboard bindings.
  return keymap.registerLayer({ priority: 100, commands })
}
