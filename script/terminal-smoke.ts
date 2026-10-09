import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { strict as assert } from "node:assert"
import { createOpencodeClient } from "@opencode-ai/sdk/v2"
import { Bridge } from "../src/bridge"
import { wordPrefix } from "../../opencode-ghost/src/acceptance"

const root = resolve(import.meta.dir, "../..")
const cwd = await mkdtemp(join(tmpdir(), "codex-terminal-smoke-"))
const name = `codex-ghost-test-${process.pid}`
const upstream = process.env.GHOST_ENDPOINT ?? "http://127.0.0.1:8080"
assert(
  (await fetch(upstream + "/health")).ok,
  "Completion server must be running",
)
const requests: { prompt: string; content: string }[] = []
const proxy = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const body = (await request.json()) as { prompt: string }
    const response = await fetch(upstream + new URL(request.url).pathname, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
    const result = (await response.json()) as { content: string }
    requests.push({ prompt: body.prompt, content: result.content })
    return Response.json(result, { status: response.status })
  },
})
const bridge = new Bridge({
  cwd,
  native: {
    sandbox: "read-only",
    approvalPolicy: "untrusted",
    approvalsReviewer: "user",
  },
})
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'"
const tmux = async (...args: string[]) => {
  const process = Bun.spawn(["tmux", ...args], {
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, code] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ])
  if (code !== 0) throw new Error(`tmux ${args[0]}: ${stderr}`)
  return stdout
}
const capture = () => tmux("capture-pane", "-p", "-t", name)
const type = (value: string) => tmux("send-keys", "-t", name, "-l", value)
const key = (value: string) => tmux("send-keys", "-t", name, value)
async function until(
  check: () => Promise<boolean> | boolean,
  label: string,
  timeout = 30000,
) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (await check()) return
    await Bun.sleep(100)
  }
  await Bun.write(
    join(cwd, "failure-screen.txt"),
    await capture().catch(() => "No pane"),
  )
  throw new Error(`Timed out: ${label} (artifacts: ${cwd})`)
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
      plugin: [
        [
          join(root, "opencode-ghost/src/index.tsx"),
          { endpoint: proxy.url.toString(), max_tokens: 16, debug: true },
        ],
        [
          join(root, "opencode-codex-bridge/src/tui.tsx"),
          { endpoint: "http://127.0.0.1:1" },
        ],
      ],
    }),
  )
  const command = [
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
    "120",
    "-y",
    "38",
    `cd ${quote(root)} && PATH=${quote(process.env.PATH ?? "")} OPENCODE_TUI_CONFIG=${quote(config)} ${command}`,
  )
  started = true
  await until(
    async () => (await capture()).includes("Codex CLI"),
    "attached composer",
  )
  await type("Hello")
  await until(
    () => requests.some((r) => r.content.length > 0),
    "real llama.cpp completion",
  )
  const completion = requests.find((r) => r.content.length > 0)!.content
  await until(
    async () => (await capture()).includes("Hello" + completion.trimEnd()),
    "visible ghost text",
  )
  await Bun.write(join(cwd, "ghost-visible.txt"), await capture())
  await key("Right")
  const suffix =
    ' please run python3 -c "print(\"TERMINAL_TOOL_OK\")" and reply exactly TERMINAL_SMOKE_OK.'
  // Use single quotes in Python so the shell command remains unambiguous.
  const instruction = suffix.replace(
    'print("TERMINAL_TOOL_OK")',
    "print('TERMINAL_TOOL_OK')",
  )
  await type(instruction)
  await key("Enter")
  await until(
    () => bridge.approvals.list().some((r) => r.decisions.length > 0),
    "native approval request",
    120000,
  )
  await until(
    async () => (await capture()).includes("Codex command approval"),
    "native approval dialog",
  )
  await Bun.write(join(cwd, "approval-dialog.txt"), await capture())
  await key("Enter")
  await until(
    async () =>
      (await client.session.status()).data![session.id]?.type === "idle",
    "native turn completion",
    120000,
  )
  const rows = (await client.session.messages({ sessionID: session.id })).data!
  const input = rows
    .find((r) => r.info.role === "user")!
    .parts.find((p) => p.type === "text")!
  assert(input.type === "text")
  assert.equal(
    input.text,
    "Hello" + wordPrefix(completion) + instruction,
    "Only the accepted ghost word may be submitted",
  )
  assert(
    rows.some((r) =>
      r.parts.some(
        (p) =>
          p.type === "tool" &&
          p.state.status === "completed" &&
          p.state.output.includes("TERMINAL_TOOL_OK"),
      ),
    ),
    "Real tool stdout must be present",
  )
  assert(
    rows.some((r) =>
      r.parts.some(
        (p) => p.type === "text" && p.text.includes("TERMINAL_SMOKE_OK"),
      ),
    ),
    "Real Codex response must be present",
  )
  await until(
    async () => (await capture()).includes("TERMINAL_SMOKE_OK"),
    "visible Codex response",
  )
  await Bun.write(join(cwd, "completed-turn.txt"), await capture())
  await type("The previous command was")
  await until(
    () =>
      requests.some(
        (r) =>
          r.prompt.includes("<|im_start|>user") &&
          r.prompt.includes(input.text) &&
          r.prompt.includes("<|im_start|>assistant") &&
          r.prompt.includes("TERMINAL_SMOKE_OK"),
      ),
    "native conversation in ghost context",
  )
  const contextual = requests.findLast((r) =>
    r.prompt.includes("TERMINAL_SMOKE_OK"),
  )!
  await Bun.write(
    join(cwd, "ghost-context.json"),
    JSON.stringify(contextual, null, 2),
  )
  console.log(
    `PASS: attached TUI, real ghost rendering, one-word acceptance, native approval dialog, tool stdout, Codex reply, native role context\nArtifacts: ${cwd}\nThread: ${session.metadata?.codexThreadID}`,
  )
} finally {
  if (started) await tmux("kill-session", "-t", name).catch(() => {})
  proxy.stop(true)
  await bridge.close()
}
