import type { Event } from "@opencode-ai/sdk/v2"
export type EventInput = {
  [T in Event["type"]]: Omit<Extract<Event, { type: T }>, "id">
}[Event["type"]]
