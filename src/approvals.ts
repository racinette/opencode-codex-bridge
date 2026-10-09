import { formValidator, validateForm } from "./elicitation"
import type { CommandExecutionApprovalDecision } from "./protocol/v2/CommandExecutionApprovalDecision"
import type { GrantedPermissionProfile } from "./protocol/v2/GrantedPermissionProfile"
import type { EventInput } from "./events"
import { createHash } from "node:crypto"
import type {
  Event,
  PermissionRequest,
  QuestionRequest,
} from "@opencode-ai/sdk/v2"
import type { NativeRequest } from "./rpc"
import { CodexRpc } from "./rpc"
import { sessionID } from "./projection"

export type Decision = { title: string; result: unknown }
export type PendingRequest = {
  id: string
  sessionID: string
  method: string
  title: string
  details: string
  decisions: Decision[]
  elicitation?: { mode: "form" | "url"; schema?: unknown; url?: string }
}
type Entry = {
  native: NativeRequest
  view: PendingRequest
  permission?: PermissionRequest
  question?: QuestionRequest
}
export class Approvals {
  private pending = new Map<string, Entry>()
  constructor(
    private rpc: CodexRpc,
    private emit: (event: EventInput) => void,
  ) {
    rpc.onRequest((request) => this.receive(request))
  }
  list() {
    return [...this.pending.values()].map((e) => e.view)
  }
  permissions() {
    return [...this.pending.values()].flatMap((e) =>
      e.permission ? [e.permission] : [],
    )
  }
  questions() {
    return [...this.pending.values()].flatMap((e) =>
      e.question ? [e.question] : [],
    )
  }
  private receive(native: NativeRequest) {
    if (!("threadId" in native.params)) {
      this.rpc.reject(native.id, `Bridge does not support ${native.method}`)
      return
    }
    const sid = sessionID(native.params.threadId)
    const id =
      "per_" +
      createHash("sha256")
        .update(JSON.stringify([native.params.threadId, native.id]))
        .digest("hex")
        .slice(0, 24)
    const view: PendingRequest = {
      id,
      sessionID: sid,
      method: native.method,
      title: "Codex approval",
      details: "",
      decisions: [],
    }
    const entry: Entry = { native, view }
    switch (native.method) {
      case "item/commandExecution/requestApproval": {
        const params = native.params
        view.title = "Codex command approval"
        view.details = [params.command, params.cwd, params.reason]
          .filter(Boolean)
          .join("\n")
        if (params.proposedExecpolicyAmendment)
          view.details +=
            "\nProposed command rule: " +
            JSON.stringify(params.proposedExecpolicyAmendment)
        if (params.proposedNetworkPolicyAmendments)
          view.details +=
            "\nProposed network rules: " +
            JSON.stringify(params.proposedNetworkPolicyAmendments)
        view.decisions = (
          params.availableDecisions ?? [
            "accept",
            "acceptForSession",
            "decline",
            "cancel",
          ]
        ).map((decision) => ({
          title:
            typeof decision === "string"
              ? {
                  accept: "Allow once",
                  acceptForSession: "Allow for this Codex session",
                  decline: "Decline",
                  cancel: "Cancel turn",
                }[decision]
              : "acceptWithExecpolicyAmendment" in decision
                ? "Allow and save the proposed command rule"
                : "Apply the proposed network rule",
          result: { decision },
        }))
        break
      }
      case "item/fileChange/requestApproval":
        view.title = "Codex file approval"
        view.details = [native.params.reason, native.params.grantRoot]
          .filter(Boolean)
          .join("\n")
        view.decisions = [
          { title: "Allow once", result: { decision: "accept" } },
          {
            title: "Allow for this Codex session",
            result: { decision: "acceptForSession" },
          },
          { title: "Decline", result: { decision: "decline" } },
          { title: "Cancel turn", result: { decision: "cancel" } },
        ]
        break
      case "item/permissions/requestApproval": {
        view.title = "Codex permissions"
        view.details = [
          native.params.reason,
          JSON.stringify(native.params.permissions, null, 2),
        ]
          .filter(Boolean)
          .join("\n")
        const permissions = {
          ...(native.params.permissions.network
            ? { network: native.params.permissions.network }
            : {}),
          ...(native.params.permissions.fileSystem
            ? { fileSystem: native.params.permissions.fileSystem }
            : {}),
        }
        view.decisions = [
          {
            title: "Allow for this turn",
            result: { permissions, scope: "turn" },
          },
          {
            title: "Allow for this Codex session",
            result: { permissions, scope: "session" },
          },
          { title: "Decline", result: { permissions: {}, scope: "turn" } },
        ]
        break
      }
      case "item/tool/requestUserInput": {
        entry.question = {
          id,
          sessionID: sid,
          questions: native.params.questions.map((q) => ({
            header: q.header,
            question: q.question,
            multiple: false,
            custom: q.isOther || !q.options?.length,
            options: (q.options ?? []).map((o) => ({
              label: o.label,
              description: o.description,
            })),
          })),
        }
        this.pending.set(id, entry)
        this.emit({ type: "question.asked", properties: entry.question })
        return
      }
      case "mcpServer/elicitation/request": {
        const params = native.params
        view.title = `MCP request · ${params.serverName}`
        view.details = "message" in params ? params.message : params.description
        if (
          params.mode === "form" ||
          params.mode === "openai/form" ||
          params.mode === "openaiForm"
        ) {
          view.elicitation = { mode: "form", schema: params.requestedSchema }
          view.decisions.push({
            title: "Fill out form",
            result: { action: "accept", content: null, _meta: null },
          })
        } else if (params.mode === "url") {
          view.elicitation = { mode: "url", url: params.url }
          view.details += "\n\n" + params.url
          view.decisions.push({
            title: "Continue after completing the URL flow",
            result: { action: "accept", content: null, _meta: null },
          })
        } else
          view.details +=
            "\nThis request requires native user verification, which this frontend cannot perform."
        view.decisions.push(
          {
            title: "Decline",
            result: { action: "decline", content: null, _meta: null },
          },
          {
            title: "Cancel",
            result: { action: "cancel", content: null, _meta: null },
          },
        )
        break
      }
      default:
        this.rpc.reject(native.id, `Bridge does not support ${native.method}`)
        return
    }
    if (native.method === "mcpServer/elicitation/request") {
      // OpenCode's generic Allow buttons cannot represent typed form answers.
      // The native request dialog owns elicitation, including reopening it.
      this.pending.set(id, entry)
      return
    }
    entry.permission = {
      id,
      sessionID: sid,
      permission: "codex",
      patterns: [view.title],
      always: [],
      metadata: { codexRequest: id, description: view.details },
    }
    this.pending.set(id, entry)
    this.emit({ type: "permission.asked", properties: entry.permission })
  }
  decide(id: string, choice: number, content?: unknown) {
    const entry = this.pending.get(id)
    if (!entry) throw new Error("Approval is no longer pending")
    const selected = entry.view.decisions[choice]
    if (!selected) throw new Error("Invalid Codex approval choice")
    let reply = selected.result
    if (
      entry.native.method === "mcpServer/elicitation/request" &&
      (reply as { action: string }).action === "accept" &&
      entry.view.elicitation?.mode === "form"
    ) {
      reply = {
        action: "accept",
        content: validateForm(
          formValidator(entry.view.elicitation.schema),
          content,
        ),
        _meta: null,
      }
    }
    this.rpc.respond(entry.native.id, reply)
    const result = reply as {
      decision?: CommandExecutionApprovalDecision
      permissions?: GrantedPermissionProfile
      scope?: string
      action?: string
    }
    const decision = result.decision
    const saved = typeof decision === "object" && decision !== null
    const accepted =
      result.action === "accept" ||
      decision === "accept" ||
      decision === "acceptForSession" ||
      (saved &&
        ("acceptWithExecpolicyAmendment" in decision ||
          decision.applyNetworkPolicyAmendment.network_policy_amendment
            .action === "allow")) ||
      Object.keys(result.permissions ?? {}).length > 0
    this.remove(
      id,
      accepted
        ? decision === "acceptForSession" || saved || result.scope === "session"
          ? "always"
          : "once"
        : "reject",
    )
  }
  permissionReply(id: string, reply: string) {
    const entry = this.pending.get(id)
    if (!entry) throw new Error("Approval is no longer pending")
    // OpenCode's 'always' must not invent a persistent Codex permission rule.
    const decision =
      reply === "once"
        ? "accept"
        : reply === "always"
          ? "acceptForSession"
          : "decline"
    const index = entry.view.decisions.findIndex(
      (c) => JSON.stringify(c.result) === JSON.stringify({ decision }),
    )
    if (index < 0)
      throw new Error("Use the Codex approval dialog to choose this permission")
    this.decide(id, index)
  }
  answer(id: string, answers: string[][]) {
    const entry = this.pending.get(id)
    if (entry?.native.method !== "item/tool/requestUserInput")
      throw new Error("Question is no longer pending")
    if (answers.length !== entry.native.params.questions.length)
      throw new Error("Every question needs an answer")
    const result = {
      answers: Object.fromEntries(
        entry.native.params.questions.map((q, i) => [
          q.id,
          { answers: answers[i] },
        ]),
      ),
    }
    this.rpc.respond(entry.native.id, result)
    this.remove(id, "reject", answers)
  }
  rejectQuestion(id: string) {
    const entry = this.pending.get(id)
    if (entry?.native.method !== "item/tool/requestUserInput")
      throw new Error("Question is no longer pending")
    this.rpc.respond(entry.native.id, { answers: {} })
    this.remove(id)
  }
  resolved(nativeID: number | string) {
    for (const [id, e] of this.pending)
      if (e.native.id === nativeID) this.remove(id)
  }
  clear(sid?: string) {
    for (const [id, e] of this.pending)
      if (!sid || e.view.sessionID === sid) this.remove(id)
  }
  private remove(
    id: string,
    reply: "once" | "always" | "reject" = "reject",
    answers?: string[][],
  ) {
    const entry = this.pending.get(id)
    if (!entry) return
    this.pending.delete(id)
    if (entry.question && answers)
      this.emit({
        type: "question.replied",
        properties: { sessionID: entry.view.sessionID, requestID: id, answers },
      })
    else if (entry.question)
      this.emit({
        type: "question.rejected",
        properties: { sessionID: entry.view.sessionID, requestID: id },
      })
    else if (entry.permission)
      this.emit({
        type: "permission.replied",
        properties: {
          sessionID: entry.view.sessionID,
          requestID: id,
          reply,
        },
      })
  }
}
