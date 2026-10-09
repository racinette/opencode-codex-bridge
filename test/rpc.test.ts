import { expect, test } from "bun:test"
import { CodexRpc } from "../src/rpc"

const command = (source: string) => [process.execPath, "-e", source]
test("stdio transport accepts split frames and matches out-of-order responses", async () => {
  const source = `let input='';let calls=[];process.stdin.on('data',chunk=>{input+=chunk;let end;while((end=input.indexOf('\\n'))>=0){const line=input.slice(0,end);input=input.slice(end+1);calls.push(JSON.parse(line));if(calls.length===2){const frames=calls.toReversed().map(c=>JSON.stringify({id:c.id,result:{method:c.method}})+'\\n').join('');process.stdout.write(frames.slice(0,5));setTimeout(()=>process.stdout.write(frames.slice(5)),5)}}})`
  const rpc = new CodexRpc(command(source))
  try {
    const [a, b] = await Promise.all([
      rpc.call("model/list", {}),
      rpc.call("config/read", {}),
    ])
    expect(a).toEqual({ method: "model/list" })
    expect(b).toEqual({ method: "config/read" })
  } finally {
    await rpc.close()
  }
})
test("app-server exit rejects pending requests", async () => {
  const rpc = new CodexRpc(
    command("process.stdin.once('data',()=>process.exit(7))"),
  )
  try {
    await expect(rpc.call("model/list", {})).rejects.toThrow("exited (7)")
  } finally {
    await rpc.close()
  }
})
test("malformed stdout rejects pending requests without hanging", async () => {
  const rpc = new CodexRpc(
    command(
      "process.stdin.once('data',()=>process.stdout.write('bad json\\n'))",
    ),
  )
  try {
    await expect(rpc.call("model/list", {})).rejects.toThrow()
  } finally {
    await rpc.close()
  }
})
test("missing reply times out and closing rejects further calls", async () => {
  const rpc = new CodexRpc(command("setInterval(()=>{},1000)"))
  await expect(rpc.call("model/list", {}, 10)).rejects.toThrow("timed out")
  await rpc.close()
  await expect(rpc.call("model/list", {})).rejects.toThrow("closed")
})
