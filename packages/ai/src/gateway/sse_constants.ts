/**
 * SSE wire constants for the gateway. Named so no frame string is inlined at a
 * call site. The heartbeat interval default lives in the package `constants.ts`
 * (it is config-tunable via `AiConfig.heartbeatMs`); these two are the frame
 * shapes themselves.
 */

/** The SSE event name used when a fragment does not set its own. */
export const DEFAULT_EVENT = 'token'

/** An SSE comment frame, written as the heartbeat to hold the connection open. */
export const HEARTBEAT_FRAME = ':\n\n'

/**
 * The SSE event carrying a human-in-the-loop action confirmation challenge
 * (WS-AI-11 Phase 3a). Its `data:` is a JSON `{ id, name, summary, token,
 * expiresAt }`: the client shows `summary` to the human and, on agreement,
 * echoes `token` back in the `X-Ai-Tool-Confirmation` header. It is deliberately
 * NOT {@link DEFAULT_EVENT}, so `reconstructAssistantText` (which allow-lists
 * only the default event) never folds a live capability token into the persisted
 * assistant turn.
 */
export const TOOL_CONFIRMATION_EVENT = 'tool_confirmation_required'
