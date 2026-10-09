// The daemon uses WebSocket frames over a Unix socket, while CodexRpc uses
// JSON lines. Run ws under Node: Bun 1.3.14 does not emit HTTP Upgrade events
// correctly for ws over Unix sockets.
import WebSocket from "ws"
import { createInterface } from "node:readline"

const socketPath = process.argv[2]
if (!socketPath || !socketPath.startsWith("/"))
  throw new Error("Expected an absolute Codex daemon socket path")

const socket = new WebSocket(`ws+unix://${socketPath}:/`, {
  handshakeTimeout: 5000,
})
let input
const fail = (error) => {
  console.error(`Codex daemon connection: ${error.message}`)
  socket.terminate()
  process.exit(1)
}
socket.on("error", fail)
socket.on("open", () => {
  input = createInterface({ input: process.stdin, crlfDelay: Infinity })
  input.on("line", (line) => {
    if (!line.trim()) return
    socket.send(line, (error) => {
      if (error) fail(error)
    })
  })
  input.on("close", () => socket.close())
})
socket.on("message", (data, binary) => {
  if (binary) return fail(new Error("Expected a JSON text frame"))
  if (!process.stdout.write(`${data.toString()}\n`)) socket.pause()
})
process.stdout.on("drain", () => socket.resume())
process.stdout.on("error", fail)
socket.on("close", (code) => {
  input?.close()
  // End stdout so pending RPCs see the disconnect rather than a timeout.
  process.stdout.end(() => process.exit(code === 1000 ? 0 : 1))
})
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => {
    socket.terminate()
    process.exit(0)
  })
