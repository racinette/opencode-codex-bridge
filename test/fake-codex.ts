import { thread, turn, user, agent, command, model } from "./fixtures"
import type { Thread } from "../src/protocol/v2/Thread"
import type { Turn } from "../src/protocol/v2/Turn"
import type { ClientRequest } from "../src/protocol/ClientRequest"
import {
  appendFileSync,
  existsSync,
  readFileSync,
  writeFileSync,
} from "node:fs"
const statePath = "fixture-state.json"
const threads = new Map<string, Thread>(
  existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : [],
)
const settings = new Map<string, Record<string, unknown>>()
const nativeSettings = (t: Thread) => ({
  cwd: t.cwd,
  model: "test",
  reasoningEffort: "low",
  serviceTier: null,
  approvalPolicy: "on-request",
  approvalsReviewer: "user",
  sandbox: { type: "readOnly", networkAccess: false },
  activePermissionProfile: { id: ":read-only", extends: null },
  runtimeWorkspaceRoots: [t.cwd],
  collaborationMode: null,
  ...settings.get(t.id),
})
const formSchema = {
  type: "object",
  properties: {
    name: { type: "string", minLength: 1 },
    count: { type: "integer", minimum: 1, maximum: 5 },
    confirm: { type: "boolean" },
    color: { type: "string", enum: ["red", "blue"] },
  },
  required: ["name", "count", "confirm", "color"],
  additionalProperties: false,
}
const mcpServer = (name: string) => ({
  name,
  runtimeStatus: "connected",
  pluginId: null,
  httpOrigin: "https://example.com",
  serverInfo: null,
  serverCapabilities: { elicitation: {} },
  toolsError: null,
  authStatus: "notLoggedIn",
  tools: {
    echo: {
      name: "echo",
      description: "Echo tool",
      inputSchema: { type: "object" },
    },
  },
  resources: [{ name: "notes", uri: "notes://current" }],
  resourceTemplates: [],
})
const pending = new Map<number, { thread: Thread; turn: Turn; kind: string }>()
const save = () => writeFileSync(statePath, JSON.stringify([...threads]))
const send = (frame: unknown) =>
  process.stdout.write(JSON.stringify(frame) + "\n")
const notice = (method: string, params: unknown) => send({ method, params })
const done = (t: Thread, v: Turn) => {
  const item = agent("native-reply", crypto.randomUUID())
  v.items.push(item)
  notice("item/completed", { threadId: t.id, turnId: v.id, item })
  v.status = "completed"
  v.completedAt = 1700000001
  save()
  notice("turn/completed", { threadId: t.id, turn: v })
}
let buffer = "",
  nextRequest = 1000
for await (const chunk of Bun.stdin.stream()) {
  buffer += new TextDecoder().decode(chunk)
  for (;;) {
    const pos = buffer.indexOf("\n")
    if (pos < 0) break
    const line = buffer.slice(0, pos)
    buffer = buffer.slice(pos + 1)
    if (!line) continue
    const frame = JSON.parse(line) as
      | ClientRequest
      | { id: number | string; result: unknown }
    appendFileSync("fixture-rpc.jsonl", line + "\n")
    if (!("method" in frame)) {
      const task = pending.get(Number(frame.id))
      if (!task) continue
      pending.delete(Number(frame.id))
      notice("serverRequest/resolved", {
        threadId: task.thread.id,
        requestId: frame.id,
      })
      if (task.kind === "approval") {
        const item = command("completed", crypto.randomUUID())
        task.turn.items.push(item)
        notice("item/completed", {
          threadId: task.thread.id,
          turnId: task.turn.id,
          item,
        })
      }
      done(task.thread, task.turn)
      continue
    }
    const reply = (result: unknown) => send({ id: frame.id, result })
    switch (frame.method) {
      case "initialize":
        reply({
          userAgent: "fixture",
          platformFamily: "unix",
          platformOs: "macos",
        })
        break
      case "model/list":
        reply({ data: [model], nextCursor: null })
        break
      case "permissionProfile/list":
        reply({
          data: frame.params.cursor
            ? [
                {
                  id: ":danger-full-access",
                  description: "Full access",
                  allowed: false,
                },
              ]
            : [
                { id: ":read-only", description: "Read only", allowed: true },
                {
                  id: ":workspace",
                  description: "Workspace write",
                  allowed: true,
                },
              ],
          nextCursor: frame.params.cursor ? null : "profiles-more",
        })
        break
      case "configRequirements/read":
        reply({
          requirements: {
            allowedApprovalPolicies: ["on-request", "untrusted"],
          },
        })
        break
      case "account/read":
        if (existsSync("fixture-account-unavailable")) {
          send({
            id: frame.id,
            error: { code: -1, message: "Account unavailable" },
          })
          break
        }
        reply({
          account: {
            type: "chatgpt",
            email: "fixture@example.com",
            planType: "plus",
          },
          requiresOpenaiAuth: true,
        })
        break
      case "account/rateLimits/read":
        if (existsSync("fixture-account-unavailable")) {
          send({
            id: frame.id,
            error: { code: -1, message: "Limits unavailable" },
          })
          break
        }
        reply({
          rateLimits: {
            limitName: "Codex",
            primary: {
              usedPercent: 12,
              windowDurationMins: 300,
              resetsAt: 1800000000,
            },
            secondary: null,
          },
          rateLimitsByLimitId: null,
          ordinaryUsageAllowed: true,
        })
        break
      case "thread/settings/update": {
        const { threadId, permissions, approvalPolicy, sandboxPolicy } =
          frame.params
        const previous = settings.get(threadId) ?? {}
        settings.set(threadId, {
          ...previous,
          ...(permissions
            ? {
                activePermissionProfile: { id: permissions, extends: null },
                sandbox:
                  permissions === ":workspace"
                    ? {
                        type: "workspaceWrite",
                        writableRoots: [],
                        networkAccess: false,
                        excludeTmpdirEnvVar: false,
                        excludeSlashTmp: false,
                      }
                    : { type: "readOnly", networkAccess: false },
              }
            : {}),
          ...(approvalPolicy ? { approvalPolicy } : {}),
          ...(sandboxPolicy ? { sandbox: sandboxPolicy } : {}),
        })
        const current = nativeSettings(threads.get(threadId)!)
        notice("thread/settings/updated", {
          threadId,
          threadSettings: {
            ...current,
            sandboxPolicy: current.sandbox,
            effort: current.reasoningEffort,
            collaborationMode: {
              mode: "default",
              settings: {
                model: "test",
                reasoning_effort: "low",
                developer_instructions: null,
              },
            },
          },
        })
        reply({})
        break
      }
      case "mcpServerStatus/list":
        if (frame.params.serverName) {
          reply({
            data: ["fixture", "second"].includes(frame.params.serverName)
              ? [mcpServer(frame.params.serverName)]
              : [],
            nextCursor: null,
          })
          break
        }
        reply({
          data: [mcpServer(frame.params.cursor ? "second" : "fixture")],
          nextCursor: frame.params.cursor ? null : "mcp-more",
        })
        break
      case "mcpServer/oauth/login":
        reply({
          authorizationUrl: "https://example.com/authorize",
          loginId: "fixture-login",
        })
        break
      case "config/mcpServer/reload":
        reply({})
        break
      case "config/read":
        reply({ config: { model: "test" } })
        break
      case "thread/list": {
        const data = [...threads.values()]
        const paginated = !!(
          frame.params.parentThreadId || frame.params.ancestorThreadId
        )
        reply({
          data: !paginated
            ? data
            : frame.params.cursor
              ? data.slice(2)
              : data.slice(0, 2),
          nextCursor:
            paginated && !frame.params.cursor && data.length > 2
              ? "threads-more"
              : null,
        })
        break
      }
      case "thread/start": {
        const t = thread(frame.params.cwd ?? process.cwd())
        threads.set(t.id, t)
        save()
        notice("thread/started", { thread: t })
        reply({ thread: t, ...nativeSettings(t) })
        break
      }
      case "thread/read":
      case "thread/resume": {
        const t = threads.get(frame.params.threadId)
        if (!t) {
          send({
            id: frame.id,
            error: { code: -1, message: "Thread not found" },
          })
          break
        }
        if (
          frame.method === "thread/resume" &&
          t.turns.length === 0 &&
          !t.parentThreadId
        ) {
          send({
            id: frame.id,
            error: {
              code: -1,
              message: `no rollout found for thread id ${t.id}`,
            },
          })
          break
        }
        const exclude =
          frame.method === "thread/resume"
            ? frame.params.excludeTurns
            : !frame.params.includeTurns
        reply({
          thread: exclude ? { ...t, turns: [] } : t,
          ...nativeSettings(t),
        })
        break
      }
      case "thread/turns/list": {
        const turns = threads.get(frame.params.threadId)?.turns ?? []
        reply({
          data: frame.params.cursor ? turns.slice(1) : turns.slice(0, 1),
          nextCursor: !frame.params.cursor && turns.length > 1 ? "more" : null,
        })
        break
      }
      case "thread/fork": {
        const source = threads.get(frame.params.threadId)!
        const t = {
          ...structuredClone(source),
          id: crypto.randomUUID(),
          forkedFromId: source.id,
        }
        threads.set(t.id, t)
        save()
        reply({ thread: t, ...nativeSettings(t) })
        break
      }
      case "thread/name/set": {
        const t = threads.get(frame.params.threadId)!
        t.name = frame.params.name
        save()
        reply({})
        notice("thread/name/updated", { threadId: t.id, threadName: t.name })
        break
      }
      case "turn/start": {
        const t = threads.get(frame.params.threadId)!,
          v = turn([
            user(
              frame.params.input
                .filter((i) => i.type === "text")
                .map((i) => i.text)
                .join("\n"),
              crypto.randomUUID(),
            ),
          ])
        v.startedAt = 1700000000 + t.turns.length * 2
        t.turns.push(v)
        notice("turn/started", { threadId: t.id, turn: v })
        notice("item/completed", {
          threadId: t.id,
          turnId: v.id,
          item: v.items[0],
        })
        reply({ turn: v })
        save()
        const text = JSON.stringify(frame.params.input)
        if (text.includes("paginated")) {
          t.historyMode = "paginated"
          save()
        }
        if (text.includes("usage")) {
          const counts = {
            inputTokens: 100,
            cachedInputTokens: 40,
            cacheWriteInputTokens: 0,
            outputTokens: 20,
            reasoningOutputTokens: 10,
            totalTokens: 120,
          }
          notice("thread/tokenUsage/updated", {
            threadId: t.id,
            turnId: v.id,
            tokenUsage: {
              last: counts,
              total: counts,
              modelContextWindow: 128000,
            },
          })
        }
        if (text.includes("spawn")) {
          const child = thread("/tmp", crypto.randomUUID())
          child.parentThreadId = t.id
          child.source = {
            subAgent: {
              thread_spawn: {
                parent_thread_id: t.id,
                depth: 1,
                agent_path: null,
                agent_nickname: "Scout",
                agent_role: "explorer",
              },
            },
          }
          child.turns = [
            {
              ...turn([agent("SCOUT_RESULT")]),
              status: "completed",
              completedAt: 1700000001,
            },
          ]
          child.agentNickname = "Scout"
          child.agentRole = "explorer"
          child.canAcceptDirectInput = false
          const nested = {
            ...structuredClone(child),
            id: crypto.randomUUID(),
            parentThreadId: child.id,
            agentNickname: "Nested",
          }
          threads.set(child.id, child)
          threads.set(nested.id, nested)
          save()
        }
        if (text.includes("elicitation")) {
          const id = nextRequest++
          pending.set(id, { thread: t, turn: v, kind: "elicitation" })
          send({
            id,
            method: "mcpServer/elicitation/request",
            params: {
              threadId: t.id,
              turnId: v.id,
              serverName: "fixture",
              message: "Provide fixture form",
              ...(text.includes("url")
                ? {
                    mode: "url",
                    url: "https://example.com/verify",
                    elicitationId: "flow",
                  }
                : {
                    mode: text.includes("openai") ? "openai/form" : "form",
                    requestedSchema: formSchema,
                  }),
            },
          })
          break
        }
        if (text.includes("long")) break
        if (text.includes("approve")) {
          const id = nextRequest++
          pending.set(id, { thread: t, turn: v, kind: "approval" })
          send({
            id,
            method: "item/commandExecution/requestApproval",
            params: {
              threadId: t.id,
              turnId: v.id,
              itemId: "command",
              environmentId: null,
              startedAtMs: Date.now(),
              command: "echo tool-output",
              cwd: t.cwd,
              availableDecisions: ["accept", "decline", "cancel"],
            },
          })
          if (text.includes("subagent")) {
            const other = turn()
            other.status = "completed"
            notice("turn/completed", {
              threadId: crypto.randomUUID(),
              turn: other,
            })
          }
        } else if (text.includes("ask")) {
          const id = nextRequest++
          pending.set(id, { thread: t, turn: v, kind: "question" })
          send({
            id,
            method: "item/tool/requestUserInput",
            params: {
              threadId: t.id,
              turnId: v.id,
              itemId: "question",
              isBlocking: true,
              autoResolutionMs: null,
              questions: [
                {
                  id: "native-question",
                  header: "Choice",
                  question: "Which?",
                  isOther: true,
                  isSecret: false,
                  options: [{ label: "A", description: "Choice A" }],
                },
              ],
            },
          })
        } else done(t, v)
        break
      }
      case "turn/steer": {
        const t = threads.get(frame.params.threadId)!,
          v = t.turns.at(-1)!
        if (v.id !== frame.params.expectedTurnId) {
          send({ id: frame.id, error: { code: -1, message: "Turn mismatch" } })
          break
        }
        reply({ turnId: v.id })
        break
      }
      case "turn/interrupt": {
        const t = threads.get(frame.params.threadId)!,
          v = t.turns.at(-1)!
        v.status = "interrupted"
        save()
        notice("turn/completed", { threadId: t.id, turn: v })
        reply({})
        break
      }
      case "thread/compact/start":
        reply({})
        break
      case "review/start":
        reply({ turn: turn(), reviewThreadId: frame.params.threadId })
        break
      case "thread/goal/set":
      case "thread/goal/get":
      case "thread/goal/clear":
        reply({})
        break
      default:
        if ("id" in frame)
          send({
            id: frame.id,
            error: { code: -32601, message: "Unknown method" },
          })
    }
  }
}
