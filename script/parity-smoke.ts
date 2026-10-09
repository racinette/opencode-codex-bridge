// Exercise native command dialogs in the real OpenCode terminal frontend.
// Uses the fixture subprocess: no model requests or account mutations.
import { strict as assert } from "node:assert"
import { mkdtemp, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { createOpencodeClient } from "@opencode-ai/sdk/v2"
import { Bridge } from "../src/bridge"

const root = resolve(import.meta.dir, "../..")
const cwd = await mkdtemp(join(tmpdir(), "codex-parity-ui-"))
const name = `codex-parity-${process.pid}`
const bridge = new Bridge({
  cwd,
  command: [
    process.execPath,
    join(root, "opencode-codex-bridge/test/fake-codex.ts"),
  ],
})
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'"
const tmux = async (...args: string[]) => {
  const proc = Bun.spawn(["tmux", ...args], { stdout: "pipe", stderr: "pipe" })
  const [output, error, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  if (code) throw new Error(`tmux ${args[0]}: ${error}`)
  return output
}
const capture = () => tmux("capture-pane", "-p", "-t", name)
const type = (text: string) => tmux("send-keys", "-t", name, "-l", text)
const key = async (value: string) => {
  await tmux("send-keys", "-t", name, value)
  await Bun.sleep(120)
}
const frames = async () =>
  (await readFile(join(cwd, "fixture-rpc.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line))
async function until(check: () => Promise<boolean> | boolean, label: string) {
  const deadline = Date.now() + 20000
  while (Date.now() < deadline) {
    if (await check()) return
    await Bun.sleep(100)
  }
  const screen = await capture().catch(() => "No pane")
  await Bun.write(join(cwd, "failure.txt"), screen)
  throw new Error(`Timed out: ${label}\n${screen}\nArtifacts: ${cwd}`)
}
const visible = (text: string) =>
  until(async () => (await capture()).includes(text), text)
const save = async (file: string) =>
  Bun.write(join(cwd, file + ".txt"), await capture())
const command = async (text: string, title: string) => {
  await type("/" + text)
  await key("Enter")
  await visible(title)
}
const select = async (text: string) => {
  await type(text)
  await key("Enter")
  await Bun.sleep(150)
}
let started = false
try {
  await bridge.initialize()
  const endpoint = bridge.listen(0)
  const client = createOpencodeClient({ baseUrl: endpoint, throwOnError: true })
  const session = (await client.session.create()).data!
  const config = join(cwd, "tui.json")
  await Bun.write(
    config,
    JSON.stringify({
      plugin: [[join(root, "opencode-codex-bridge/src/tui.tsx"), { endpoint }]],
    }),
  )
  const launch = [
    process.execPath,
    "run",
    "--cwd",
    join(root, "opencode/packages/opencode"),
    "src/index.ts",
    "attach",
    endpoint,
    "--dir",
    cwd,
    "--session",
    session.id,
  ]
    .map(quote)
    .join(" ")
  await tmux(
    "new-session",
    "-d",
    "-s",
    name,
    "-x",
    "140",
    "-y",
    "52",
    `cd ${quote(root)} && PATH=${quote(process.env.PATH ?? "")} OPENCODE_TUI_CONFIG=${quote(config)} ${launch}`,
  )
  started = true
  await visible("Codex CLI")

  await command("status", "Codex status")
  await visible("Not reported on this connection yet")
  await save("status")
  await key("Escape")
  await command("permissions", "Codex permissions")
  await select(":workspace")
  await until(
    async () =>
      (await frames()).some(
        (frame) =>
          frame.method === "thread/settings/update" &&
          frame.params.permissions === ":workspace",
      ),
    "native permission selection",
  )
  await save("permissions-updated")

  await command("mcp", "Codex MCP servers")
  await select("fixture")
  await visible("MCP · fixture")
  await key("Enter")
  await visible("notes://current")
  await save("mcp-inventory")
  // Confirm the alert returns to its menu rather than clearing the replacement.
  await key("Enter")
  await visible("Authenticate with OAuth")
  await select("Authenticate")
  await visible("https://example.com/authorize")
  await save("mcp-oauth")
  await key("Escape")
  await command("mcp", "Codex MCP servers")
  await select("Reload")
  await until(
    async () =>
      (await frames()).some(
        (frame) => frame.method === "config/mcpServer/reload",
      ),
    "native MCP reload",
  )
  await visible("Codex MCP servers")
  await key("Escape")

  await client.session.prompt({
    sessionID: session.id,
    parts: [{ type: "text", text: "elicitation" }],
  })
  await visible("Fill out form")
  await key("Enter")
  await visible("Submit form")
  await save("mcp-form")
  await select("name")
  await visible("string")
  await type("Joe")
  await key("Enter")
  await visible('"Joe"')
  await select("count")
  await visible("integer")
  await type("2")
  await key("Enter")
  await visible("count *: 2")
  await select("confirm")
  await select("No")
  await visible("confirm *: false")
  await select("color")
  await select("blue")
  await visible('color *: "blue"')
  await select("Review response")
  await visible("MCP form · review")
  await key("Enter")
  await visible("Submit form")
  // Escape must dismiss, not answer; /requests reopens a pending request.
  await key("Escape")
  assert.equal(bridge.approvals.list().length, 1)
  await command("requests", "Fill out form")
  await key("Enter")
  await visible("Submit form")
  await visible("count *: 2")
  await select("Edit response as JSON")
  await visible("MCP form · JSON")
  await key("C-a")
  await key("C-k")
  await type('{"name":"Joe","count":2,"confirm":false,"color":"blue"}')
  await key("Enter")
  await visible('color *: "blue"')
  await save("mcp-form-complete")
  await select("Submit form")
  await until(
    () => bridge.approvals.list().length === 0,
    "native MCP form response",
  )
  await until(
    async () =>
      (await frames()).some(
        (frame) =>
          frame.result?.action === "accept" &&
          frame.result.content?.count === 2 &&
          frame.result.content?.confirm === false,
      ),
    "typed MCP result",
  )

  await client.session.prompt({
    sessionID: session.id,
    parts: [{ type: "text", text: "spawn" }],
  })
  await command("agent", "Codex agent threads")
  await visible("Scout")
  await save("subagents")
  await select("Scout")
  await visible("controlled by its parent")
  await visible("SCOUT_RESULT")
  await key("C-p")
  await select("Switch Codex agent thread")
  await visible("Codex agent threads")
  await select("Main agent")
  await command("status", "Codex status")
  await visible(String(session.metadata!.codexThreadID))
  await save("returned-main")
  console.log(
    `PASS: native status, permissions, MCP inventory/OAuth/reload, typed form editing and reopening, subagent navigation and return\nArtifacts: ${cwd}`,
  )
} finally {
  if (started) await tmux("kill-session", "-t", name).catch(() => {})
  await bridge.close()
}
