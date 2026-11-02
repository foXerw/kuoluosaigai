// kuoluosaigai-bot-core 的唯一公开面（plan Task 1 Interfaces 清单）。
// 显式列举、不用 export *：Task 4 适配层与 P1 daemon 都依赖这张清单。
export { createContextBuffer } from './buffer.js'
export { createRhythm, trailingFamilyStreak, RHYTHM_DEFAULTS, createIdleScheduler } from './rhythm.js'
export { buildSystemPrompt, buildMessages, clampText, MAX_TEXT, IDLE_KICK, SYSTEM_TEMPLATE } from './prompt.js'
export { chatCompletion, LlmError } from './llm.js'
export { createBotConnection, BOT_BACKOFF } from './connection.js'
export { createBotRunner } from './runner.js'
export { mergeHistory } from './historyMerge.js'
export { HEARTBEAT_MS } from './timing.js'
export { createNullLease } from './deck.js'
