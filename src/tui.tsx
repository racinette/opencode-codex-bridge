import { registerNativeUI } from "./native-ui"
import { showElicitationForm } from "./elicitation-ui"
import { createEffect } from "solid-js"
import type { TuiPluginModule } from "@opencode-ai/plugin/tui"
import type { PendingRequest } from "./approvals"
import { registerCodexCommandNames } from "./command-names"

const plugin: TuiPluginModule = {
  id: "opencode-codex-bridge",
  async tui(api) {
    // Use the attached SDK transport so project config cannot route commands to a different bridge.
    const connected = await api.client.config.get({}, { throwOnError: true })
    const base = new URL(new URL(connected.request.url).origin)
    if (!["127.0.0.1", "localhost", "[::1]"].includes(base.hostname))
      throw new Error("Codex bridge endpoint must be local")
    api.lifecycle.onDispose(registerCodexCommandNames(api.keymap))
    const sessionID = () =>
      api.route.current.name === "session"
        ? (api.route.current.params?.sessionID as string | undefined)
        : undefined
    const call = async (path: string, body?: unknown) => {
      const response = await fetch(new URL(path, base), {
        method: body === undefined ? "GET" : "POST",
        headers:
          body === undefined
            ? undefined
            : { "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: api.lifecycle.signal,
      })
      const result = await response.json()
      if (!response.ok)
        throw new Error(result.data?.message ?? "Codex bridge request failed")
      return result
    }
    const report = (error: unknown) => {
      if (!api.lifecycle.signal.aborted)
        api.ui.toast({
          variant: "error",
          message: error instanceof Error ? error.message : String(error),
          duration: 5000,
        })
    }
    const command = async (name: string, args = "") => {
      const id = sessionID()
      if (!id) throw new Error("Open a Codex session first")
      return call(`/session/${id}/command`, { command: name, arguments: args })
    }
    const alert = (title: string, message: string) =>
      api.ui.dialog.replace(() => (
        <api.ui.DialogAlert title={title} message={message} />
      ))
    const prompt = (title: string, run: (text: string) => Promise<unknown>) =>
      api.ui.dialog.replace(() => (
        <api.ui.DialogPrompt
          title={title}
          onConfirm={(text) => {
            api.ui.dialog.clear()
            void run(text).catch(report)
          }}
        />
      ))
    const guarded = (run: () => Promise<unknown>) => () => {
      api.ui.dialog.clear()
      void run().catch(report)
    }
    const off = api.keymap.registerLayer({
      priority: 100,
      commands: [
        {
          name: "session.compact",
          title: "Compact Codex context",
          namespace: "palette",
          slashName: "compact",
          run: guarded(() => command("compact")),
        },
        {
          name: "session.fork",
          title: "Fork Codex conversation",
          namespace: "palette",
          slashName: "fork",
          run: guarded(async () => {
            const id = sessionID()
            if (!id) throw new Error("Open a Codex session first")
            const fork = await call(`/session/${id}/fork`, {})
            api.route.navigate("session", { sessionID: fork.id })
          }),
        },
        {
          name: "codex.review",
          title: "Review with Codex",
          namespace: "palette",
          slashName: "review",
          run: () =>
            api.ui.dialog.replace(() => (
              <api.ui.DialogSelect
                title="Codex review"
                options={[
                  { title: "Review uncommitted changes", value: "changes" },
                  { title: "Custom review instructions", value: "custom" },
                ]}
                onSelect={(option) => {
                  if (option.value === "custom")
                    prompt("Review instructions", (text) =>
                      command("review", text),
                    )
                  else guarded(() => command("review"))()
                }}
              />
            )),
        },
        {
          name: "codex.goal",
          title: "Set Codex goal",
          namespace: "palette",
          slashName: "goal",
          run: () => prompt("Codex goal", (text) => command("goal", text)),
        },
        {
          name: "codex.goal.status",
          title: "Show Codex goal",
          namespace: "palette",
          slashName: "goal-status",
          run: guarded(async () => {
            const result = await command("goal")
            alert("Codex goal", JSON.stringify(result, null, 2))
          }),
        },
        {
          name: "codex.goal.clear",
          title: "Clear Codex goal",
          namespace: "palette",
          slashName: "goal-clear",
          run: guarded(() => command("goal-clear")),
        },
        {
          name: "provider.connect",
          title: "Codex login",
          namespace: "palette",
          slashName: "connect",
          run: () =>
            alert(
              "Codex login",
              "Run codex login in a terminal, then restart this frontend.",
            ),
        },
        ...["undo", "redo", "share", "unshare"].map((name) => ({
          name: `session.${name}`,
          title: `${name} (unavailable with Codex)`,
          namespace: "palette",
          slashName: name,
          run: () =>
            alert(
              "Codex",
              `OpenCode ${name} is unavailable for native Codex conversations.`,
            ),
        })),
      ],
    })
    api.lifecycle.onDispose(off)
    api.lifecycle.onDispose(registerNativeUI({ api, sessionID, call, report }))
    let showing: string | undefined,
      busy = false
    const dismissed = new Set<string>()
    const formStates = new Map<string, { draft: Record<string, unknown> }>()
    const check = async () => {
      if (busy || api.lifecycle.signal.aborted) return
      const id = sessionID()
      if (!id) return
      busy = true
      try {
        const requests: PendingRequest[] = await call("/bridge/requests")
        for (const id of formStates.keys())
          if (!requests.some((request) => request.id === id))
            formStates.delete(id)
        if (showing && !requests.some((r) => r.id === showing)) {
          showing = undefined
          api.ui.dialog.clear()
        }
        if (api.ui.dialog.open || showing) return
        const request = requests.find(
          (r) =>
            r.sessionID === id && r.decisions.length && !dismissed.has(r.id),
        )
        if (!request) return
        showing = request.id
        const finish = () => {
          dismissed.add(request.id)
          showing = undefined
        }
        const choose = () => {
          api.ui.dialog.replace(
            () => (
              <api.ui.DialogSelect
                title={request.title}
                options={[
                  ...request.decisions.map((choice, index) => ({
                    title: choice.title,
                    value: index,
                  })),
                  { title: "View request details", value: -1 },
                ]}
                onSelect={(option) => {
                  if (
                    request.elicitation?.mode === "form" &&
                    option.value === 0
                  ) {
                    try {
                      const state = formStates.get(request.id) ?? {
                        draft: Object.create(null),
                      }
                      formStates.set(request.id, state)
                      showElicitationForm(
                        api,
                        request,
                        async (content) => {
                          await call(`/bridge/requests/${request.id}/reply`, {
                            choice: 0,
                            content,
                          })
                          finish()
                          api.ui.dialog.clear()
                        },
                        report,
                        choose,
                        finish,
                        () => {
                          dismissed.delete(request.id)
                          showing = request.id
                        },
                        state,
                      )
                      dismissed.delete(request.id)
                      showing = request.id
                    } catch (error) {
                      report(error)
                    }
                    return
                  }
                  if (option.value === -1) {
                    api.ui.dialog.replace(
                      () => (
                        <api.ui.DialogAlert
                          title={request.title}
                          message={request.details}
                          onConfirm={() => queueMicrotask(choose)}
                        />
                      ),
                      finish,
                    )
                    dismissed.delete(request.id)
                    showing = request.id
                    return
                  }
                  finish()
                  api.ui.dialog.clear()
                  void call(`/bridge/requests/${request.id}/reply`, {
                    choice: option.value,
                  }).catch(report)
                }}
              />
            ),
            finish,
          )
          dismissed.delete(request.id)
          showing = request.id
        }
        choose()
      } catch (error) {
        report(error)
      } finally {
        busy = false
      }
    }
    api.lifecycle.onDispose(
      api.keymap.registerLayer({
        priority: 200,
        commands: [
          {
            name: "codex.requests",
            title: "Review pending Codex requests",
            namespace: "palette",
            slashName: "requests",
            run: () => {
              api.ui.dialog.clear()
              dismissed.clear()
              showing = undefined
              void check()
            },
          },
        ],
      }),
    )
    const timer = setInterval(() => void check(), 350)
    api.lifecycle.onDispose(() => clearInterval(timer))
    createEffect(() => {
      const id = sessionID()
      if (id) api.state.session.permission(id)
      void check()
    })
  },
}
export default plugin
