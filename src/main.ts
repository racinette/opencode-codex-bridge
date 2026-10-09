import { parseArgs } from "node:util"
import { Bridge } from "./bridge"
import { daemonCommand } from "./daemon"
const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    cwd: { type: "string", default: process.cwd() },
    daemon: { type: "boolean", default: false },
    port: { type: "string", default: "4097" },
    "approval-policy": { type: "string" },
    sandbox: { type: "string" },
    "approvals-reviewer": { type: "string" },
  },
})
if (
  values["approvals-reviewer"] &&
  !["user", "auto_review", "guardian_subagent"].includes(
    values["approvals-reviewer"],
  )
)
  throw new Error("Invalid approvals reviewer")
const policies = ["untrusted", "on-request", "never"]
const sandboxes = ["read-only", "workspace-write", "danger-full-access"]
if (values["approval-policy"] && !policies.includes(values["approval-policy"]))
  throw new Error("Invalid approval policy")
if (values.sandbox && !sandboxes.includes(values.sandbox))
  throw new Error("Invalid sandbox mode")
const port = Number(values.port)
if (!Number.isInteger(port) || port < 0 || port > 65535)
  throw new Error("Invalid port")
const bridge = new Bridge({
  cwd: values.cwd!,
  command: values.daemon ? await daemonCommand() : undefined,
  native: {
    approvalsReviewer: values["approvals-reviewer"] as
      | "user"
      | "auto_review"
      | "guardian_subagent"
      | undefined,
    approvalPolicy: values["approval-policy"] as
      | "untrusted"
      | "on-request"
      | "never"
      | undefined,
    sandbox: values.sandbox as
      | "read-only"
      | "workspace-write"
      | "danger-full-access"
      | undefined,
  },
})
try {
  await bridge.initialize()
  console.log(
    `Codex bridge listening at ${bridge.listen(port)} for ${bridge.options.cwd}`,
  )
} catch (error) {
  await bridge.close()
  throw error
}
let closing = false
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, async () => {
    if (closing) return
    closing = true
    await bridge.close()
    process.exit(0)
  })
