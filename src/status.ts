import type { NativeStatus } from "./native-controls"
const reported = (value: unknown) =>
  value == null
    ? "Not reported by Codex"
    : typeof value === "object"
      ? JSON.stringify(value)
      : String(value)
export function statusText(status: NativeStatus) {
  const sandbox = status.sandbox
  const lines = [
    `Thread: ${status.threadId}`,
    `Directory: ${status.cwd}`,
    `State: ${status.status?.type ?? "Not reported"}`,
    `Model: ${reported(status.model)}`,
    `Reasoning: ${reported(status.reasoningEffort)}`,
    `Mode: ${reported(status.mode)}`,
    `Service tier: ${reported(status.serviceTier)}`,
    "",
    `Permission profile: ${reported(status.activePermissionProfile?.id)}`,
    `Approval policy: ${reported(status.approvalPolicy)}`,
    `Reviewer: ${reported(status.approvalsReviewer)}`,
    `Sandbox: ${reported(sandbox?.type)}`,
  ]
  if (sandbox && "networkAccess" in sandbox)
    lines.push(`Network: ${reported(sandbox.networkAccess)}`)
  if (sandbox?.type === "workspaceWrite")
    lines.push(
      `Writable roots: ${[status.cwd, ...sandbox.writableRoots].join(", ")}`,
    )
  if (status.runtimeWorkspaceRoots?.length)
    lines.push(`Workspace roots: ${status.runtimeWorkspaceRoots.join(", ")}`)
  const usage = status.tokenUsage
  lines.push("", `Context window: ${reported(usage?.modelContextWindow)}`)
  if (usage)
    lines.push(
      `Latest input tokens: ${usage.last.inputTokens}`,
      `Latest cached input: ${usage.last.cachedInputTokens}`,
      `Latest output tokens: ${usage.last.outputTokens}`,
      `Total thread tokens: ${usage.total.totalTokens}`,
    )
  else lines.push("Token usage: Not reported on this connection yet")
  const account = status.account
  lines.push("", `Account: ${account?.type ?? "Not reported"}`)
  if (account?.type === "chatgpt")
    lines.push(
      `Plan: ${account.planType}`,
      `Email: ${account.email ?? "Not reported"}`,
    )
  if (status.accountError)
    lines.push(`Account information unavailable: ${status.accountError}`)
  if (status.rateLimits) {
    const limits = status.rateLimits.rateLimitsByLimitId ?? {
      codex: status.rateLimits.rateLimits,
    }
    lines.push(
      `Included usage allowed: ${reported(status.rateLimits.ordinaryUsageAllowed)}`,
    )
    for (const [id, limit] of Object.entries(limits)) {
      if (!limit) continue
      for (const [label, window] of [
        ["primary", limit.primary],
        ["secondary", limit.secondary],
      ] as const) {
        if (!window) continue
        lines.push(
          `${limit.limitName ?? id} ${label}: ${window.usedPercent}% used${window.windowDurationMins == null ? "" : ` over ${window.windowDurationMins} minutes`}${window.resetsAt == null ? "" : `; resets ${new Date(window.resetsAt * 1000).toLocaleString()}`}`,
        )
      }
    }
  } else
    lines.push(`Account limits: ${status.rateLimitsError ?? "Not reported"}`)
  return lines.join("\n")
}
