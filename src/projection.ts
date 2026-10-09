import type { EventInput } from "./events"
import { createHash } from "node:crypto"
import type {
  AssistantMessage,
  Event,
  Message,
  Part,
  Session,
  SessionStatus,
  ToolPart,
} from "@opencode-ai/sdk/v2"
import type { Thread } from "./protocol/v2/Thread"
import type { ThreadItem } from "./protocol/v2/ThreadItem"
import type { Turn } from "./protocol/v2/Turn"
import type { Notification } from "./rpc"

const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex").slice(0, 20)
export const sessionID = (threadID: string) =>
  "ses_" + threadID.replaceAll("-", "")
export function threadID(id: string) {
  if (!/^ses_[0-9a-f]{32}$/.test(id))
    throw new Error("Invalid Codex session ID")
  const raw = id.slice(4)
  return `${raw.slice(0, 8)}-${raw.slice(8, 12)}-${raw.slice(12, 16)}-${raw.slice(16, 20)}-${raw.slice(20)}`
}
export type Row = { info: Message; parts: Part[] }
export class Projection {
  readonly rows = new Map<string, Row>()
  readonly items = new Map<string, Part>()
  readonly turns = new Map<string, Turn>()
  activeTurn?: string
  loaded = false
  model: string
  agent = "codex"
  mode: "default" | "plan" = "default"
  status: SessionStatus = { type: "idle" }
  constructor(
    public thread: Thread,
    model: string,
    private emit: (event: EventInput) => void,
  ) {
    this.model = thread.model ?? model
  }
  get id() {
    return sessionID(this.thread.id)
  }
  get session(): Session {
    return {
      id: this.id,
      slug: this.thread.id,
      projectID: "codex",
      directory: this.thread.cwd,
      parentID:
        (this.thread.parentThreadId ?? this.thread.forkedFromId)
          ? sessionID((this.thread.parentThreadId ?? this.thread.forkedFromId)!)
          : undefined,
      title: this.thread.name || this.thread.preview || "New Codex session",
      version: "1.18.35",
      agent: this.agent,
      model: { id: this.model, providerID: "codex" },
      metadata: {
        codexThreadID: this.thread.id,
        codexParentThreadID: this.thread.parentThreadId,
        codexAgentNickname: this.thread.agentNickname,
        codexAgentRole: this.thread.agentRole,
        codexCanAcceptDirectInput: this.thread.canAcceptDirectInput,
        codexStatus: this.thread.status,
      },
      time: {
        created: this.thread.createdAt * 1000,
        updated: this.thread.updatedAt * 1000,
      },
    }
  }
  messages() {
    return [...this.rows.values()].sort(
      (a, b) =>
        a.info.time.created - b.info.time.created ||
        a.info.id.localeCompare(b.info.id),
    )
  }
  hydrate(thread: Thread) {
    this.thread = thread
    for (const turn of thread.turns) {
      this.turns.set(turn.id, turn)
      for (const item of turn.items)
        this.item(turn.id, item, turn.status !== "inProgress")
      if (turn.status === "inProgress") {
        this.activeTurn = turn.id
        this.status = { type: "busy" }
      } else this.complete(turn)
    }
  }
  private clock(turnID: string) {
    const turn = this.turns.get(turnID)
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-7/.test(turnID))
      return Number.parseInt(turnID.replaceAll("-", "").slice(0, 12), 16)
    return turn?.startedAt
      ? turn.startedAt * 1000
      : this.thread.createdAt * 1000
  }
  private assistant(turnID: string): Row {
    const created = this.clock(turnID)
    const id = `msg_${created.toString(16)}1${hash(this.id + turnID)}`
    let row = this.rows.get(id)
    if (row) return row
    const parent =
      this.messages()
        .filter((r) => r.info.role === "user")
        .at(-1)?.info.id ?? "msg_" + hash(this.id + turnID + "user")
    const info: AssistantMessage = {
      id,
      sessionID: this.id,
      role: "assistant",
      time: { created },
      parentID: parent,
      modelID: this.model,
      providerID: "codex",
      mode: this.agent,
      agent: this.agent,
      path: { cwd: this.thread.cwd, root: this.thread.cwd },
      cost: 0,
      tokens: {
        input: 0,
        output: 0,
        reasoning: 0,
        cache: { read: 0, write: 0 },
      },
    }
    row = { info, parts: [] }
    this.rows.set(id, row)
    this.emit({
      type: "message.updated",
      properties: { sessionID: this.id, info },
    })
    return row
  }
  private publish(row: Row, part: Part) {
    const index = row.parts.findIndex((p) => p.id === part.id)
    if (index < 0) row.parts.push(part)
    else row.parts[index] = part
    this.emit({
      type: "message.part.updated",
      properties: { sessionID: this.id, part, time: Date.now() },
    })
  }
  item(turnID: string, item: ThreadItem, completed: boolean) {
    if (item.type === "userMessage") {
      const created = this.clock(turnID)
      const id = `msg_${created.toString(16)}0${hash(this.id + item.id)}`
      const old = this.rows.get(id)
      const row: Row = old ?? {
        info: {
          id,
          sessionID: this.id,
          role: "user",
          time: { created },
          agent: this.agent,
          model: { providerID: "codex", modelID: this.model },
        },
        parts: [],
      }
      this.rows.set(id, row)
      this.emit({
        type: "message.updated",
        properties: { sessionID: this.id, info: row.info },
      })
      const text = item.content
        .map((input) =>
          input.type === "text"
            ? input.text
            : "path" in input
              ? `@${input.path}`
              : "[attachment]",
        )
        .join("\n")
      this.publish(row, {
        id: "prt_" + hash(this.id + item.id),
        messageID: id,
        sessionID: this.id,
        type: "text",
        text,
      })
      return
    }
    const row = this.assistant(turnID)
    const existing = this.items.get(item.id)
    const index = row.parts.findIndex((p) => p.id === existing?.id)
    const id =
      existing?.id ??
      `prt_${String(row.parts.length).padStart(6, "0")}${hash(this.id + item.id)}`
    const base = { id, messageID: row.info.id, sessionID: this.id }
    const start =
      existing && (existing.type === "text" || existing.type === "reasoning")
        ? (existing.time?.start ?? this.clock(turnID))
        : this.clock(turnID)
    let part: Part
    if (item.type === "agentMessage" || item.type === "plan")
      part = {
        ...base,
        type: "text",
        text: item.text,
        time: { start, ...(completed ? { end: Date.now() } : {}) },
      }
    else if (item.type === "reasoning")
      part = {
        ...base,
        type: "reasoning",
        text: item.summary.join("\n"),
        time: { start, ...(completed ? { end: Date.now() } : {}) },
      }
    else {
      let tool = "codex",
        title: string = item.type,
        input: Record<string, unknown> = {},
        output = "",
        failed = false
      if (item.type === "commandExecution") {
        tool = "bash"
        title = item.command
        input = { command: item.command, description: item.command }
        output = item.aggregatedOutput ?? ""
        failed = item.status === "failed" || item.status === "declined"
      } else if (item.type === "fileChange") {
        tool = "codex_patch"
        title = "File changes"
        input = { files: item.changes.map((c) => c.path) }
        output = item.changes.map((c) => `${c.path}\n${c.diff}`).join("\n")
        failed = item.status === "failed" || item.status === "declined"
      } else if (item.type === "mcpToolCall") {
        tool = `${item.server}_${item.tool}`
        title = item.tool
        input = { arguments: item.arguments }
        output = item.error?.message ?? JSON.stringify(item.result ?? {})
        failed = item.status === "failed"
      } else if (item.type === "dynamicToolCall") {
        tool = item.tool
        input = { arguments: item.arguments }
        output = JSON.stringify(item.contentItems ?? [])
        failed = item.success === false
      } else if (
        item.type === "enteredReviewMode" ||
        item.type === "exitedReviewMode"
      ) {
        title = "Codex review"
        output = item.review
      } else if (item.type === "contextCompaction") {
        title = "Context compacted"
        output = "Codex compacted this conversation."
      } else {
        input = { kind: item.type }
        output = JSON.stringify(item)
      }
      const oldState = existing?.type === "tool" ? existing.state : undefined
      const toolStart =
        oldState && "time" in oldState ? oldState.time.start : start
      const state: ToolPart["state"] = !completed
        ? {
            status: "running",
            input,
            title,
            metadata: { output },
            time: { start: toolStart },
          }
        : failed
          ? {
              status: "error",
              input,
              error: output || `${title} failed`,
              time: { start: toolStart, end: Date.now() },
            }
          : {
              status: "completed",
              input,
              title,
              output,
              metadata: {},
              time: { start: toolStart, end: Date.now() },
            }
      part = { ...base, type: "tool", callID: item.id, tool, state }
    }
    this.items.set(item.id, part)
    if (index >= 0) row.parts[index] = part
    this.publish(row, part)
  }
  private complete(turn: Turn) {
    const row = this.assistant(turn.id)
    if (row.info.role !== "assistant") return
    row.info.time.completed = turn.completedAt
      ? turn.completedAt * 1000
      : Date.now()
    row.info.finish = turn.status === "interrupted" ? "abort" : "stop"
    if (turn.error)
      row.info.error = {
        name: "UnknownError",
        data: { message: turn.error.message },
      }
    this.emit({
      type: "message.updated",
      properties: { sessionID: this.id, info: row.info },
    })
  }
  setStatus(status: SessionStatus) {
    this.status = status
    this.emit({
      type: "session.status",
      properties: { sessionID: this.id, status },
    })
  }
  notification(notice: Notification) {
    switch (notice.method) {
      case "thread/settings/updated": {
        const settings = notice.params.threadSettings
        this.model = settings.model
        this.mode =
          settings.collaborationMode.mode === "plan" ? "plan" : "default"
        this.agent = this.mode === "plan" ? "plan" : "codex"
        this.thread.cwd = settings.cwd
        this.thread.model = settings.model
        this.thread.reasoningEffort = settings.effort
        this.emit({
          type: "session.updated",
          properties: { sessionID: this.id, info: this.session },
        })
        break
      }
      case "thread/status/changed":
        this.thread.status = notice.params.status
        this.setStatus({
          type: notice.params.status.type === "active" ? "busy" : "idle",
        })
        this.emit({
          type: "session.updated",
          properties: { sessionID: this.id, info: this.session },
        })
        break
      case "turn/started": {
        this.turns.set(notice.params.turn.id, notice.params.turn)
        this.activeTurn = notice.params.turn.id
        this.setStatus({ type: "busy" })
        break
      }
      case "turn/completed": {
        const turn = notice.params.turn
        this.turns.set(turn.id, turn)
        for (const item of turn.items) this.item(turn.id, item, true)
        this.complete(turn)
        this.activeTurn = undefined
        this.setStatus({ type: "idle" })
        this.thread.updatedAt = Date.now() / 1000
        this.emit({
          type: "session.updated",
          properties: { sessionID: this.id, info: this.session },
        })
        this.emit({ type: "session.idle", properties: { sessionID: this.id } })
        break
      }
      case "item/started":
      case "item/completed":
        this.item(
          notice.params.turnId,
          notice.params.item,
          notice.method === "item/completed",
        )
        break
      case "item/agentMessage/delta":
      case "item/plan/delta":
      case "item/reasoning/summaryTextDelta":
      case "item/reasoning/textDelta": {
        // Only summaries are exposed. Raw reasoning deltas are not conversational context.
        if (notice.method === "item/reasoning/textDelta") break
        const part = this.items.get(notice.params.itemId)
        if (part?.type !== "text" && part?.type !== "reasoning") break
        part.text += notice.params.delta
        this.publish(this.rows.get(part.messageID)!, part)
        break
      }
      case "item/commandExecution/outputDelta": {
        const part = this.items.get(notice.params.itemId)
        if (part?.type !== "tool" || part.state.status !== "running") break
        part.state.metadata = {
          ...part.state.metadata,
          output:
            String(part.state.metadata?.output ?? "") + notice.params.delta,
        }
        this.publish(this.rows.get(part.messageID)!, part)
        break
      }
      case "thread/name/updated":
        this.thread.name = notice.params.threadName ?? null
        this.emit({
          type: "session.updated",
          properties: { sessionID: this.id, info: this.session },
        })
        break
      case "thread/tokenUsage/updated": {
        const row = this.assistant(notice.params.turnId)
        if (row.info.role !== "assistant") break
        const usage = notice.params.tokenUsage.last
        row.info.tokens = {
          total: usage.totalTokens,
          input: usage.inputTokens,
          output: usage.outputTokens,
          reasoning: usage.reasoningOutputTokens,
          cache: {
            read: usage.cachedInputTokens,
            write: usage.cacheWriteInputTokens,
          },
        }
        this.emit({
          type: "message.updated",
          properties: { sessionID: this.id, info: row.info },
        })
        break
      }
      case "error":
        if (!notice.params.willRetry)
          this.emit({
            type: "session.error",
            properties: {
              sessionID: this.id,
              error: {
                name: "UnknownError",
                data: { message: notice.params.error.message },
              },
            },
          })
        break
    }
  }
  fail(error: Error) {
    if (this.activeTurn)
      this.complete({
        id: this.activeTurn,
        items: [],
        itemsView: "full",
        status: "failed",
        error: {
          message: error.message,
          codexErrorInfo: null,
          additionalDetails: null,
          misalignment: null,
        },
        startedAt: null,
        completedAt: null,
        durationMs: null,
      })
    this.activeTurn = undefined
    this.setStatus({ type: "idle" })
    this.emit({
      type: "session.error",
      properties: {
        sessionID: this.id,
        error: { name: "UnknownError", data: { message: error.message } },
      },
    })
  }
}
