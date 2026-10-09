import { fileURLToPath } from "node:url"

export function daemonProxyCommand(socketPath: string) {
  return [
    "node",
    fileURLToPath(new URL("./daemon-proxy.mjs", import.meta.url)),
    socketPath,
  ]
}

export async function daemonCommand() {
  const probe = Bun.spawn(["codex", "app-server", "daemon", "version"], {
    stdout: "pipe",
    stderr: "pipe",
  })
  const deadline = setTimeout(() => probe.kill(), 5000)
  try {
    const [output, diagnostics, code] = await Promise.all([
      new Response(probe.stdout).text(),
      new Response(probe.stderr).text(),
      probe.exited,
    ])
    if (code !== 0)
      throw new Error(`Cannot inspect Codex daemon: ${diagnostics.trim()}`)
    const metadata = JSON.parse(output)
    if (
      metadata.status !== "running" ||
      typeof metadata.socketPath !== "string"
    )
      throw new Error(
        "No running Codex daemon. Start your Codex client or omit --daemon.",
      )
    return daemonProxyCommand(metadata.socketPath)
  } finally {
    clearTimeout(deadline)
  }
}
