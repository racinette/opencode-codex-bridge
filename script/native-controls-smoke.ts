// No model requests: exercises the installed Codex backend and a local MCP peer.
import { strict as assert } from "node:assert"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Bridge } from "../src/bridge"
import { threadID } from "../src/projection"

const cwd = await mkdtemp(join(tmpdir(), "codex-native-controls-"))
const configuration = `mcp_servers={parity={command=${JSON.stringify(process.execPath)},args=[${JSON.stringify(join(import.meta.dir, "../test/fake-mcp.ts"))}],startup_timeout_sec=5}}`
const bridge = new Bridge({
  cwd,
  command: ["codex", "app-server", "-c", configuration],
  native: { sandbox: "read-only", approvalPolicy: "on-request" },
})
try {
  await bridge.initialize()
  const endpoint = bridge.listen(0)
  const session = await (
    await fetch(endpoint + "session", { method: "POST", body: "{}" })
  ).json()
  const call = async (action: string, body?: unknown) => {
    const response = await fetch(
      endpoint + `session/${session.id}/${action}`,
      body === undefined
        ? undefined
        : { method: "POST", body: JSON.stringify(body) },
    )
    const value = await response.json()
    assert(response.ok, JSON.stringify(value))
    return value
  }
  const before = await call("status")
  assert.equal(before.sandbox.type, "readOnly")
  assert.equal(before.approvalPolicy, "on-request")
  const permissions = await call("permissions")
  assert(
    permissions.choices.some(
      (choice: any) => choice.id === ":workspace" && choice.allowed,
    ),
  )
  const updated = await call("permissions", { profile: ":workspace" })
  assert.equal(updated.current.activePermissionProfile.id, ":workspace")
  assert.equal(updated.current.sandbox.type, "workspaceWrite")
  assert.equal(updated.current.approvalsReviewer, before.approvalsReviewer)
  const restored = await call("permissions", { profile: ":read-only" })
  assert.equal(restored.current.sandbox.type, "readOnly")
  const inventory = await call("mcp")
  const server = inventory.find((server: any) => server.name === "parity")
  assert(server, "Local MCP server must be discoverable")
  assert.equal(server.runtimeStatus, "connected")
  assert.equal(Object.values(server.tools).length, 1)
  assert.equal(server.resources[0].uri, "notes://parity")
  const result = bridge.rpc.call("mcpServer/tool/call", {
    threadId: threadID(session.id),
    server: "parity",
    tool: "form",
    arguments: {},
  })
  const deadline = Date.now() + 15000
  while (!bridge.approvals.list().length && Date.now() < deadline)
    await Bun.sleep(50)
  const request = bridge.approvals.list()[0]
  assert(request, "Real MCP tool must trigger a native elicitation request")
  assert.equal(request.elicitation?.mode, "form")
  bridge.approvals.decide(request.id, 0, { count: 2, confirm: false })
  const reply = (await result) as { content: { text: string }[] }
  assert.deepEqual(JSON.parse(reply.content[0].text), {
    action: "accept",
    content: { count: 2, confirm: false },
  })
  await call("mcp", { mcpAction: "reload" })
  console.log(
    `PASS: live native status before first turn, scoped permissions and restoration, MCP inventory/resources, real typed elicitation round-trip, reload\nWorkspace: ${cwd}`,
  )
} finally {
  await bridge.close()
}
