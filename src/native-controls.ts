import type { CodexRpc } from "./rpc"
import type { Projection } from "./projection"
import type { ThreadStartResponse } from "./protocol/v2/ThreadStartResponse"
import type { ThreadResumeResponse } from "./protocol/v2/ThreadResumeResponse"
import type { ThreadTokenUsage } from "./protocol/v2/ThreadTokenUsage"
import type { GetAccountResponse } from "./protocol/v2/GetAccountResponse"
import type { GetAccountRateLimitsResponse } from "./protocol/v2/GetAccountRateLimitsResponse"
import type { PermissionProfileListResponse } from "./protocol/v2/PermissionProfileListResponse"
import type { ConfigRequirementsReadResponse } from "./protocol/v2/ConfigRequirementsReadResponse"
import type { ListMcpServerStatusResponse } from "./protocol/v2/ListMcpServerStatusResponse"
import type { SandboxPolicy } from "./protocol/v2/SandboxPolicy"
import type { AskForApproval } from "./protocol/v2/AskForApproval"

export type PermissionChoice = {
  id: string
  title: string
  description: string
  allowed: boolean
  kind: "profile" | "sandbox"
}
export type PermissionSelection = {
  profile?: string
  sandbox?: string
  approvalPolicy?: string
}
const policies = ["untrusted", "on-request", "never"] as const
const sandboxes: Record<string, SandboxPolicy> = {
  "read-only": { type: "readOnly", networkAccess: false },
  "workspace-write": {
    type: "workspaceWrite",
    writableRoots: [],
    networkAccess: false,
    excludeTmpdirEnvVar: false,
    excludeSlashTmp: false,
  },
  "danger-full-access": { type: "dangerFullAccess" },
}
const errorText = (error: unknown) =>
  error instanceof Error ? error.message : String(error)

export class NativeControls {
  private snapshots = new Map<
    string,
    ThreadResumeResponse | ThreadStartResponse
  >()
  remember(value: ThreadResumeResponse | ThreadStartResponse) {
    this.snapshots.set(value.thread.id, value)
  }
  private usage = new Map<string, ThreadTokenUsage>()
  constructor(private rpc: CodexRpc) {
    rpc.onNotification((notice) => {
      if (notice.method === "thread/settings/updated") {
        const previous = this.snapshots.get(notice.params.threadId)
        const current = notice.params.threadSettings
        if (previous)
          this.snapshots.set(notice.params.threadId, {
            ...previous,
            ...current,
            sandbox: current.sandboxPolicy,
            reasoningEffort: current.effort,
          })
      }
      if (notice.method === "thread/tokenUsage/updated")
        this.usage.set(notice.params.threadId, notice.params.tokenUsage)
    })
  }
  async settings(session: Projection) {
    // No overrides: read the loaded thread's effective settings, including changes
    // made from another client connected to the same daemon.
    try {
      const value = await this.rpc.call<"thread/resume", ThreadResumeResponse>(
        "thread/resume",
        { threadId: session.thread.id, excludeTurns: true },
      )
      this.remember(value)
      return value
    } catch (error) {
      // A newly started thread has no rollout until its first turn. Its start
      // response and settings notifications are still authoritative.
      const cached = this.snapshots.get(session.thread.id)
      if (!cached || !errorText(error).includes("no rollout found")) throw error
      return {
        ...cached,
        thread: session.thread,
        collaborationMode:
          "collaborationMode" in cached ? cached.collaborationMode : null,
      }
    }
  }
  async status(session: Projection) {
    const [settings, account, limits] = await Promise.allSettled([
      this.settings(session),
      this.rpc.call<"account/read", GetAccountResponse>(
        "account/read",
        { refreshToken: false },
        10000,
      ),
      this.rpc.call<"account/rateLimits/read", GetAccountRateLimitsResponse>(
        "account/rateLimits/read",
        {},
        10000,
      ),
    ])
    if (settings.status === "rejected") throw settings.reason
    const value = settings.value
    return {
      threadId: value.thread.id,
      parentThreadId: value.thread.parentThreadId,
      cwd: value.cwd ?? value.thread.cwd,
      status: value.thread.status,
      model: value.model,
      reasoningEffort: value.reasoningEffort ?? value.thread.reasoningEffort,
      mode: value.collaborationMode?.mode ?? session.mode,
      serviceTier: value.serviceTier,
      approvalPolicy: value.approvalPolicy,
      approvalsReviewer: value.approvalsReviewer,
      sandbox: value.sandbox,
      activePermissionProfile: value.activePermissionProfile,
      runtimeWorkspaceRoots: value.runtimeWorkspaceRoots,
      tokenUsage: this.usage.get(session.thread.id) ?? null,
      account: account.status === "fulfilled" ? account.value.account : null,
      accountError:
        account.status === "rejected" ? errorText(account.reason) : null,
      rateLimits: limits.status === "fulfilled" ? limits.value : null,
      rateLimitsError:
        limits.status === "rejected" ? errorText(limits.reason) : null,
    }
  }
  async permissions(session: Projection) {
    const [current, requirements, profiles] = await Promise.all([
      this.settings(session),
      this.rpc.call<"configRequirements/read", ConfigRequirementsReadResponse>(
        "configRequirements/read",
        undefined,
      ),
      this.profiles(session.thread.cwd),
    ])
    const choices: PermissionChoice[] = profiles.map((profile) => ({
      ...profile,
      title: profile.id,
      description: profile.description ?? "Native Codex permission profile",
      kind: "profile",
    }))
    if (!choices.length)
      for (const [id] of Object.entries(sandboxes))
        choices.push({
          id,
          title: id,
          description: "Native Codex sandbox mode",
          kind: "sandbox",
          allowed:
            !requirements.requirements?.allowedSandboxModes ||
            requirements.requirements.allowedSandboxModes.includes(
              id as "read-only" | "workspace-write" | "danger-full-access",
            ),
        })
    return {
      current: {
        approvalPolicy: current.approvalPolicy,
        approvalsReviewer: current.approvalsReviewer,
        sandbox: current.sandbox,
        activePermissionProfile: current.activePermissionProfile,
      },
      choices,
      approvalPolicies: policies.map((id) => ({
        id,
        allowed:
          !requirements.requirements?.allowedApprovalPolicies ||
          requirements.requirements.allowedApprovalPolicies.includes(id),
      })),
      busy: current.thread.status?.type === "active",
      scope:
        "Subsequent turns in this Codex thread. Does not edit config.toml.",
    }
  }
  private async profiles(cwd: string) {
    const data: PermissionProfileListResponse["data"] = []
    let cursor: string | null = null
    do {
      const page: PermissionProfileListResponse = await this.rpc.call(
        "permissionProfile/list",
        { cwd, cursor, limit: 100 },
      )
      data.push(...page.data)
      cursor = page.nextCursor
    } while (cursor)
    return data
  }
  async setPermissions(session: Projection, selection: PermissionSelection) {
    if (session.activeTurn)
      throw new Error(
        "Wait for the current turn to finish before changing permissions",
      )
    if (session.thread.canAcceptDirectInput === false)
      throw new Error("Change subagent permissions through its parent thread")
    const available = await this.permissions(session)
    if (available.busy)
      throw new Error(
        "Wait for the current turn to finish before changing permissions",
      )
    if (selection.profile && selection.sandbox)
      throw new Error("Choose a profile or sandbox, not both")
    if (!selection.profile && !selection.sandbox && !selection.approvalPolicy)
      throw new Error("Choose a permission setting")
    const choice = selection.profile ?? selection.sandbox
    if (
      choice &&
      !available.choices.some(
        (c) =>
          c.id === choice &&
          c.allowed &&
          c.kind === (selection.profile ? "profile" : "sandbox"),
      )
    )
      throw new Error("Permission setting is not allowed by Codex requirements")
    if (
      selection.approvalPolicy &&
      !available.approvalPolicies.some(
        (p) => p.id === selection.approvalPolicy && p.allowed,
      )
    )
      throw new Error("Approval policy is not allowed by Codex requirements")
    await this.rpc.call("thread/settings/update", {
      threadId: session.thread.id,
      ...(selection.profile ? { permissions: selection.profile } : {}),
      ...(selection.sandbox
        ? { sandboxPolicy: sandboxes[selection.sandbox] }
        : {}),
      ...(selection.approvalPolicy
        ? { approvalPolicy: selection.approvalPolicy as AskForApproval }
        : {}),
    })
    return this.permissions(session)
  }
  async mcp(session: Projection) {
    const data: ListMcpServerStatusResponse["data"] = []
    let cursor: string | null = null
    do {
      const page: ListMcpServerStatusResponse = await this.rpc.call(
        "mcpServerStatus/list",
        { threadId: session.thread.id, detail: "full", limit: 100, cursor },
      )
      data.push(...page.data)
      cursor = page.nextCursor
    } while (cursor)
    return data
  }
  async mcpLogin(session: Projection, name: string) {
    const available = await this.rpc.call<
      "mcpServerStatus/list",
      ListMcpServerStatusResponse
    >("mcpServerStatus/list", {
      threadId: session.thread.id,
      serverName: name,
      detail: "toolsAndAuthOnly",
      limit: 1,
    })
    if (!available.data.some((server) => server.name === name))
      throw new Error("Unknown MCP server")
    return this.rpc.call("mcpServer/oauth/login", {
      threadId: session.thread.id,
      name,
    })
  }
  async mcpReload() {
    return this.rpc.call("config/mcpServer/reload", undefined)
  }
}
export type NativeStatus = Awaited<ReturnType<NativeControls["status"]>>
export type NativePermissions = Awaited<
  ReturnType<NativeControls["permissions"]>
>
