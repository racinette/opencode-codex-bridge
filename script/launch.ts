import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { parseArgs } from "node:util"
import { sessionID } from "../src/projection"

const { values, positionals } = parseArgs({
  args: Bun.argv.slice(2),
  allowPositionals: true,
  options: {
    thread: { type: "string" },
    daemon: { type: "boolean", default: false },
    continue: { type: "boolean", default: false },
    "ghost-endpoint": { type: "string", default: "http://127.0.0.1:8080" },
  },
})
if (positionals.length > 1)
  throw new Error(
    "Usage: try-codex.sh [directory] [--thread UUID] [--continue] [--daemon]",
  )
const cwd = resolve(positionals[0] ?? process.cwd())
const root = resolve(import.meta.dir, "../..")
const state = await mkdtemp(join(tmpdir(), "opencode-codex-"))
const logs = join(state, "bridge.log")
const backend = Bun.spawn(
  [
    process.execPath,
    join(import.meta.dir, "../src/main.ts"),
    "--cwd",
    cwd,
    "--port",
    "0",
    ...(values.daemon ? ["--daemon"] : []),
  ],
  {
    cwd,
    stdin: "ignore",
    stdout: "pipe",
    stderr: Bun.file(logs),
    env: { ...process.env, PWD: cwd },
  },
)
let frontend: ReturnType<typeof Bun.spawn> | undefined
let closing = false
const close = async () => {
  if (closing) return
  closing = true
  frontend?.kill()
  backend.kill()
  await backend.exited
}
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => void close())
try {
  const deadline = setTimeout(() => backend.kill(), 30000)
  let line = "",
    url: string | undefined
  for await (const chunk of backend.stdout) {
    line += new TextDecoder().decode(chunk)
    url = line.match(/listening at (http:\/\/127\.0\.0\.1:\d+\/)/)?.[1]
    if (url) break
  }
  clearTimeout(deadline)
  if (!url) throw new Error(`Bridge did not start. Diagnostics: ${logs}`)
  const config = join(state, "tui.json")
  await Bun.write(
    config,
    JSON.stringify(
      {
        plugin: [
          [
            join(root, "opencode-ghost/src/index.tsx"),
            { endpoint: values["ghost-endpoint"] },
          ],
          join(root, "opencode-codex-bridge/src/tui.tsx"),
        ],
      },
      null,
      2,
    ),
  )
  const args = [
    process.execPath,
    "run",
    "--cwd",
    join(root, "opencode/packages/opencode"),
    "src/index.ts",
    "attach",
    url,
    "--dir",
    cwd,
  ]
  if (values.thread) {
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
        values.thread,
      )
    )
      throw new Error("Invalid Codex thread UUID")
    args.push("--session", sessionID(values.thread))
  } else if (values.continue) args.push("--continue")
  frontend = Bun.spawn(args, {
    cwd,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
    env: { ...process.env, PWD: cwd, OPENCODE_TUI_CONFIG: config },
  })
  process.exitCode = await frontend.exited
} catch (error) {
  console.error(error)
  process.exitCode = 1
} finally {
  await close()
  if (process.exitCode === 0) await rm(state, { recursive: true, force: true })
  else console.error(`Bridge diagnostics: ${logs}`)
}
