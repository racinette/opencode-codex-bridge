import { expect, test } from "bun:test"
import { createTestRenderer } from "@opentui/core/testing"
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { registerCodexCommandNames } from "../src/command-names"

test("Codex names retain handlers and bindings, and restore on disposal", async () => {
  const app = await createTestRenderer({
    width: 40,
    height: 8,
    useThread: false,
  })
  const keymap = createDefaultOpenTuiKeymap(app.renderer)
  let resumes = 0
  let mode = "codex"
  const layer = keymap.registerLayer({
    commands: [
      {
        name: "session.list",
        namespace: "palette",
        slashName: "sessions",
        slashAliases: ["resume", "continue"],
        run: () => {
          resumes++
        },
      },
      {
        name: "model.list",
        namespace: "palette",
        slashName: "models",
        slashAliases: ["mo"],
        run: () => {},
      },
      {
        name: "app.exit",
        namespace: "palette",
        slashName: "exit",
        run: () => {},
      },
      {
        name: "agent.cycle",
        namespace: "palette",
        hidden: true,
        run: () => {
          mode = mode === "codex" ? "plan" : "codex"
        },
      },
      {
        name: "theme.switch",
        namespace: "palette",
        slashName: "themes",
        run: () => {},
      },
    ],
    bindings: [
      { key: "ctrl+r", cmd: "session.list" },
      { key: "tab", cmd: "agent.cycle" },
    ],
  })
  const off = registerCodexCommandNames(keymap)
  const command = (name: string) =>
    keymap
      .getCommands({ namespace: "palette" })
      .find((command) => command.name === name)!
  try {
    expect(command("session.list").slashName).toBe("resume")
    expect(command("session.list").slashAliases).toEqual([
      "sessions",
      "continue",
    ])
    expect(command("model.list").slashName).toBe("model")
    expect(command("model.list").slashAliases).toEqual(["models", "mo"])
    expect(command("app.exit").slashName).toBe("quit")
    expect(command("app.exit").slashAliases).toEqual(["exit"])
    expect(command("agent.cycle").slashName).toBe("plan")
    expect(command("agent.cycle").hidden).toBe(false)
    keymap.dispatchCommand("agent.cycle")
    expect(mode).toBe("plan")
    await app.mockInput.pressTab()
    expect(mode).toBe("codex")
    expect(command("theme.switch").slashName).toBe("themes")
    keymap.dispatchCommand("session.list")
    expect(resumes).toBe(1)
    await app.mockInput.pressKey("r", { ctrl: true })
    expect(resumes).toBe(2)
    off()
    expect(command("session.list").slashName).toBe("sessions")
    expect(command("session.list").slashAliases).toEqual(["resume", "continue"])
    expect(command("model.list").slashName).toBe("models")
    expect(command("agent.cycle").hidden).toBe(true)
    expect(command("agent.cycle").slashName).toBeUndefined()
  } finally {
    off()
    layer()
    app.renderer.destroy()
  }
})
