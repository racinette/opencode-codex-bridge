import { Bridge } from "../src/bridge"
import { CodexRpc } from "../src/rpc"
import { mkdtemp, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createOpencodeClient } from "@opencode-ai/sdk/v2"
import type { ThreadReadResponse } from "../src/protocol/v2/ThreadReadResponse"
import type { Event } from "@opencode-ai/sdk/v2"
import { strict as assert } from "node:assert"

const cwd = await mkdtemp(join(tmpdir(), "codex-bridge-smoke-"))
const bridge = new Bridge({
  cwd,
  native: {
    sandbox: "read-only",
    approvalPolicy: "untrusted",
    approvalsReviewer: "user",
  },
})
const events: Event[] = []
bridge.onEvent((event) => events.push(event))
try {
  await bridge.initialize()
  const url = bridge.listen(0)
  const client = createOpencodeClient({
    baseUrl: url,
    directory: cwd,
    throwOnError: true,
  })
  const session = (await client.session.create()).data!
  console.log(
    `SESSION ${session.id} THREAD ${session.metadata?.codexThreadID} CWD ${cwd}`,
  )
  await client.session.prompt({
    sessionID: session.id,
    parts: [
      {
        type: "text",
        text: "Run python3 -c \"from pathlib import Path; Path('proof.txt').write_text('native-codex-ok'); print('TOOL_OUTPUT_OK')\". Request approval if needed. Then reply exactly LIVE_SMOKE_OK.",
      },
    ],
  })
  const deadline = Date.now() + 120000
  let approved = false
  while (Date.now() < deadline) {
    const requests = bridge.approvals.list()
    for (const request of requests) {
      console.log(`APPROVAL ${request.method}: ${request.title}`)
      assert(request.details.includes("python3"))
      const choice = request.decisions.findIndex(
        (c) => JSON.stringify(c.result) === '{"decision":"accept"}',
      )
      assert(choice >= 0, "Native one-time approval must be available")
      bridge.approvals.decide(request.id, choice)
      approved = true
    }
    const status = (await client.session.status()).data!
    if (status[session.id]?.type === "idle") break
    await Bun.sleep(100)
  }
  const messages = (await client.session.messages({ sessionID: session.id }))
    .data!
  assert(
    events.some((e) => e.type === "session.idle"),
    "Turn must complete",
  )
  assert(approved, "Live native approval must have been handled")
  assert(
    messages.some((row) =>
      row.parts.some(
        (p) =>
          p.type === "tool" &&
          p.state.status === "completed" &&
          p.state.output.includes("TOOL_OUTPUT_OK"),
      ),
    ),
    "Real tool stdout must be projected",
  )
  assert(
    messages.some((row) =>
      row.parts.some(
        (p) => p.type === "text" && p.text.includes("LIVE_SMOKE_OK"),
      ),
    ),
    "Real model reply must be projected",
  )
  assert.equal(
    await readFile(join(cwd, "proof.txt"), "utf8"),
    "native-codex-ok",
  )
  const fork = (await client.session.fork({ sessionID: session.id })).data!
  assert.notEqual(fork.id, session.id)
  assert(
    (await client.session.messages({ sessionID: fork.id })).data!.some(
      (r) => r.info.role === "user",
    ),
    "Fork must contain conversation history",
  )
  await bridge.close()
  const restarted = new Bridge({ cwd })
  try {
    await restarted.initialize()
    const client2 = createOpencodeClient({
      baseUrl: restarted.listen(0),
      directory: cwd,
      throwOnError: true,
    })
    const resumed = (await client2.session.messages({ sessionID: session.id }))
      .data!
    assert(
      resumed.some((r) =>
        r.parts.some(
          (p) => p.type === "text" && p.text.includes("LIVE_SMOKE_OK"),
        ),
      ),
      "History must survive app-server restart",
    )
  } finally {
    await restarted.close()
  }
  const native = new CodexRpc(undefined, cwd)
  try {
    await native.initialize()
    const read = await native.call<"thread/read", ThreadReadResponse>(
      "thread/read",
      {
        threadId: session.metadata!.codexThreadID as string,
        includeTurns: true,
      },
    )
    assert(
      read.thread.turns.some((t) =>
        t.items.some(
          (i) => i.type === "agentMessage" && i.text.includes("LIVE_SMOKE_OK"),
        ),
      ),
      "Native CLI-readable thread must contain response",
    )
  } finally {
    await native.close()
  }
  console.log(
    "PASS: real approval, model reply, tool stdout, file write, native fork, bridge restart, native thread history",
  )
} finally {
  await bridge.close()
}
