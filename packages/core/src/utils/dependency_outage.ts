/**
 * Classifies whether an error thrown by a database driver means the backing
 * dependency is unavailable (connection severed, refused, or the server is
 * shutting down) as opposed to an ordinary application-level query error (a
 * constraint violation, a type cast, a syntax mistake).
 *
 * This is the query-phase sibling of the connect-phase mapping in
 * `extensions/request.ts`: once a tenant is connected, a request can still hit a
 * backend that dies mid-flight (a failover, an admin `pg_terminate_backend`, a
 * crash). Such an error must surface as a clean, retry-able 503
 * `DependencyUnavailableException` rather than an opaque 500 — but a unique
 * violation or a check-constraint failure must pass straight through to the
 * host's handler untouched. The allowlist below is deliberately narrow: only
 * signatures that unambiguously mean "the connection/server is gone".
 */

/**
 * Node socket-level error codes that mean the TCP connection to Postgres was
 * lost or could not be made.
 */
const OUTAGE_ERRNO = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'EPIPE',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EAI_AGAIN',
])

/**
 * PostgreSQL SQLSTATE classes/codes for connection loss and server shutdown.
 * Class 08 = "Connection Exception"; 57P0x = operator/crash shutdown; 53300 =
 * too_many_connections (the server actively refused a new backend).
 */
const OUTAGE_SQLSTATE = new Set([
  '08000', // connection_exception
  '08003', // connection_does_not_exist
  '08006', // connection_failure
  '08001', // sqlclient_unable_to_establish_sqlconnection
  '08004', // sqlserver_rejected_establishment_of_sqlconnection
  '08007', // transaction_resolution_unknown
  '57P01', // admin_shutdown (pg_terminate_backend)
  '57P02', // crash_shutdown
  '57P03', // cannot_connect_now
  '53300', // too_many_connections
])

/**
 * Substrings in the node-postgres error message for a backend that vanished.
 * node-postgres often reports these with no `code`, so the message is the only
 * signal. Matched case-insensitively.
 */
const OUTAGE_MESSAGES = [
  'connection terminated',
  'server closed the connection',
  'terminating connection due to administrator command',
  'connection ended unexpectedly',
  'client has encountered a connection error',
  'connection not queryable',
]

/**
 * True when `err` indicates the database dependency is unavailable (connection
 * severed/refused or server shutting down), and therefore should map to a 503.
 * Returns false for ordinary query errors (constraint violations, etc.).
 */
export function isDependencyOutageError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false

  const code = (err as { code?: unknown }).code
  if (typeof code === 'string') {
    if (OUTAGE_ERRNO.has(code)) return true
    if (OUTAGE_SQLSTATE.has(code)) return true
  }

  const message = (err as { message?: unknown }).message
  if (typeof message === 'string') {
    const lower = message.toLowerCase()
    if (OUTAGE_MESSAGES.some((m) => lower.includes(m))) return true
  }

  return false
}
