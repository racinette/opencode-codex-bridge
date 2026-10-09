import type { ClientRequest } from "./protocol/ClientRequest"
import type { ServerNotification } from "./protocol/ServerNotification"
import type { ServerRequest } from "./protocol/ServerRequest"
import type { Subprocess } from "bun"

type Method = ClientRequest["method"]
type Params<M extends Method> = Extract<ClientRequest, { method: M }>["params"]
type Pending = {
  resolve(value: unknown): void
  reject(error: Error): void
  timer: ReturnType<typeof setTimeout>
}
export type NativeRequest = ServerRequest
export type Notification = ServerNotification

export class CodexRpc {
  private process: Subprocess<"pipe", "pipe", "pipe">
  private pending = new Map<number, Pending>()
  private nextID = 1
  private closed = false
  private notices = new Set<(notice: Notification) => void>()
  private requests = new Set<(request: NativeRequest) => void>()
  private failures = new Set<(error: Error) => void>()
  constructor(
    command: string[] = ["codex", "app-server"],
    cwd = process.cwd(),
  ) {
    this.process = Bun.spawn(command, {
      cwd,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, PWD: cwd },
    })
    void this.read().catch((error) =>
      this.fail(error instanceof Error ? error : new Error(String(error))),
    )
    // Drain diagnostics without mixing them into protocol stdout.
    const diagnostics = this.process.stderr
    void (async () => {
      for await (const chunk of diagnostics) process.stderr.write(chunk)
    })()
    void this.process.exited.then((code) =>
      this.fail(new Error(`Codex app-server exited (${code})`)),
    )
  }
  onNotification(fn: (notice: Notification) => void) {
    this.notices.add(fn)
    return () => this.notices.delete(fn)
  }
  onRequest(fn: (request: NativeRequest) => void) {
    this.requests.add(fn)
    return () => this.requests.delete(fn)
  }
  onFailure(fn: (error: Error) => void) {
    this.failures.add(fn)
    return () => this.failures.delete(fn)
  }
  async initialize() {
    await this.call("initialize", {
      clientInfo: {
        name: "opencode_codex_bridge",
        title: "OpenCode Codex Bridge",
        version: "0.1.0",
      },
      capabilities: {
        experimentalApi: true,
        requestAttestation: false,
        mcpServerOpenaiFormElicitation: true,
      },
    })
    this.send({ method: "initialized" })
  }
  call<M extends Method, R = unknown>(
    method: M,
    params: Params<M>,
    timeout = 30000,
  ): Promise<R> {
    if (this.closed)
      return Promise.reject(new Error("Codex app-server is closed"))
    const id = this.nextID++
    return new Promise<R>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`Codex ${method} timed out`))
      }, timeout)
      this.pending.set(id, {
        resolve: (value) => resolve(value as R),
        reject,
        timer,
      })
      try {
        this.send({ id, method, params })
      } catch (error) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(error)
      }
    })
  }
  respond(id: string | number, result: unknown) {
    this.send({ id, result })
  }
  reject(id: string | number, message: string) {
    this.send({ id, error: { code: -32601, message } })
  }
  private send(frame: unknown) {
    this.process.stdin.write(JSON.stringify(frame) + "\n")
    this.process.stdin.flush()
  }
  private async read() {
    let buffer = ""
    const decoder = new TextDecoder()
    for await (const chunk of this.process.stdout) {
      buffer += decoder.decode(chunk, { stream: true })
      for (;;) {
        const end = buffer.indexOf("\n")
        if (end < 0) break
        const line = buffer.slice(0, end)
        buffer = buffer.slice(end + 1)
        if (!line.trim()) continue
        const frame: {
          id?: number | string
          method?: string
          result?: unknown
          error?: { message: string }
        } = JSON.parse(line)
        if (frame.method) {
          if (frame.id !== undefined)
            for (const listener of this.requests)
              listener(frame as NativeRequest)
          else
            for (const listener of this.notices) listener(frame as Notification)
        } else if (typeof frame.id === "number") {
          const pending = this.pending.get(frame.id)
          if (!pending) continue
          clearTimeout(pending.timer)
          this.pending.delete(frame.id)
          if (frame.error) pending.reject(new Error(frame.error.message))
          else pending.resolve(frame.result)
        }
      }
      if (buffer.length > 16 * 1024 * 1024)
        throw new Error("Codex protocol frame exceeds 16 MiB")
    }
  }
  private fail(error: Error) {
    if (this.closed) return
    this.closed = true
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pending.clear()
    for (const listener of this.failures) listener(error)
    this.process.kill()
  }
  async close() {
    this.fail(new Error("Bridge closed"))
    await this.process.exited
  }
}
