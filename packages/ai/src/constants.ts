/**
 * Package-level defaults for the AI satellite. Everything the streaming spine
 * treats as tunable lives here as a named constant with a sane default, so no
 * value is inlined at a call site and a host can override it through
 * `config.ai`. Provider-specific defaults (base URLs, models, the Anthropic
 * version header) live next to their providers, not here.
 */

/** The built-in provider selected when a tenant does not choose one. */
export const DEFAULT_AI_PROVIDER = 'claude'

/**
 * SSE heartbeat interval. A comment frame is written this often to hold the
 * connection open and surface a dead socket fast. It must stay below any
 * upstream proxy idle timeout (nginx / ALB around 60s, Cloudflare around 100s);
 * see the production checklist. Tunable via `config.ai.heartbeatMs`.
 */
export const DEFAULT_HEARTBEAT_MS = 15_000
