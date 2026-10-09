import { NativeControls } from "./native-controls"
import type { ThreadTurnsListResponse } from "./protocol/v2/ThreadTurnsListResponse"
import { realpathSync } from "node:fs"
import type { ThreadReadResponse } from "./protocol/v2/ThreadReadResponse"
import type { EventInput } from "./events"
import { homedir } from "node:os"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import type { Event, Provider } from "@opencode-ai/sdk/v2"
import type { Model } from "./protocol/v2/Model"
import type { ModelListResponse } from "./protocol/v2/ModelListResponse"
import type { ConfigReadResponse } from "./protocol/v2/ConfigReadResponse"
import type { Thread } from "./protocol/v2/Thread"
import type { ThreadListResponse } from "./protocol/v2/ThreadListResponse"
import type { ThreadResumeResponse } from "./protocol/v2/ThreadResumeResponse"
import type { ThreadStartResponse } from "./protocol/v2/ThreadStartResponse"
import type { ThreadForkResponse } from "./protocol/v2/ThreadForkResponse"
import type { TurnStartResponse } from "./protocol/v2/TurnStartResponse"
import type { UserInput } from "./protocol/v2/UserInput"
import type { ReasoningEffort } from "./protocol/ReasoningEffort"
import type { ThreadStartParams } from "./protocol/v2/ThreadStartParams"
import { CodexRpc } from "./rpc"
import { Projection, threadID } from "./projection"
import { Approvals } from "./approvals"

type Options = {
  cwd: string
  command?: string[]
  native?: Pick<
    ThreadStartParams,
    "approvalPolicy" | "sandbox" | "approvalsReviewer"
  >
}
type Body = {
  agent?: string
  model?: { modelID?: string; id?: string; providerID?: string }
  variant?: string
  parts?: { type: string; text?: string; url?: string; mime?: string }[]
  messageID?: string
  title?: string
  command?: string
  arguments?: string
  choice?: number
  answers?: string[][]
  reply?: string
  objective?: string
  profile?: string
  approvalPolicy?: string
  sandbox?: string
  content?: unknown
  mcpAction?: string
  serverName?: string
}
export class Bridge {
  readonly rpc: CodexRpc
  readonly approvals: Approvals
  readonly controls: NativeControls
  private sessions = new Map<string, Projection>()
  private directories: string[]
  private loading = new Map<string, Promise<Projection>>()
  private locks = new Map<string, Promise<unknown>>()
  private subscribers = new Set<(event: Event) => void>()
  private models: Model[] = []
  private defaultModel = ""
  private alive = true
  private server?: ReturnType<typeof Bun.serve>
  constructor(readonly options: Options) {
    const logical = resolve(options.cwd)
    options.cwd = realpathSync(logical)
    this.directories = [...new Set([logical, options.cwd])]
    this.rpc = new CodexRpc(options.command, options.cwd)
    this.controls = new NativeControls(this.rpc)
    this.approvals = new Approvals(this.rpc, (event) => this.emit(event))
    this.rpc.onNotification((notice) => {
      if (notice.method === "thread/started") this.adopt(notice.params.thread)
      if ("threadId" in notice.params && notice.params.threadId) {
        this.sessions.get(notice.params.threadId)?.notification(notice)
        if (notice.method === "serverRequest/resolved")
          this.approvals.resolved(notice.params.requestId)
        if (notice.method === "turn/completed") {
          const session = this.sessions.get(notice.params.threadId)
          if (session) this.approvals.clear(session.id)
        }
      }
    })
    this.rpc.onFailure((error) => {
      this.alive = false
      this.approvals.clear()
      for (const session of this.sessions.values())
        if (session.activeTurn) session.fail(error)
    })
  }
  private emit(event: EventInput) {
    for (const listener of this.subscribers)
      listener({
        ...event,
        id: "evt_" + crypto.randomUUID().replaceAll("-", ""),
      })
  }
  onEvent(fn: (event: Event) => void) {
    this.subscribers.add(fn)
    return () => this.subscribers.delete(fn)
  }
  async initialize() {
    await this.rpc.initialize()
    const [catalog, config] = await Promise.all([
      this.rpc.call<"model/list", ModelListResponse>("model/list", {}),
      this.rpc.call<"config/read", ConfigReadResponse>("config/read", {
        cwd: this.options.cwd,
        includeLayers: false,
      }),
    ])
    this.models = catalog.data.filter((m) => !m.hidden)
    this.defaultModel =
      config.config.model ??
      this.models.find((m) => m.isDefault)?.model ??
      this.models[0]?.model ??
      ""
    if (!this.defaultModel) throw new Error("Codex returned no available model")
    await this.list()
  }
  private adopt(thread: Thread, model = this.defaultModel) {
    let session = this.sessions.get(thread.id)
    if (!session) {
      session = new Projection(thread, model, (event) => this.emit(event))
      this.sessions.set(thread.id, session)
    }
    return session
  }
  private async list() {
    let cursor: string | null = null
    do {
      const response: ThreadListResponse = await this.rpc.call<
        "thread/list",
        ThreadListResponse
      >("thread/list", {
        cwd: this.directories,
        limit: 100,
        cursor,
        sourceKinds: [],
        sortKey: "updated_at",
      })
      for (const thread of response.data) {
        const session = this.adopt(thread)
        if (!session.loaded) session.thread = thread
      }
      cursor = response.nextCursor
    } while (cursor)
    return [...this.sessions.values()]
      .filter((s) => this.directories.includes(s.thread.cwd))
      .map((s) => s.session)
  }
  private async history(thread: Thread) {
    if (thread.historyMode !== "paginated") return thread
    const turns: Thread["turns"] = []
    let cursor: string | null = null
    do {
      const page: ThreadTurnsListResponse = await this.rpc.call<
        "thread/turns/list",
        ThreadTurnsListResponse
      >("thread/turns/list", {
        threadId: thread.id,
        limit: 100,
        cursor,
        sortDirection: "asc",
        itemsView: "full",
      })
      turns.push(...page.data)
      cursor = page.nextCursor
    } while (cursor)
    return { ...thread, turns }
  }
  private async get(id: string) {
    const nativeID = threadID(id)
    const current = this.sessions.get(nativeID)
    if (current?.loaded) return current
    const ongoing = this.loading.get(nativeID)
    if (ongoing) return ongoing
    const pending = (async () => {
      const stored = await this.rpc.call<"thread/read", ThreadReadResponse>(
        "thread/read",
        { threadId: nativeID, includeTurns: false },
      )
      await this.assertWorkspace(stored.thread)
      const response = await this.rpc.call<
        "thread/resume",
        ThreadResumeResponse
      >("thread/resume", {
        threadId: nativeID,
        ...(stored.thread.parentThreadId
          ? {}
          : { cwd: this.options.cwd, ...this.options.native }),
        excludeTurns: stored.thread.historyMode === "paginated",
      })
      this.controls.remember(response)
      const session = this.adopt(response.thread, response.model)
      session.model = response.model
      session.mode =
        response.collaborationMode?.mode === "plan" ? "plan" : "default"
      session.agent = session.mode === "plan" ? "plan" : "codex"
      session.hydrate(await this.history(response.thread))
      session.loaded = true
      return session
    })()
    this.loading.set(nativeID, pending)
    try {
      return await pending
    } finally {
      this.loading.delete(nativeID)
    }
  }
  private async root(thread: Thread) {
    const seen = new Set<string>()
    while (thread.parentThreadId) {
      if (seen.has(thread.id) || seen.size >= 64)
        throw new Error("Invalid subagent ancestry")
      seen.add(thread.id)
      thread = (
        await this.rpc.call<"thread/read", ThreadReadResponse>("thread/read", {
          threadId: thread.parentThreadId,
          includeTurns: false,
        })
      ).thread
    }
    return thread
  }
  private async assertWorkspace(thread: Thread) {
    const root = await this.root(thread)
    if (realpathSync(root.cwd) !== realpathSync(this.options.cwd))
      throw new Error("This thread belongs to a different workspace")
  }
  private async agents(session: Projection, direct = false) {
    const root = direct ? session.thread : await this.root(session.thread)
    let cursor: string | null = null
    const threads: Thread[] = direct ? [] : [root]
    do {
      const page: ThreadListResponse = await this.rpc.call("thread/list", {
        ...(direct
          ? { parentThreadId: root.id }
          : { ancestorThreadId: root.id }),
        sourceKinds: [
          "subAgent",
          "subAgentReview",
          "subAgentCompact",
          "subAgentThreadSpawn",
          "subAgentOther",
        ],
        limit: 100,
        cursor,
      })
      // Check ancestry ourselves too: older servers can ignore optional filters.
      for (const thread of page.data) {
        if (
          direct
            ? thread.parentThreadId === root.id
            : thread.parentThreadId && (await this.root(thread)).id === root.id
        )
          threads.push(thread)
      }
      cursor = page.nextCursor
    } while (cursor)
    return threads.map((thread) => {
      const projection = this.adopt(thread)
      projection.thread = { ...thread, turns: projection.thread.turns }
      projection.model = thread.model ?? projection.model
      return projection.session
    })
  }
  private async create(body: Body) {
    const model = body.model?.modelID ?? body.model?.id ?? this.defaultModel
    const response = await this.rpc.call<"thread/start", ThreadStartResponse>(
      "thread/start",
      { cwd: this.options.cwd, model, ...this.options.native },
    )
    this.controls.remember(response)
    const session = this.adopt(response.thread, response.model)
    session.model = response.model
    session.loaded = true
    session.agent = body.agent === "plan" ? "plan" : "codex"
    session.mode = session.agent === "plan" ? "plan" : "default"
    this.emit({
      type: "session.created",
      properties: { sessionID: session.id, info: session.session },
    })
    return session.session
  }
  private input(body: Body): UserInput[] {
    const input: UserInput[] = []
    for (const part of body.parts ?? []) {
      if (part.type === "text" && part.text)
        input.push({ type: "text", text: part.text, text_elements: [] })
      else if (part.type === "file" && part.url) {
        if (part.mime?.startsWith("image/"))
          input.push(
            part.url.startsWith("file:")
              ? { type: "localImage", path: fileURLToPath(part.url) }
              : { type: "image", url: part.url },
          )
        else if (part.url.startsWith("file:"))
          input.push({
            type: "mention",
            name: fileURLToPath(part.url),
            path: fileURLToPath(part.url),
          })
        else
          throw new Error(
            "Codex bridge supports local file references and image attachments",
          )
      } else throw new Error(`Unsupported prompt part: ${part.type}`)
    }
    if (!input.length) throw new Error("Prompt is empty")
    return input
  }
  private serialize<T>(id: string, run: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(id) ?? Promise.resolve()
    const pending = previous.catch(() => {}).then(run)
    this.locks.set(id, pending)
    void pending
      .finally(() => {
        if (this.locks.get(id) === pending) this.locks.delete(id)
      })
      .catch(() => {})
    return pending
  }
  private async prompt(id: string, body: Body) {
    return this.serialize(id, async () => {
      const session = await this.get(id)
      if (session.thread.canAcceptDirectInput === false)
        throw new Error(
          "This subagent is controlled by its parent; open the parent thread to send instructions",
        )
      const input = this.input(body)
      if (body.model?.providerID && body.model.providerID !== "codex")
        throw new Error("Select a Codex model")
      if (session.activeTurn)
        await this.rpc.call("turn/steer", {
          threadId: session.thread.id,
          expectedTurnId: session.activeTurn,
          input,
          clientUserMessageId: body.messageID,
        })
      else {
        const model = body.model?.modelID ?? session.model
        const effort = body.variant as ReasoningEffort | undefined
        if (
          effort &&
          !this.models
            .find((m) => m.model === model)
            ?.supportedReasoningEfforts.some(
              (e) => e.reasoningEffort === effort,
            )
        )
          throw new Error("Unsupported reasoning effort")
        session.agent = body.agent === "plan" ? "plan" : "codex"
        session.mode = session.agent === "plan" ? "plan" : "default"
        session.model = model
        session.setStatus({ type: "busy" })
        try {
          const response = await this.rpc.call<"turn/start", TurnStartResponse>(
            "turn/start",
            {
              threadId: session.thread.id,
              input,
              clientUserMessageId: body.messageID,
              model,
              effort,
              collaborationMode: {
                mode: session.mode,
                settings: {
                  model,
                  reasoning_effort: effort ?? null,
                  developer_instructions: null,
                },
              },
            },
          )
          if (
            response.turn.status === "inProgress" &&
            session.status.type === "busy"
          )
            session.activeTurn = response.turn.id
        } catch (error) {
          session.setStatus({ type: "idle" })
          throw error
        }
      }
      return (
        session.messages().findLast((r) => r.info.role === "assistant") ?? null
      )
    })
  }
  private provider(): Provider {
    return {
      id: "codex",
      name: "Codex CLI",
      source: "custom",
      env: [],
      options: {},
      models: Object.fromEntries(
        this.models.map((m) => [
          m.model,
          {
            id: m.model,
            providerID: "codex",
            api: { id: m.model, url: "", npm: "" },
            name: m.displayName,
            capabilities: {
              temperature: false,
              reasoning: true,
              attachment: true,
              toolcall: true,
              input: {
                text: true,
                audio: false,
                image: m.inputModalities.includes("image"),
                video: false,
                pdf: false,
              },
              output: {
                text: true,
                audio: false,
                image: false,
                video: false,
                pdf: false,
              },
              interleaved: false,
            },
            cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
            limit: { context: 0, output: 0 },
            status: "active",
            options: {},
            headers: {},
            release_date: "",
            variants: Object.fromEntries(
              m.supportedReasoningEfforts.map((e) => [e.reasoningEffort, {}]),
            ),
          },
        ]),
      ),
    }
  }
  private async command(id: string, body: Body) {
    const session = await this.get(id)
    switch (body.command) {
      case "review":
        return this.rpc.call("review/start", {
          threadId: session.thread.id,
          target: body.arguments?.trim()
            ? { type: "custom", instructions: body.arguments }
            : { type: "uncommittedChanges" },
          delivery: "inline",
        })
      case "compact":
        return this.rpc.call("thread/compact/start", {
          threadId: session.thread.id,
        })
      case "goal":
        return body.arguments?.trim()
          ? this.rpc.call("thread/goal/set", {
              threadId: session.thread.id,
              objective: body.arguments.trim(),
              origin: "user",
            })
          : this.rpc.call("thread/goal/get", { threadId: session.thread.id })
      case "goal-clear":
        return this.rpc.call("thread/goal/clear", {
          threadId: session.thread.id,
          origin: "user",
        })
      default:
        throw new Error(`Unsupported Codex command: ${body.command}`)
    }
  }
  private eventStream(request: Request, global: boolean) {
    const encoder = new TextEncoder()
    let off = () => {},
      timer: ReturnType<typeof setInterval> | undefined
    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        const send = (event: Event) => {
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify(global ? { directory: this.options.cwd, payload: event } : event)}\n\n`,
            ),
          )
        }
        send({
          id: "evt_" + crypto.randomUUID(),
          type: "server.connected",
          properties: {},
        })
        off = this.onEvent(send)
        timer = setInterval(
          () => controller.enqueue(encoder.encode(": heartbeat\n\n")),
          15000,
        )
        request.signal.addEventListener(
          "abort",
          () => {
            off()
            clearInterval(timer)
            try {
              controller.close()
            } catch {}
          },
          { once: true },
        )
      },
      cancel() {
        off()
        clearInterval(timer)
      },
    })
    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    })
  }
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url),
      path = url.pathname,
      method = request.method
    if (
      request.headers.has("origin") &&
      request.headers.get("origin") !== url.origin
    )
      return Response.json(
        { message: "Cross-origin requests are not allowed" },
        { status: 403 },
      )
    try {
      if (!this.alive)
        throw new Error("Codex app-server is unavailable; restart the bridge")
      if (method === "GET" && (path === "/global/event" || path === "/event"))
        return this.eventStream(request, path === "/global/event")
      const body: Body =
        method === "GET" || method === "DELETE"
          ? {}
          : await request.json().catch(() => ({}))
      const defaults = { codex: this.defaultModel }
      if (method === "GET" && path === "/global/health")
        return Response.json({ healthy: true, version: "1.18.35" })
      if (method === "GET" && path === "/config/providers")
        return Response.json({
          providers: [this.provider()],
          default: defaults,
        })
      if (method === "GET" && path === "/provider")
        return Response.json({
          all: [this.provider()],
          default: defaults,
          connected: ["codex"],
        })
      if (method === "GET" && (path === "/config" || path === "/global/config"))
        return Response.json({
          model: `codex/${this.defaultModel}`,
          default_agent: "codex",
          share: "disabled",
          autoupdate: false,
        })
      if (method === "GET" && path === "/agent")
        return Response.json(
          ["codex", "plan"].map((name) => ({
            name,
            description: name === "plan" ? "Codex Plan mode" : "Codex CLI",
            mode: "primary",
            native: true,
            permission: [],
            options: {},
          })),
        )
      if (method === "GET" && path === "/path")
        return Response.json({
          home: homedir(),
          state: resolve(homedir(), ".codex"),
          config: resolve(homedir(), ".codex"),
          worktree: this.options.cwd,
          directory: this.options.cwd,
        })
      if (method === "GET" && path === "/project/current")
        return Response.json({
          id: "codex",
          worktree: this.options.cwd,
          name: "Codex",
          time: { created: 0, updated: 0 },
          sandboxes: [],
        })
      if (method === "GET" && path === "/project/codex/directories")
        return Response.json([{ directory: this.options.cwd }])
      if (method === "GET" && path === "/experimental/capabilities")
        return Response.json({ backgroundSubagents: false })
      if (method === "GET" && path === "/experimental/console")
        return Response.json({
          consoleManagedProviders: [],
          switchableOrgCount: 0,
        })
      if (
        method === "GET" &&
        [
          "/lsp",
          "/formatter",
          "/skill",
          "/experimental/workspace",
          "/experimental/workspace/status",
          "/experimental/resource",
          "/file/status",
          "/find/file",
        ].includes(path)
      )
        return Response.json([])
      if (method === "GET" && ["/mcp", "/provider/auth"].includes(path))
        return Response.json({})
      if (method === "GET" && path === "/vcs") return Response.json(null)
      if (method === "POST" && path === "/log") return Response.json(true)
      if (method === "GET" && path === "/command")
        return Response.json([
          {
            name: "review",
            description: "Start a native Codex review",
            template: "",
          },
          {
            name: "goal",
            description: "Set or inspect a Codex goal",
            template: "",
          },
          {
            name: "goal-clear",
            description: "Clear the Codex goal",
            template: "",
          },
        ])
      if (method === "GET" && path === "/session/status")
        return Response.json(
          Object.fromEntries(
            [...this.sessions.values()].map((s) => [s.id, s.status]),
          ),
        )
      if ((method === "GET" || method === "POST") && path === "/session")
        return Response.json(
          method === "POST" ? await this.create(body) : await this.list(),
        )
      if (method === "GET" && path === "/permission")
        return Response.json(this.approvals.permissions())
      if (method === "GET" && path === "/question")
        return Response.json(this.approvals.questions())
      if (method === "GET" && path === "/bridge/requests")
        return Response.json(this.approvals.list())
      const approval = path.match(
        /^\/(permission|question|bridge\/requests)\/([^/]+)\/(reply|reject)$/,
      )
      if (approval && method === "POST") {
        const [, kind, id, action] = approval
        if (kind === "bridge/requests")
          this.approvals.decide(id, body.choice ?? -1, body.content)
        else if (kind === "permission")
          this.approvals.permissionReply(id, body.reply ?? "")
        else if (action === "reject") this.approvals.rejectQuestion(id)
        else this.approvals.answer(id, body.answers ?? [])
        return Response.json(true)
      }
      const match = path.match(/^\/session\/(ses_[a-f0-9]+)(?:\/(.*))?$/)
      if (match) {
        const [, id, action] = match
        if (!action) {
          const session = await this.get(id)
          if (method === "PATCH" && body.title) {
            await this.rpc.call("thread/name/set", {
              threadId: session.thread.id,
              name: body.title,
            })
            session.thread.name = body.title
            this.emit({
              type: "session.updated",
              properties: { sessionID: session.id, info: session.session },
            })
          }
          if (method !== "GET" && method !== "PATCH")
            throw new Error("Deleting native Codex threads is not supported")
          return Response.json(session.session)
        }
        if (action === "message" && method === "GET") {
          const rows = (await this.get(id)).messages()
          const limit = Number(url.searchParams.get("limit"))
          return Response.json(limit > 0 ? rows.slice(-limit) : rows)
        }
        if (
          (action === "message" || action === "prompt_async") &&
          method === "POST"
        )
          return Response.json(await this.prompt(id, body))
        if (method === "GET" && (action === "todo" || action === "diff"))
          return Response.json([])
        const session = await this.get(id)
        if (action === "status" && method === "GET")
          return Response.json(await this.controls.status(session))
        if (action === "permissions" && (method === "GET" || method === "POST"))
          return Response.json(
            method === "GET"
              ? await this.controls.permissions(session)
              : await this.controls.setPermissions(session, body),
          )
        if ((action === "agents" || action === "children") && method === "GET")
          return Response.json(
            await this.agents(session, action === "children"),
          )
        if (action === "mcp" && method === "GET")
          return Response.json(await this.controls.mcp(session))
        if (action === "mcp" && method === "POST") {
          if (body.mcpAction === "reload")
            return Response.json(await this.controls.mcpReload())
          if (body.mcpAction === "login" && body.serverName)
            return Response.json(
              await this.controls.mcpLogin(session, body.serverName),
            )
          throw new Error("Choose an MCP action")
        }
        if (action === "abort" && method === "POST") {
          if (session.activeTurn)
            await this.rpc.call("turn/interrupt", {
              threadId: session.thread.id,
              turnId: session.activeTurn,
            })
          return Response.json(true)
        }
        if (action === "summarize" && method === "POST") {
          await this.rpc.call("thread/compact/start", {
            threadId: session.thread.id,
          })
          return Response.json(true)
        }
        if (action === "command" && method === "POST")
          return Response.json(await this.command(id, body))
        if (action === "fork" && method === "POST") {
          if (body.messageID)
            throw new Error(
              "Fork at a message is not supported; use Codex fork for the entire conversation",
            )
          const response = await this.rpc.call<
            "thread/fork",
            ThreadForkResponse
          >("thread/fork", {
            threadId: session.thread.id,
            ...this.options.native,
          })
          this.controls.remember(response)
          const fork = this.adopt(response.thread, response.model)
          fork.hydrate(await this.history(response.thread))
          fork.loaded = true
          this.emit({
            type: "session.created",
            properties: { sessionID: fork.id, info: fork.session },
          })
          return Response.json(fork.session)
        }
      }
      return Response.json(
        {
          name: "UnsupportedOperation",
          data: { message: `Codex bridge does not support ${method} ${path}` },
        },
        { status: 501 },
      )
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.error(`${method} ${path}: ${message}`)
      return Response.json(
        { name: "UnknownError", data: { message } },
        { status: 400 },
      )
    }
  }
  listen(port = 4097) {
    this.server = Bun.serve({
      hostname: "127.0.0.1",
      port,
      idleTimeout: 0,
      fetch: (request) => this.fetch(request),
    })
    return this.server.url.toString()
  }
  async close() {
    this.server?.stop(true)
    await this.rpc.close()
  }
}
