import { CodexRpc } from "../src/rpc"
import type { ModelListResponse } from "../src/protocol/v2/ModelListResponse"
const rpc = new CodexRpc()
try {
  await rpc.initialize()
  const models = await rpc.call<"model/list", ModelListResponse>(
    "model/list",
    {},
  )
  console.log(
    JSON.stringify(
      models.data
        .filter((m) => !m.hidden)
        .map((m) => ({
          model: m.model,
          default: m.isDefault,
          efforts: m.supportedReasoningEfforts,
        })),
      null,
      2,
    ),
  )
} finally {
  await rpc.close()
}
