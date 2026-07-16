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
