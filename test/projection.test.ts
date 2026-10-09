import { expect, test } from "bun:test"
import { Projection, sessionID, threadID } from "../src/projection"
import { agent, command, thread, turn, user } from "./fixtures"
import type { EventInput } from "../src/events"

test("streaming text and output are finalized without duplicate parts", () => {
  const native = thread(),
    events: EventInput[] = [],
    view = new Projection(native, "test", (e) => events.push(e)),
    v = turn([user("hello")])
  view.notification({
    method: "turn/started",
    params: { threadId: native.id, turn: v },
  })
  view.notification({
    method: "item/completed",
    params: {
      threadId: native.id,
      turnId: v.id,
      item: v.items[0],
      completedAtMs: Date.now(),
    },
  })
  view.item(v.id, agent(""), false)
  view.notification({
    method: "item/agentMessage/delta",
    params: {
      threadId: native.id,
      turnId: v.id,
      itemId: "agent",
      delta: "Hello",
    },
  })
  view.item(v.id, command(), false)
  view.notification({
    method: "item/commandExecution/outputDelta",
    params: {
      threadId: native.id,
      turnId: v.id,
      itemId: "command",
      delta: "tool-output\n",
    },
  })
  expect(view.messages()[1].parts[1]).toMatchObject({
    type: "tool",
    state: { status: "running", metadata: { output: "tool-output\n" } },
  })
  view.item(v.id, agent("Hello"), true)
  view.item(v.id, command("completed"), true)
  view.item(v.id, command("completed"), true)
  expect(view.messages()[1].parts).toHaveLength(2)
  expect(view.messages()[1].parts[0]).toMatchObject({
    type: "text",
    text: "Hello",
  })
})
test("failed turns clear busy state and surface a model error", () => {
  const native = thread(),
    events: EventInput[] = [],
    view = new Projection(native, "test", (e) => events.push(e)),
    v = turn([user("hello")])
  view.notification({
    method: "turn/started",
    params: { threadId: native.id, turn: v },
  })
  view.item(v.id, v.items[0], true)
  view.fail(new Error("backend disconnected"))
  expect(view.status).toEqual({ type: "idle" })
  expect(view.activeTurn).toBeUndefined()
  expect(view.messages()[1].info).toMatchObject({
    role: "assistant",
    error: { data: { message: "backend disconnected" } },
  })
  expect(events.some((e) => e.type === "session.error")).toBe(true)
})
test("native UUID and OpenCode session ID round-trip and reject invalid IDs", () => {
  const id = crypto.randomUUID()
  expect(threadID(sessionID(id))).toBe(id)
  expect(() => threadID("ses_invalid")).toThrow("Invalid")
})

test("native settings and subagent status notifications update frontend state", () => {
  const native = thread(),
    events: EventInput[] = []
  const view = new Projection(native, "test", (event) => events.push(event))
  view.notification({
    method: "thread/settings/updated",
    params: {
      threadId: native.id,
      threadSettings: {
        disabledPluginIds: [],
        cwd: native.cwd,
        model: "another-model",
        modelProvider: "openai",
        serviceTier: null,
        approvalPolicy: "on-request",
        approvalsReviewer: "user",
        sandboxPolicy: { type: "readOnly", networkAccess: false },
        activePermissionProfile: null,
        effort: "high",
        summary: null,
        multiAgentMode: "explicitRequestOnly",
        personality: null,
        collaborationMode: {
          mode: "plan",
          settings: {
            model: "another-model",
            reasoning_effort: "high",
            developer_instructions: null,
          },
        },
      },
    },
  })
  expect(view.session).toMatchObject({
    model: { id: "another-model" },
    agent: "plan",
  })
  expect(view.thread.reasoningEffort).toBe("high")
  view.notification({
    method: "thread/status/changed",
    params: {
      threadId: native.id,
      status: { type: "active", activeFlags: ["waitingOnApproval"] },
    },
  })
  expect(view.status.type).toBe("busy")
  expect(view.session.metadata?.codexStatus).toEqual({
    type: "active",
    activeFlags: ["waitingOnApproval"],
  })
  view.notification({
    method: "thread/status/changed",
    params: { threadId: native.id, status: { type: "idle" } },
  })
  expect(view.status.type).toBe("idle")
  expect(
    events.filter((event) => event.type === "session.updated"),
  ).toHaveLength(3)
})
