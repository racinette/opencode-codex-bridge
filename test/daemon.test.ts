import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { CodexRpc } from "../src/rpc"
import { daemonProxyCommand } from "../src/daemon"

test("daemon transport preserves RPC requests and leaves its server alive on close", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-daemon-test-"))
  const socketPath = join(directory, "control.sock")
  const replies: unknown[] = []
  let connections = 0
  const server = Bun.serve({
    unix: socketPath,
    fetch(request, server) {
      if (server.upgrade(request)) return
      return new Response("WebSocket required", { status: 400 })
    },
    websocket: {
      open() {
        connections++
      },
      message(socket, message) {
        const frame = JSON.parse(message.toString())
        if (!frame.method) {
          replies.push(frame)
          return
        }
        if (frame.method === "initialized") return
        socket.send(
          JSON.stringify({ id: frame.id, result: { method: frame.method } }),
        )
        if (frame.method === "model/list") {
          socket.send(
            JSON.stringify({
              method: "thread/status/changed",
              params: { threadId: "test", status: { type: "idle" } },
            }),
          )
          socket.send(
            JSON.stringify({
              id: "approval-1",
              method: "item/commandExecution/requestApproval",
              params: { threadId: "test" },
            }),
          )
        }
        if (frame.method === "config/read") socket.close(1000)
      },
    },
  })
  const rpc = new CodexRpc(daemonProxyCommand(socketPath))
  const notices: unknown[] = []
  rpc.onNotification((notice) => notices.push(notice))
  rpc.onRequest((request) => rpc.respond(request.id, { decision: "accept" }))
  try {
    await rpc.initialize()
    expect(
      await rpc.call<"model/list", { method: string }>("model/list", {}),
    ).toEqual({ method: "model/list" })
    const deadline = Date.now() + 3000
    while (replies.length === 0 && Date.now() < deadline) await Bun.sleep(10)
    expect(notices).toHaveLength(1)
    expect(replies).toEqual([
      { id: "approval-1", result: { decision: "accept" } },
    ])
    await rpc.close()
    // A second client can reconnect after closing the first: only the adapter
    // was stopped, and the backend remains available.
    const next = new CodexRpc(daemonProxyCommand(socketPath))
    try {
      await next.initialize()
      expect(
        await next.call<"config/read", { method: string }>("config/read", {}),
      ).toEqual({ method: "config/read" })
      await expect(next.call("thread/list", {})).rejects.toThrow("exited")
    } finally {
      await next.close()
    }
    expect(connections).toBe(2)
  } finally {
    await rpc.close()
    server.stop(true)
    await rm(directory, { recursive: true, force: true })
  }
})

test("missing daemon socket rejects pending RPCs instead of hanging", async () => {
  const rpc = new CodexRpc(
    daemonProxyCommand(`/tmp/absent-codex-${crypto.randomUUID()}.sock`),
  )
  try {
    await expect(rpc.initialize()).rejects.toThrow("exited")
  } finally {
    await rpc.close()
  }
})
