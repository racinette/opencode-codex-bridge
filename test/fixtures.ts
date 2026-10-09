import type { Thread } from "../src/protocol/v2/Thread"
import type { Turn } from "../src/protocol/v2/Turn"
import type { ThreadItem } from "../src/protocol/v2/ThreadItem"
import type { Model } from "../src/protocol/v2/Model"
export const model: Model = {
  id: "test",
  model: "test",
  upgrade: null,
  upgradeInfo: null,
  availabilityNux: null,
  displayName: "Test Codex",
  description: "",
  modelSpecialty: null,
  hidden: false,
  supportedReasoningEfforts: [{ reasoningEffort: "low", description: "Low" }],
  defaultReasoningEffort: "low",
  inputModalities: ["text", "image"],
  supportsPersonality: false,
  multiAgentVersion: null,
  additionalSpeedTiers: [],
  serviceTiers: [],
  defaultServiceTier: null,
  availableAccessPrograms: null,
  isDefault: true,
}
export function thread(cwd = process.cwd(), id = crypto.randomUUID()): Thread {
  return {
    id,
    cwd,
    environments: null,
    extra: null,
    sessionId: id,
    forkedFromId: null,
    parentThreadId: null,
    preview: "",
    ephemeral: false,
    section: null,
    sectionEnteredAt: null,
    projectId: null,
    historyMode: "legacy",
    modelProvider: "openai",
    model: "test",
    reasoningEffort: "low",
    createdAt: 1700000000,
    updatedAt: 1700000000,
    recencyAt: null,
    status: { type: "idle" },
    path: null,
    cliVersion: "0.161.0",
    originator: null,
    source: "appServer",
    canAcceptDirectInput: true,
    threadSource: null,
    agentNickname: null,
    agentRole: null,
    gitInfo: null,
    name: null,
    daybreakEnabled: null,
    turns: [],
  }
}
export function turn(items: ThreadItem[] = [], id = crypto.randomUUID()): Turn {
  return {
    id,
    items,
    itemsView: "full",
    status: "inProgress",
    error: null,
    startedAt: 1700000000,
    completedAt: null,
    durationMs: null,
  }
}
export const user = (text: string, id = "user"): ThreadItem => ({
  type: "userMessage",
  id,
  clientId: null,
  content: [{ type: "text", text, text_elements: [] }],
})
export const agent = (text: string, id = "agent"): ThreadItem => ({
  type: "agentMessage",
  id,
  text,
  phase: null,
  memoryCitation: null,
  delivery: null,
  questions: null,
})
export const command = (
  status: "inProgress" | "completed" | "failed" = "inProgress",
  id = "command",
): ThreadItem => ({
  type: "commandExecution",
  id,
  pluginId: null,
  scriptPath: null,
  command: "echo tool-output",
  cwd: process.cwd(),
  processId: null,
  source: "agent",
  status,
  commandActions: [],
  aggregatedOutput: status === "completed" ? "tool-output\n" : null,
  exitCode: status === "completed" ? 0 : null,
  durationMs: null,
})
