import { realpathSync } from "node:fs"
import { afterEach, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createOpencodeClient } from "@opencode-ai/sdk/v2"
import { Bridge } from "../src/bridge"
import type { Event } from "@opencode-ai/sdk/v2"

const active: { bridge: Bridge; cwd: string }[] = []
afterEach(async () => {
  for (const item of active.splice(0)) {
    await item.bridge.close()
    await rm(item.cwd, { recursive: true, force: true })
  }
})
async function setup(
  native?: ConstructorParameters<typeof Bridge>[0]["native"],
) {
  const cwd = await mkdtemp(join(tmpdir(), "bridge-test-"))
  const bridge = new Bridge({
    cwd,
    command: [
      Bun.which("bun") ?? process.execPath,
      join(import.meta.dir, "fake-codex.ts"),
    ],
    native,
  })
  active.push({ bridge, cwd })
  const events: Event[] = []
  bridge.onEvent((e) => events.push(e))
  await bridge.initialize()
  const url = bridge.listen(0),
    client = createOpencodeClient({
      baseUrl: url,
      directory: cwd,
      throwOnError: true,
    })
  const session = (await client.session.create()).data!
  const frames = async () =>
    (await readFile(join(cwd, "fixture-rpc.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line)) as {
      method?: string
      params?: Record<string, unknown>
      result?: unknown
    }[]
  return { bridge, cwd, events, url, client, session, frames }
}
const waitFor = async (check: () => boolean | Promise<boolean>) => {
  for (let i = 0; i < 100; i++) {
    if (await check()) return
    await Bun.sleep(10)
  }
  throw new Error("Condition timed out")
}

test("real SDK can bootstrap and receive complete SSE envelopes", async () => {
  const { client, url, session } = await setup()
  const providers = (await client.config.providers()).data!
  expect(providers.providers[0].models.test.name).toBe("Test Codex")
  expect((await client.provider.list()).data!.connected).toEqual(["codex"])
  expect(
    (await fetch(url + "config", { method: "PATCH", body: "{}" })).status,
  ).toBe(501)
  expect((await client.app.agents()).data!.map((a) => a.name)).toEqual([
    "codex",
    "plan",
  ])
  const abort = new AbortController()
  const events = await client.global.event({
    signal: abort.signal,
    sseMaxRetryAttempts: 0,
  })
  try {
    for await (const event of events.stream) {
      expect(event.directory).toBeDefined()
      expect(event.payload.type).toBe("server.connected")
      expect(event.payload.id).toStartWith("evt_")
      break
    }
  } finally {
    abort.abort()
  }
  expect(
    (
      await fetch(url + `session/${session.id}/revert`, {
        method: "POST",
        body: "{}",
      })
    ).status,
  ).toBe(501)
})
test("Codex configuration is inherited without permission overrides", async () => {
  const { frames } = await setup()
  const start = (await frames()).find((f) => f.method === "thread/start")!
  expect(start.params).not.toHaveProperty("approvalPolicy")
  expect(start.params).not.toHaveProperty("sandbox")
  expect(start.params).not.toHaveProperty("approvalsReviewer")
})
test("normal prompting streams assistant content and completes session", async () => {
  const { client, session, events, frames } = await setup()
  await client.session.prompt({
    sessionID: session.id,
    parts: [{ type: "text", text: "hello" }],
  })
  await waitFor(() => events.some((e) => e.type === "session.idle"))
  const rows = (await client.session.messages({ sessionID: session.id })).data!
  expect(rows.map((r) => r.info.role)).toEqual(["user", "assistant"])
  expect(rows[1].parts[0]).toMatchObject({ type: "text", text: "native-reply" })
  expect(
    (await frames()).find((f) => f.method === "turn/start")!.params
      ?.collaborationMode,
  ).toMatchObject({
    mode: "default",
    settings: { developer_instructions: null },
  })
})
test("Plan and model effort use native collaboration mode fields", async () => {
  const { client, session, frames } = await setup()
  await client.session.prompt({
    sessionID: session.id,
    agent: "plan",
    model: { providerID: "codex", modelID: "test" },
    variant: "low",
    parts: [{ type: "text", text: "hello" }],
  })
  expect(
    (await frames()).find((f) => f.method === "turn/start")!.params
      ?.collaborationMode,
  ).toEqual({
    mode: "plan",
    settings: {
      model: "test",
      reasoning_effort: "low",
      developer_instructions: null,
    },
  })
})
test("busy prompt is steering with the expected turn; interrupt becomes idle", async () => {
  const { client, session, frames } = await setup()
  await client.session.prompt({
    sessionID: session.id,
    parts: [{ type: "text", text: "long" }],
  })
  await client.session.prompt({
    sessionID: session.id,
    parts: [{ type: "text", text: "adjust" }],
  })
  const steer = (await frames()).find((f) => f.method === "turn/steer")!
  expect(steer.params?.expectedTurnId).toBeString()
  expect(
    (await frames()).filter((f) => f.method === "turn/start"),
  ).toHaveLength(1)
  await client.session.abort({ sessionID: session.id })
  expect((await client.session.status()).data![session.id]).toEqual({
    type: "idle",
  })
})
test("native approval offers exact choices and never auto-accepts", async () => {
  const { bridge, client, session, frames, url } = await setup()
  await client.session.prompt({
    sessionID: session.id,
    parts: [{ type: "text", text: "approve" }],
  })
  await waitFor(() => bridge.approvals.list().length > 0)
  const request = bridge.approvals.list()[0]
  expect(request.decisions.map((c) => c.title)).toEqual([
    "Allow once",
    "Decline",
    "Cancel turn",
  ])
  expect((await frames()).filter((f) => "result" in f)).toHaveLength(0)
  const bad = await fetch(url + `bridge/requests/${request.id}/reply`, {
    method: "POST",
    body: JSON.stringify({ choice: 4 }),
  })
  expect(bad.status).toBe(400)
  await client.permission.reply({ requestID: request.id, reply: "once" })
  await waitFor(() => bridge.approvals.list().length === 0)
  expect((await frames()).find((f) => "result" in f)?.result).toEqual({
    decision: "accept",
  })
  const rows = (await client.session.messages({ sessionID: session.id })).data!
  expect(
    rows.flatMap((r) => r.parts).find((p) => p.type === "tool"),
  ).toMatchObject({
    type: "tool",
    state: { status: "completed", output: "tool-output\n" },
  })
})
test("OpenCode always cannot invent a native persistent permission", async () => {
  const { bridge, client, session, url } = await setup()
  await client.session.prompt({
    sessionID: session.id,
    parts: [{ type: "text", text: "approve" }],
  })
  await waitFor(() => bridge.approvals.list().length > 0)
  const id = bridge.approvals.list()[0].id
  const denied = await fetch(url + `permission/${id}/reply`, {
    method: "POST",
    body: JSON.stringify({ reply: "always" }),
  })
  expect(denied.status).toBe(400)
  expect(bridge.approvals.list()).toHaveLength(1)
  bridge.approvals.decide(id, 1)
})
test("questions preserve native IDs and answer arrays", async () => {
  const { bridge, client, session, frames, events } = await setup()
  await client.session.prompt({
    sessionID: session.id,
    parts: [{ type: "text", text: "ask" }],
  })
  await waitFor(() => bridge.approvals.questions().length > 0)
  const question = bridge.approvals.questions()[0]
  expect(question.questions[0].custom).toBe(true)
  await client.question.reply({ requestID: question.id, answers: [["A"]] })
  expect(events.find((e) => e.type === "question.replied")).toMatchObject({
    properties: { answers: [["A"]] },
  })
  expect((await frames()).find((f) => "result" in f)?.result).toEqual({
    answers: { "native-question": { answers: ["A"] } },
  })
})
test("fork history has distinct message and part IDs; restart resumes native state", async () => {
  const { bridge, cwd, client, session, events, frames } = await setup()
  await client.session.prompt({
    sessionID: session.id,
    parts: [{ type: "text", text: "hello" }],
  })
  await waitFor(() => events.some((e) => e.type === "session.idle"))
  const original = (await client.session.messages({ sessionID: session.id }))
    .data!
  const fork = (await client.session.fork({ sessionID: session.id })).data!,
    forkRows = (await client.session.messages({ sessionID: fork.id })).data!
  expect(forkRows[0].info.id).not.toBe(original[0].info.id)
  expect(forkRows[0].parts[0].id).not.toBe(original[0].parts[0].id)
  await bridge.close()
  const restart = new Bridge({
    cwd,
    command: [process.execPath, join(import.meta.dir, "fake-codex.ts")],
  })
  active.push({ bridge: restart, cwd })
  await restart.initialize()
  const restarted = createOpencodeClient({
    baseUrl: restart.listen(0),
    throwOnError: true,
  })
  const rows = (await restarted.session.messages({ sessionID: session.id }))
    .data!
  expect(rows[1].parts[0]).toMatchObject({ type: "text", text: "native-reply" })
  expect(
    (await frames()).findLast((f) => f.method === "thread/resume")?.params?.cwd,
  ).toBe(realpathSync(cwd))
})
test("compact, review and goals call native methods", async () => {
  const { client, session, frames } = await setup()
  await client.session.summarize({
    sessionID: session.id,
    providerID: "codex",
    modelID: "test",
  })
  await client.session.command({
    sessionID: session.id,
    command: "review",
    arguments: "Inspect concurrency",
  })
  await client.session.command({
    sessionID: session.id,
    command: "goal",
    arguments: "Finish feature",
  })
  const calls = await frames()
  expect(calls.some((f) => f.method === "thread/compact/start")).toBe(true)
  expect(
    calls.find((f) => f.method === "review/start")?.params?.target,
  ).toEqual({ type: "custom", instructions: "Inspect concurrency" })
  expect(
    calls.find((f) => f.method === "thread/goal/set")?.params,
  ).toMatchObject({ objective: "Finish feature", origin: "user" })
})
test("foreign origins cannot invoke the local bridge", async () => {
  const { url } = await setup()
  expect(
    (
      await fetch(url + "session", {
        method: "POST",
        headers: { Origin: "https://example.com" },
        body: "{}",
      })
    ).status,
  ).toBe(403)
})

test("fast completion does not leave a stale active turn; paginated history loads all pages", async () => {
  const { bridge, cwd, client, session, frames } = await setup()
  await client.session.prompt({
    sessionID: session.id,
    parts: [{ type: "text", text: "paginated first" }],
  })
  await client.session.prompt({
    sessionID: session.id,
    parts: [{ type: "text", text: "paginated second" }],
  })
  expect(
    (await frames()).filter((f) => f.method === "turn/start"),
  ).toHaveLength(2)
  expect(
    (await frames()).filter((f) => f.method === "turn/steer"),
  ).toHaveLength(0)
  await bridge.close()
  const restart = new Bridge({
    cwd,
    command: [process.execPath, join(import.meta.dir, "fake-codex.ts")],
  })
  active.push({ bridge: restart, cwd })
  await restart.initialize()
  const restarted = createOpencodeClient({
    baseUrl: restart.listen(0),
    throwOnError: true,
  })
  const rows = (await restarted.session.messages({ sessionID: session.id }))
    .data!
  expect(rows.filter((r) => r.info.role === "user")).toHaveLength(2)
  expect(
    (await frames()).filter((f) => f.method === "thread/turns/list"),
  ).toHaveLength(2)
})

test("an unrelated subagent completion leaves the main approval pending", async () => {
  const { bridge, client, session } = await setup()
  await client.session.prompt({
    sessionID: session.id,
    parts: [{ type: "text", text: "approve subagent" }],
  })
  await waitFor(() => bridge.approvals.list().length > 0)
  expect(bridge.approvals.list()[0].sessionID).toBe(session.id)
  expect((await client.permission.list()).data).toHaveLength(1)
  bridge.approvals.decide(bridge.approvals.list()[0].id, 1)
})

const post = (url: string, body: unknown) =>
  fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })

test("status reads live native settings and usage without inventing context or limits", async () => {
  const { url, session, client, frames } = await setup()
  const endpoint = url + `session/${session.id}/status`
  const first = await (await fetch(endpoint)).json()
  expect(first).toMatchObject({
    model: "test",
    reasoningEffort: "low",
    approvalPolicy: "on-request",
    approvalsReviewer: "user",
    activePermissionProfile: { id: ":read-only" },
    account: { type: "chatgpt" },
    tokenUsage: null,
    rateLimits: { ordinaryUsageAllowed: true },
  })
  await client.session.prompt({
    sessionID: session.id,
    parts: [{ type: "text", text: "usage" }],
  })
  const second = await (await fetch(endpoint)).json()
  expect(second.tokenUsage).toMatchObject({
    modelContextWindow: 128000,
    last: { inputTokens: 100, cachedInputTokens: 40, outputTokens: 20 },
  })
  for (const frame of (await frames()).filter(
    (f) => f.method === "thread/resume",
  ))
    expect(frame.params).toEqual({
      threadId: session.metadata!.codexThreadID,
      excludeTurns: true,
    })
})

test("permissions paginate native profiles, enforce requirements, and change only this thread", async () => {
  const { url, session, frames } = await setup()
  const endpoint = url + `session/${session.id}/permissions`
  const available = await (await fetch(endpoint)).json()
  expect(
    available.choices.map((choice: any) => [choice.id, choice.allowed]),
  ).toEqual([
    [":read-only", true],
    [":workspace", true],
    [":danger-full-access", false],
  ])
  expect((await post(endpoint, { profile: ":danger-full-access" })).ok).toBe(
    false,
  )
  expect((await post(endpoint, { approvalPolicy: "never" })).ok).toBe(false)
  expect(
    (await post(endpoint, { profile: ":workspace", sandbox: "read-only" })).ok,
  ).toBe(false)
  expect(
    (await frames()).filter((f) => f.method === "thread/settings/update"),
  ).toHaveLength(0)
  const updated = await (
    await post(endpoint, { profile: ":workspace", approvalPolicy: "untrusted" })
  ).json()
  expect(updated.current).toMatchObject({
    activePermissionProfile: { id: ":workspace" },
    approvalPolicy: "untrusted",
    approvalsReviewer: "user",
    sandbox: { type: "workspaceWrite" },
  })
  expect(
    (await frames())
      .filter((f) => f.method === "thread/settings/update")
      .map((f) => f.params),
  ).toEqual([
    {
      threadId: session.metadata!.codexThreadID,
      permissions: ":workspace",
      approvalPolicy: "untrusted",
    },
  ])
  expect(
    (await frames()).some(
      (f) => f.method?.startsWith("config/") && f.method.includes("write"),
    ),
  ).toBe(false)
})

test("permissions cannot change while a native turn is running", async () => {
  const { url, session, client, frames } = await setup()
  await client.session.prompt({
    sessionID: session.id,
    parts: [{ type: "text", text: "long" }],
  })
  const response = await post(url + `session/${session.id}/permissions`, {
    profile: ":workspace",
  })
  expect(response.ok).toBe(false)
  expect(await response.text()).toContain("current turn")
  expect(
    (await frames()).some((f) => f.method === "thread/settings/update"),
  ).toBe(false)
})

test("MCP inventory paginates and native login and reload use the correct scope", async () => {
  const { url, session, frames } = await setup()
  const endpoint = url + `session/${session.id}/mcp`
  const inventory = await (await fetch(endpoint)).json()
  expect(inventory.map((server: any) => server.name)).toEqual([
    "fixture",
    "second",
  ])
  expect(inventory[0]).toMatchObject({
    tools: { echo: { name: "echo" } },
    resources: [{ uri: "notes://current" }],
    authStatus: "notLoggedIn",
  })
  expect(
    (await post(endpoint, { mcpAction: "login", serverName: "missing" })).ok,
  ).toBe(false)
  expect(
    await (
      await post(endpoint, { mcpAction: "login", serverName: "fixture" })
    ).json(),
  ).toMatchObject({ authorizationUrl: "https://example.com/authorize" })
  expect((await post(endpoint, { mcpAction: "reload" })).ok).toBe(true)
  const native = await frames()
  expect(
    native.find((f) => f.method === "mcpServer/oauth/login")?.params,
  ).toEqual({ threadId: session.metadata!.codexThreadID, name: "fixture" })
  expect(
    native.find((f) => f.method === "config/mcpServer/reload")?.params,
  ).toBeUndefined()
  expect(
    native
      .filter((f) => f.method === "mcpServerStatus/list")
      .every(
        (f) =>
          f.params?.threadId === session.metadata!.codexThreadID &&
          (f.params?.detail === "full" ||
            (f.params?.detail === "toolsAndAuthOnly" && f.params?.serverName)),
      ),
  ).toBe(true)
})

for (const mode of ["elicitation", "elicitation openai"])
  test(`${mode} preserves typed form values and leaves invalid responses pending`, async () => {
    const { bridge, url, client, session, frames } = await setup()
    await client.session.prompt({
      sessionID: session.id,
      parts: [{ type: "text", text: mode }],
    })
    await waitFor(() => bridge.approvals.list().length > 0)
    const request = bridge.approvals.list()[0]
    expect(request.elicitation?.mode).toBe("form")
    expect(bridge.approvals.permissions()).toHaveLength(0)
    const endpoint = url + `bridge/requests/${request.id}/reply`
    for (const content of [
      undefined,
      {},
      { name: "Joe", count: "2", confirm: true, color: "red" },
      { name: "Joe", count: 9, confirm: true, color: "green" },
    ]) {
      expect((await post(endpoint, { choice: 0, content })).ok).toBe(false)
      expect(bridge.approvals.list()).toHaveLength(1)
    }
    expect(
      (await frames()).filter((f) => f.result && (f.result as any).action),
    ).toHaveLength(0)
    const content = { name: "Joe", count: 2, confirm: false, color: "blue" }
    expect((await post(endpoint, { choice: 0, content })).ok).toBe(true)
    await waitFor(() => bridge.approvals.list().length === 0)
    await waitFor(async () =>
      (await frames()).some((f) => f.result && (f.result as any).action),
    )
    expect(
      (await frames())
        .filter((f) => f.result && (f.result as any).action)
        .at(-1)?.result,
    ).toEqual({ action: "accept", content, _meta: null })
  })

for (const choice of [1, 2])
  test(`MCP form choice ${choice} preserves decline/cancel without content`, async () => {
    const { bridge, url, client, session, frames } = await setup()
    await client.session.prompt({
      sessionID: session.id,
      parts: [{ type: "text", text: "elicitation" }],
    })
    await waitFor(() => bridge.approvals.list().length > 0)
    const request = bridge.approvals.list()[0]
    expect(
      (await post(url + `bridge/requests/${request.id}/reply`, { choice })).ok,
    ).toBe(true)
    await waitFor(() => bridge.approvals.list().length === 0)
    await waitFor(async () =>
      (await frames()).some((f) => f.result && (f.result as any).action),
    )
    expect(
      (await frames())
        .filter((f) => f.result && (f.result as any).action)
        .at(-1)?.result,
    ).toEqual({
      action: choice === 1 ? "decline" : "cancel",
      content: null,
      _meta: null,
    })
  })

test("MCP URL elicitation requires an explicit response and retains the URL", async () => {
  const { bridge, url, client, session, frames } = await setup()
  await client.session.prompt({
    sessionID: session.id,
    parts: [{ type: "text", text: "elicitation url" }],
  })
  await waitFor(() => bridge.approvals.list().length > 0)
  const request = bridge.approvals.list()[0]
  expect(request.elicitation).toEqual({
    mode: "url",
    url: "https://example.com/verify",
  })
  expect(
    (await frames()).filter((f) => f.result && (f.result as any).action),
  ).toHaveLength(0)
  expect(
    (await post(url + `bridge/requests/${request.id}/reply`, { choice: 0 })).ok,
  ).toBe(true)
  await waitFor(() => bridge.approvals.list().length === 0)
  await waitFor(async () =>
    (await frames()).some((f) => f.result && (f.result as any).action),
  )
  expect(
    (await frames()).filter((f) => f.result && (f.result as any).action).at(-1)
      ?.result,
  ).toEqual({ action: "accept", content: null, _meta: null })
})

test("native subagent navigation includes descendants and their root without adopting unrelated threads", async () => {
  const { url, session, client, frames } = await setup({ sandbox: "read-only" })
  const unrelated = (await client.session.create()).data!
  await client.session.prompt({
    sessionID: session.id,
    parts: [{ type: "text", text: "spawn" }],
  })
  const agents = await (
    await fetch(url + `session/${session.id}/agents`)
  ).json()
  expect(agents).toHaveLength(3)
  expect(agents.map((agent: any) => agent.id)).not.toContain(unrelated.id)
  const child = agents.find(
    (agent: any) => agent.metadata.codexAgentNickname === "Scout",
  )
  const nested = agents.find(
    (agent: any) => agent.metadata.codexAgentNickname === "Nested",
  )
  const children = (await client.session.children({ sessionID: session.id }))
    .data!
  expect(children.map((agent) => agent.id)).toEqual([child.id])
  expect(
    (await client.session.children({ sessionID: child.id })).data!.map(
      (agent) => agent.id,
    ),
  ).toEqual([nested.id])
  expect(
    (await client.session.get({ sessionID: child.id })).data!.directory,
  ).toBe("/tmp")
  const resume = (await frames()).filter(
    (f) =>
      f.method === "thread/resume" &&
      f.params?.threadId === child.metadata.codexThreadID,
  )[0]
  expect(resume.params).not.toHaveProperty("cwd")
  expect(resume.params).not.toHaveProperty("sandbox")
  const fromChild = await (
    await fetch(url + `session/${nested.id}/agents`)
  ).json()
  expect(fromChild.map((agent: any) => agent.id)).toEqual(
    agents.map((agent: any) => agent.id),
  )
  expect(
    (
      await post(url + `session/${child.id}/permissions`, {
        profile: ":workspace",
      })
    ).ok,
  ).toBe(false)
  await expect(
    client.session.prompt({
      sessionID: child.id,
      parts: [{ type: "text", text: "hello" }],
    }),
  ).rejects.toThrow()
  expect(
    (await frames()).some(
      (f) =>
        f.method === "turn/start" &&
        f.params?.threadId === child.metadata.codexThreadID,
    ),
  ).toBe(false)
})

test("status remains usable when account and limit discovery fail", async () => {
  const { url, session, cwd } = await setup()
  await writeFile(join(cwd, "fixture-account-unavailable"), "")
  const response = await fetch(url + `session/${session.id}/status`)
  expect(response.ok).toBe(true)
  const status = await response.json()
  expect(status).toMatchObject({
    model: "test",
    account: null,
    rateLimits: null,
    accountError: "Account unavailable",
    rateLimitsError: "Limits unavailable",
  })
})
