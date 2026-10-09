import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { PendingRequest } from "./approvals"
import { formValidator, validateForm, object } from "./elicitation"

export function showElicitationForm(
  api: TuiPluginApi,
  request: PendingRequest,
  submit: (content: unknown) => Promise<void>,
  report: (error: unknown) => void,
  back: () => void,
  dismiss: () => void,
  activate: () => void,
  state: { draft: Record<string, unknown> } = { draft: Object.create(null) },
) {
  const replace = (render: Parameters<typeof api.ui.dialog.replace>[0]) => {
    api.ui.dialog.replace(render, dismiss)
    activate()
  }
  const schema = request.elicitation?.schema
  let draft = state.draft
  const validator = formValidator(schema)
  const properties =
    object(schema) && object(schema.properties) ? schema.properties : {}
  const required =
    object(schema) && Array.isArray(schema.required) ? schema.required : []
  for (const [key, field] of Object.entries(properties))
    if (object(field) && field.default !== undefined && !(key in draft))
      draft[key] = structuredClone(field.default)
  let sending = false
  const send = async () => {
    if (sending) return
    try {
      validateForm(validator, draft)
      sending = true
      await submit(draft)
    } catch (error) {
      sending = false
      report(error)
      show()
    }
  }
  const raw = () =>
    replace(() => (
      <api.ui.DialogPrompt
        title="MCP form · JSON"
        placeholder="Enter a JSON object; validated before submission"
        value={JSON.stringify(draft)}
        onConfirm={(text) => {
          try {
            const value = JSON.parse(text)
            if (!object(value)) throw new Error("Expected a JSON object")
            draft = Object.assign(Object.create(null), value)
            state.draft = draft
            show()
          } catch (error) {
            report(error)
            raw()
          }
        }}
      />
    ))
  const edit = (key: string, field: Record<string, unknown>) => {
    const title = typeof field.title === "string" ? field.title : key
    const choices = Array.isArray(field.enum)
      ? field.enum.map((value, index) => ({
          value,
          title:
            Array.isArray(field.enumNames) &&
            typeof field.enumNames[index] === "string"
              ? (field.enumNames[index] as string)
              : String(value),
        }))
      : Array.isArray(field.oneOf) &&
          field.oneOf.every((item) => object(item) && "const" in item)
        ? field.oneOf.map((item) => ({
            value: (item as Record<string, unknown>).const,
            title: String(
              (item as Record<string, unknown>).title ??
                (item as Record<string, unknown>).const,
            ),
          }))
        : null
    if (field.type === "boolean" || choices) {
      const values = choices ?? [
        { title: "Yes", value: true },
        { title: "No", value: false },
      ]
      replace(() => (
        <api.ui.DialogSelect
          title={title}
          options={[
            ...values.map((item, index) => ({
              title: item.title,
              value: index,
            })),
            ...(!required.includes(key)
              ? [{ title: "Leave unset", value: -1 }]
              : []),
          ]}
          onSelect={(option) => {
            if (option.value < 0) delete draft[key]
            else draft[key] = values[option.value].value
            show()
          }}
        />
      ))
      return
    }
    replace(() => (
      <api.ui.DialogPrompt
        title={title}
        placeholder={
          typeof field.description === "string"
            ? field.description
            : String(field.type ?? "JSON value")
        }
        value={
          draft[key] === undefined
            ? ""
            : typeof draft[key] === "string"
              ? (draft[key] as string)
              : JSON.stringify(draft[key])
        }
        onConfirm={(text) => {
          try {
            if (!text && !required.includes(key)) delete draft[key]
            else if (field.type === "string") draft[key] = text
            else draft[key] = JSON.parse(text)
            show()
          } catch (error) {
            report(error)
            edit(key, field)
          }
        }}
      />
    ))
  }
  const preview = () =>
    replace(() => (
      <api.ui.DialogAlert
        title="MCP form · review"
        message={request.details + "\n\n" + JSON.stringify(draft, null, 2)}
        onConfirm={() => queueMicrotask(show)}
      />
    ))
  const show = () =>
    replace(() => (
      <api.ui.DialogSelect
        title={request.title}
        options={[
          ...Object.entries(properties).map(([key, field]) => ({
            title: `${object(field) && typeof field.title === "string" ? field.title : key}${required.includes(key) ? " *" : ""}: ${draft[key] === undefined ? "unset" : JSON.stringify(draft[key])}`,
            value: key,
            category: "Fields",
            description:
              object(field) && typeof field.description === "string"
                ? field.description
                : undefined,
          })),
          {
            title: "Edit response as JSON",
            value: "@json",
            category: "Actions",
          },
          { title: "Review response", value: "@review", category: "Actions" },
          { title: "Submit form", value: "@submit", category: "Actions" },
          { title: "Back to request", value: "@back", category: "Actions" },
        ]}
        onSelect={(option) => {
          if (option.category === "Fields") {
            const field = properties[option.value]
            edit(option.value, object(field) ? field : {})
          } else if (option.value === "@json") raw()
          else if (option.value === "@review") preview()
          else if (option.value === "@submit") void send()
          else back()
        }}
      />
    ))
  show()
}
