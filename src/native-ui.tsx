import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { Session } from "@opencode-ai/sdk/v2"
import type {
  NativePermissions,
  NativeStatus,
  PermissionSelection,
} from "./native-controls"
import type { McpServerStatus } from "./protocol/v2/McpServerStatus"
import { statusText } from "./status"

type Helpers = {
  api: TuiPluginApi
  sessionID: () => string | undefined
  call: (path: string, body?: unknown) => Promise<any>
  report: (error: unknown) => void
}
export function registerNativeUI({ api, sessionID, call, report }: Helpers) {
  const id = () => {
    const value = sessionID()
    if (!value) throw new Error("Open a Codex conversation first")
    return value
  }
  const alert = (title: string, message: string, onConfirm?: () => void) =>
    api.ui.dialog.replace(() => (
      <api.ui.DialogAlert
        title={title}
        message={message}
        onConfirm={onConfirm ? () => queueMicrotask(onConfirm) : undefined}
      />
    ))
  const guarded = (run: () => Promise<unknown>) => () => {
    api.ui.dialog.clear()
    void run().catch(report)
  }
  const permissions = async () => {
    const currentID = id()
    const info: NativePermissions = await call(
      `/session/${currentID}/permissions`,
    )
    const apply = async (selection: PermissionSelection) => {
      await call(`/session/${currentID}/permissions`, selection)
      api.ui.dialog.clear()
      api.ui.toast({
        variant: "success",
        message:
          "Codex permissions updated for subsequent turns in this thread",
      })
    }
    api.ui.dialog.replace(() => (
      <api.ui.DialogSelect
        title="Codex permissions"
        options={[
          {
            title: "View current permissions",
            value: "@current",
            category: "Current thread",
          },
          ...info.choices.map((choice) => ({
            title: choice.title,
            value: choice.id,
            description: choice.description,
            disabled: !choice.allowed,
            category: "Permission profiles",
          })),
          {
            title: "Change approval policy",
            value: "@approval",
            category: "Approval requests",
          },
        ]}
        onSelect={(option) => {
          if (option.value === "@current")
            alert(
              "Current Codex permissions",
              JSON.stringify(info.current, null, 2) + "\n\n" + info.scope,
              () => void permissions().catch(report),
            )
          else if (option.value === "@approval")
            api.ui.dialog.replace(() => (
              <api.ui.DialogSelect
                title="Codex approval policy"
                options={info.approvalPolicies.map((policy) => ({
                  title: policy.id,
                  value: policy.id,
                  disabled: !policy.allowed,
                  description:
                    policy.id === "never"
                      ? "Never prompt for escalation; sandbox restrictions still apply"
                      : policy.id === "untrusted"
                        ? "Ask before running untrusted commands"
                        : "Ask when an action needs escalation",
                }))}
                onSelect={(policy) =>
                  void apply({ approvalPolicy: policy.value }).catch(report)
                }
              />
            ))
          else {
            const choice = info.choices.find(
              (choice) => choice.id === option.value,
            )!
            const selection =
              choice.kind === "profile"
                ? { profile: choice.id }
                : { sandbox: choice.id }
            if (choice.id.includes("danger-full-access"))
              api.ui.dialog.replace(() => (
                <api.ui.DialogConfirm
                  title="Allow full access for this Codex thread?"
                  message="This removes Codex sandbox restrictions for subsequent turns. Your configured approval policy still applies."
                  onConfirm={() => void apply(selection).catch(report)}
                />
              ))
            else void apply(selection).catch(report)
          }
        }}
      />
    ))
  }
  const mcp = async () => {
    const currentID = id()
    const servers: McpServerStatus[] = await call(`/session/${currentID}/mcp`)
    const details = (server: McpServerStatus) => {
      api.ui.dialog.replace(() => (
        <api.ui.DialogSelect
          title={`MCP · ${server.name}`}
          options={[
            {
              title: "View tools, resources, and connection details",
              value: "inventory",
            },
            {
              title: "Authenticate with OAuth",
              value: "login",
              disabled: server.authStatus === "unsupported",
            },
            { title: "Back to servers", value: "back" },
          ]}
          onSelect={(option) => {
            if (option.value === "inventory")
              alert(
                `MCP · ${server.name}`,
                [
                  `Connection: ${server.runtimeStatus == null ? "Not reported" : JSON.stringify(server.runtimeStatus)}`,
                  `Authentication: ${server.authStatus}`,
                  ...(server.toolsError
                    ? [`Tool discovery: ${server.toolsError}`]
                    : []),
                  "",
                  "Tools:",
                  ...Object.values(server.tools)
                    .filter((tool) => tool !== undefined)
                    .map(
                      (tool) =>
                        `${tool.name}${tool.description ? " · " + tool.description : ""}`,
                    ),
                  "",
                  "Resources:",
                  ...server.resources.map(
                    (resource) => `${resource.name}: ${resource.uri}`,
                  ),
                  "",
                  "Resource templates:",
                  ...server.resourceTemplates.map(
                    (resource) => `${resource.name}: ${resource.uriTemplate}`,
                  ),
                ].join("\n"),
                () => details(server),
              )
            else if (option.value === "login")
              void call(`/session/${currentID}/mcp`, {
                mcpAction: "login",
                serverName: server.name,
              })
                .then((result) =>
                  alert(
                    "MCP authorization",
                    "Open this URL in your browser to finish authentication, then refresh the server list:\n\n" +
                      result.authorizationUrl,
                    () => void mcp().catch(report),
                  ),
                )
                .catch(report)
            else void mcp().catch(report)
          }}
        />
      ))
    }
    api.ui.dialog.replace(() => (
      <api.ui.DialogSelect
        title="Codex MCP servers"
        options={[
          ...servers.map((server) => ({
            title: `${server.name} · ${Object.keys(server.tools).length} tools · ${server.authStatus}`,
            value: server.name,
            category: "Servers",
          })),
          {
            title: "Refresh server list",
            value: "@refresh",
            category: "Actions",
          },
          {
            title: "Reload Codex MCP configuration",
            value: "@reload",
            category: "Actions",
          },
        ]}
        onSelect={(option) => {
          if (option.category === "Servers")
            details(servers.find((server) => server.name === option.value)!)
          else if (option.value === "@reload")
            void call(`/session/${currentID}/mcp`, { mcpAction: "reload" })
              .then(() => {
                api.ui.toast({
                  variant: "info",
                  message: "Codex MCP reload queued",
                })
                return mcp()
              })
              .catch(report)
          else void mcp().catch(report)
        }}
      />
    ))
  }
  const agents = async () => {
    const threads: Session[] = await call(`/session/${id()}/agents`)
    api.ui.dialog.replace(() => (
      <api.ui.DialogSelect
        title="Codex agent threads"
        options={threads.map((thread) => ({
          title: `${thread.metadata?.codexParentThreadID ? String(thread.metadata?.codexAgentNickname ?? thread.metadata?.codexAgentRole ?? "Subagent") : "Main agent"} · ${thread.title}`,
          description: thread.metadata?.codexStatus
            ? JSON.stringify(thread.metadata.codexStatus)
            : undefined,
          value: thread.id,
        }))}
        onSelect={(option) => {
          const thread = threads.find((thread) => thread.id === option.value)!
          api.ui.dialog.clear()
          api.route.navigate("session", { sessionID: thread.id })
          if (thread.metadata?.codexCanAcceptDirectInput === false)
            api.ui.toast({
              variant: "info",
              message:
                "This subagent is controlled by its parent. Up Arrow returns to the parent; the command palette can switch agent threads.",
            })
        }}
      />
    ))
  }
  return api.keymap.registerLayer({
    priority: 200,
    commands: [
      {
        name: "opencode.status",
        title: "Codex session status",
        namespace: "palette",
        slashName: "status",
        run: guarded(async () => {
          const status: NativeStatus = await call(`/session/${id()}/status`)
          alert("Codex status", statusText(status))
        }),
      },
      {
        name: "permission.mode",
        title: "Change Codex permissions",
        namespace: "palette",
        slashName: "permissions",
        run: guarded(permissions),
      },
      {
        name: "mcp.list",
        title: "Codex MCP servers",
        namespace: "palette",
        slashName: "mcp",
        slashAliases: ["mcps"],
        run: guarded(mcp),
      },
      {
        name: "codex.subagents",
        title: "Switch Codex agent thread",
        namespace: "palette",
        slashName: "agent",
        slashAliases: ["subagents"],
        run: guarded(agents),
      },
    ],
  })
}
