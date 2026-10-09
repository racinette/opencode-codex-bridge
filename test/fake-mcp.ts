// Minimal stdio MCP peer for live app-server interoperability checks.
const send = (frame: unknown) =>
  process.stdout.write(
    JSON.stringify({ jsonrpc: "2.0", ...(frame as object) }) + "\n",
  )
let buffer = ""
const pending = new Map<string, number | string>()
for await (const chunk of Bun.stdin.stream()) {
  buffer += new TextDecoder().decode(chunk)
  for (;;) {
    const pos = buffer.indexOf("\n")
    if (pos < 0) break
    const line = buffer.slice(0, pos)
    buffer = buffer.slice(pos + 1)
    if (!line) continue
    const frame = JSON.parse(line)
    if (!frame.method && pending.has(String(frame.id))) {
      const id = pending.get(String(frame.id))!
      pending.delete(String(frame.id))
      send({
        id,
        result: {
          content: [{ type: "text", text: JSON.stringify(frame.result) }],
        },
      })
      continue
    }
    if (frame.id === undefined) continue
    const reply = (result: unknown) => send({ id: frame.id, result })
    if (frame.method === "initialize")
      reply({
        protocolVersion: frame.params.protocolVersion,
        capabilities: { tools: {}, resources: {} },
        serverInfo: { name: "bridge-parity", version: "1" },
      })
    else if (frame.method === "tools/list")
      reply({
        tools: [
          {
            name: "form",
            description: "Request a typed form",
            inputSchema: { type: "object", properties: {} },
          },
        ],
      })
    else if (frame.method === "resources/list")
      reply({ resources: [{ name: "notes", uri: "notes://parity" }] })
    else if (frame.method === "resources/templates/list")
      reply({ resourceTemplates: [] })
    else if (frame.method === "tools/call") {
      const id = crypto.randomUUID()
      pending.set(id, frame.id)
      send({
        id,
        method: "elicitation/create",
        params: {
          mode: "form",
          message: "Live MCP form",
          requestedSchema: {
            type: "object",
            properties: {
              count: { type: "integer", minimum: 1 },
              confirm: { type: "boolean" },
            },
            required: ["count", "confirm"],
          },
        },
      })
    } else if (frame.method === "ping") reply({})
    else
      send({
        id: frame.id,
        error: { code: -32601, message: "Unsupported fixture MCP method" },
      })
  }
}

export {}
