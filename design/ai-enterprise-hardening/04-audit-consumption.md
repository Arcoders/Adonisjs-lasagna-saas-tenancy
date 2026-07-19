# 04 Audit consumption pillar (Wave 4)

The write side of the AI audit trail is already enterprise-grade and must not be rebuilt: a per-tenant
`seq` + sha256 hash chain, serialized by a transaction-scoped advisory lock, DB-trigger append-only,
non-PII, fail-closed on write. What is missing is everything a human or a SIEM does with that chain
AFTER it lands: read it, export it in a re-verifiable form, verify it incrementally without re-walking
history, retain it without violating append-only, and alert on abnormal guard-trip velocity. Wave 4
builds those five consumption surfaces on the existing chain and holds one invariant above all others:
**no consumption path ever rewrites a `prev_checksum`, a `checksum`, or a `seq`.** Consumption reads and
appends new artifacts (checkpoints, exports, alerts); it never mutates a chained row, because mutating one
is exactly the tampering the chain exists to catch.

This wave also corrects one latent write-side bug it is adjacent to (the audit actor is mislabeled
`system` where core now models a first-class `ai` actor) and clears one stale docblock.

## 1. What already ships

The chain and its guarantees are catalogued in `00-foundation.md` section 2 ("Audit integrity"). The parts
Wave 4 consumes directly:

- **The column contract.** `AI_AUDIT_COLUMNS` (`ai_audit_writer.ts:119-139`) is the single source of truth
  for the persisted column order, including the three chain fields `seq`, `checksum`, `prev_checksum`
  (`ai_audit_writer.ts:122-124`). Both the INSERT and the readback bind through it.
- **The canonical serialization.** `canonicalAuditFields` (`ai_audit_writer.ts:149-168`) is a POSITIONAL
  array with every value coerced to a stable type, so a checksum recomputes byte-identical whether built
  from an in-memory write or a row read back through timestamptz/bigint columns. Any external re-walk must
  reproduce this exact serialization.
- **The verify walk.** `verify(tenantId?)` (`ai_audit_writer.ts:279-319`) is the safe raw-SQL read pattern
  to mirror: a `SELECT` of the module-constant column list from the `qualifyBackofficeTable`-qualified
  `#table`, with the tenant filter as a `?` bind and `ORDER BY tenant_id ASC, seq ASC`
  (`ai_audit_writer.ts:285-288`). It folds per-tenant, resetting `prevSeq`/`prevChecksum` at each
  `tenant_id` boundary (`ai_audit_writer.ts:298-302`), and returns the first `gap` / `prev_link` /
  `checksum` break.
- **The injected tenancy deps.** The writer takes `connectionName` and `schemaName` as injected
  dependencies (`ai_audit_writer.ts:45-55`), qualifying the table through `qualifyBackofficeTable` rather
  than a `'backoffice'` literal, and re-asserts `activeScopeTenantId()` equals the row tenant before any
  raw query (`ai_audit_writer.ts:237-247`) because raw SQL bypasses the kernel ContextSeal. Every Wave 4
  reader inherits both.
- **The cron-ready verify command.** `tenant:ai:audit:verify` (`ai_audit_verify.ts`) sets `exitCode` to 1
  on the first break (`ai_audit_verify.ts:54`) and documents the zero-new-code alerting path
  `node ace tenant:ai:audit:verify --json || alert` in its own header (`ai_audit_verify.ts:12`).
- **The external anchor fan-out.** Each committed row is already mapped onto the kernel `AuditLogEntry` and
  fanned to the host `AuditLogDestinationRegistry` (`ai_audit_writer.ts:380-398`), time-bounded by
  `AI_AUDIT_ANCHOR_TIMEOUT_MS` (`constants.ts:236`). Wave 4's anomaly alerts reuse this same destination
  registry rather than inventing a parallel sink.
- **The prior-art shape to copy (and the one to avoid).** Core's `tenant:audit:export`
  (`tenant_audit_export.ts:56-104`) is the streaming + backpressure template: one destination opened once,
  `write` awaits `drain` (`tenant_audit_export.ts:67-70`), batches of 500. Its CSV escaping
  (`audit_export.ts:57-64`) neutralizes spreadsheet formula-injection by prefixing an apostrophe to any
  cell starting `=+-@`/tab/CR, then RFC-4180 quoting. But note two things it does NOT do that Wave 4 must:
  its JSON path emits a single JSON **array** (`tenant_audit_export.ts:73,85,93`), not NDJSON; and it reads
  a Lucid model (`AuditLogService` over `TenantAuditLog`). There is **no Lucid model for `ai_audit_logs`**
  by design (the writer is pure parameterized raw SQL), so Wave 4's reader mirrors the writer's
  `rawQuery` + `AI_AUDIT_COLUMNS` pattern, not the admin controller's Lucid path.

## 2. The gap

Stated as concrete failures the current code exhibits:

1. **No read/query API.** A compliance officer who needs "every aborted `tool` row for tenant T in
   March, by this principal hash" has no supported surface. `verify()` re-walks but returns only a
   pass/fail, never rows. The only other reader, the admin `AuditLogsController`
   (`audit_logs_controller.ts:8-30`), reads `tenant_audit_logs` via Lucid and knows nothing about
   `ai_audit_logs`.
2. **No export.** The chain cannot leave the database in a form an external verifier can re-walk. Core's
   `tenant:audit:export` covers `tenant_audit_logs`, not the AI chain, and its JSON-array format is not
   line-oriented for SIEM ingestion.
3. **No incremental verify.** `verify()` re-walks the ENTIRE chain every run (`ai_audit_writer.ts:285-286`
   has no `seq` lower bound). At tens of millions of rows the nightly cron reads the whole table, so verify
   cost grows unbounded with history.
4. **No retention story.** Rows accumulate forever. There is no supported way to age out old segments, and
   any naive `DELETE`/`TRUNCATE` is (correctly) rejected by the append-only triggers, so an operator under
   storage pressure has no sanctioned path at all.
5. **No anomaly alerting.** Guard trips are dispatched on the `IsthmusGuardTripped` bus and metered, but
   nothing watches their VELOCITY. A single tenant/principal driving a burst of `guard.ai_scope_mismatch`
   or `guard.ai_rate_limited` trips is invisible until someone reads a dashboard.
6. **A mislabeled actor (write-side correctness bug).** Core now models a first-class `ai` actor
   (`tenant_audit_log.ts:12`), but the anchor mapping still writes `actorType: 'system'`
   (`ai_audit_writer.ts:412`). "The assistant did this" is deliberately queryable per the model's own
   docblock, yet the AI satellite's own rows anchor as `system`, defeating the distinction at the source.
7. **A stale docblock.** `audit_seam.ts:4-8` still carries `TODO(WS-AI-7)` claiming "the default sink is a
   no-op" and "the real append-only audit lands there", though the real sinks (`PgChatAuditSink` et al.)
   ship in `audit_sinks.ts` and are wired live. The comment now misdescribes the system.

## 3. The root-cause mitigation

Every surface below is a seam or a validated config field, every bound is a named constant in
`constants.ts`, and every fail posture is stated with its reason. Schema and connection are always the
injected `schemaName` / `connectionName`, never a `'backoffice'` literal (guarded by
`check-no-hardcoded-backoffice`).

### 3.1 Read/query API: `AiAuditReader` + `ai_audit_controller.ts`

A new `AiAuditReader` container singleton takes the SAME injected deps as `AiAuditWriter`
(`getDb`, `connectionName`, `schemaName`, `activeScopeTenantId`), so it inherits the qualified-table and
re-assert-before-raw-SQL discipline for free. Its `query()` builds ONE `SELECT` of `AI_AUDIT_COLUMNS`
(`ai_audit_writer.ts:119-139`) from the `qualifyBackofficeTable`-qualified table, with EVERY filter as a
`?` bind, mirroring the safe pattern at `ai_audit_writer.ts:285-288` (not the admin Lucid path, since
`ai_audit_logs` has no model). It is SELECT-only: the method never emits INSERT/UPDATE/DELETE, the same way
the admin reader delegates to a read service (`audit_logs_controller.ts:24-29`).

Filters, all optional, all `?`-bound: `tenantId`, `op` (`chat`/`embedding`/`retrieval`/`tool`, validated
against the `AiAuditRow['op']` union), `outcome`, a `[from, to]` time range on `occurred_at`, and
`principalHash` (a caller queries by the one-way hash, never a raw principal, so the reader cannot become a
PII lookup). Ordering is `tenant_id ASC, seq ASC`, matching verify, so a reader can re-walk what it reads.

**Re-assert, not trust.** Before the query runs, the reader re-asserts `activeScopeTenantId()`
(`ai_audit_writer.ts:237-247`): raw SQL bypasses ContextSeal, so a tenant-scoped read whose bound
`tenantId` disagrees with the active scope trips `guard.ai_scope_mismatch` (foreign id tokenized) and
throws `tenant_scope_mismatch`. A cross-tenant/all-tenants read is only reachable through the admin gate
below, which runs with no bound tenant scope.

**Paging is clamped, not trusted.** Reusing the exact defense in `pure.ts` `clamp`
(`pure.ts:20-24`), `page` and `limit` are clamped through named constants:
`DEFAULT_AI_AUDIT_PAGE_SIZE` / `MAX_AI_AUDIT_PAGE_SIZE` for `limit`, and `MAX_AI_AUDIT_PAGE` as the hard
`OFFSET` ceiling. This is the same OFFSET-DOS reasoning the admin controller documents
(`audit_logs_controller.ts:12-15`): Postgres `OFFSET` is O(n), so an unbounded `?page=10000&limit=200`
reads and discards millions of rows. Deep walks use the `from`/`to` range (parsed like
`pure.ts:87-91` `parseDate`) to switch to a `(tenant_id, seq)` range scan.

The HTTP surface is a NEW `ai_audit_controller.ts` + route, **kept in the AI satellite**, because admin must
not hard-depend on AI (admin ships without the AI package installed). The route is **admin-gated, default
deny**: a new `AIAuditConfig.authorizeAudit` host hook (a `TenantAccessAuthorizer`, the established
default-deny seam shape) decides who may read. Absent hook means deny, matching the fail-closed default the
foundation mandates for every new host seam (`00-foundation.md` section 4). Per that same rule the hook
ships BOTH a `typeof === 'function'` boot check in `validate_config.ts` (routed through `fail()`, the single
`guard.ai_config_invalid` choke) AND the request-time fail-closed gate; boot never inspects a return value.

Fail posture: **fail-closed** (deny read on absent/throwing authorizer). Reason: an audit trail exposed to
the wrong reader is itself a disclosure, so the safe default when authorization is unresolved is to refuse.

### 3.2 Export: `tenant:ai:audit:export` + `ai_audit_export.ts` + `AiAuditReader.exportStream()`

A new `tenant:ai:audit:export` command streams the chain out, structured like core's
`tenant_audit_export.ts:56-104`: one destination opened once (file or stdout), `write` awaiting `drain` for
backpressure (`tenant_audit_export.ts:67-70`), batches sized by a named `DEFAULT_AI_AUDIT_EXPORT_BATCH_SIZE`
constant, driven by a new `AiAuditReader.exportStream()` async-iterator that pages through the chain.

Two deliberate departures from the core prior art, each load-bearing for external re-verification:

- **NDJSON, not a JSON array.** Core's JSON path emits one array (`tenant_audit_export.ts:73,85,93`); Wave 4
  chooses NDJSON (one JSON object per line) as a NEW format so the file is streamable into a SIEM and
  re-walkable line by line without parsing a whole-file array. CSV is also offered, reusing core's
  formula-injection escaping verbatim (`audit_export.ts:57-64`): every cell starting `=+-@`/tab/CR gets a
  leading apostrophe, then RFC-4180 quoting, so a value planted in an audited field cannot execute in the
  analyst's spreadsheet.
- **Chain order, not `created_at`.** The export MUST emit `ORDER BY tenant_id, seq` (the verify order,
  `ai_audit_writer.ts:286`), NOT `created_at, id`. Only in `(tenant_id, seq)` order is the file
  self-verifiable: an external tool re-walks each tenant's rows, recomputing `canonicalAuditFields`
  (`ai_audit_writer.ts:149-168`) and linking through the exported `prev_checksum`. Every row carries its
  `seq`, `checksum`, and `prev_checksum` (already in `AI_AUDIT_COLUMNS`, `ai_audit_writer.ts:122-124`) so
  the walk needs nothing from the live database.

Fail posture: **fail-closed on a write error** (mirrors `tenant_audit_export.ts:105-108`: destroy the
partial file, non-zero exit), because a silently truncated forensic export is worse than a failed one.

### 3.3 Checkpoint-aware verify (no chain mutation)

`verify()` is extended to accept an optional per-tenant seed `{ seq, checksum }` and to add a `seq > ?`
lower bound to its `WHERE`. This is a **pure fold-seed change**: instead of always starting `prevSeq = 0`
and `prevChecksum = null` (`ai_audit_writer.ts:291-293`), a seeded walk starts from the checkpoint's `seq`
and `checksum`, verifying only the tail. The all-tenants sweep looks up the per-tenant checkpoint at each
`tenant_id` boundary, exactly where the existing loop already resets its fold state
(`ai_audit_writer.ts:298-302`). Nothing about the stored rows changes: **no existing row's `prev_checksum`,
`checksum`, or `seq` is ever rewritten.** The seeded walk still reproduces `auditChecksum` per row and still
returns the first `gap`/`prev_link`/`checksum` break, so incremental verify is byte-for-byte as strong as a
full walk over the tail it covers, at a cost proportional to new rows rather than to all history (gap 3).

Fail posture unchanged: the walk is a read; it reports, it does not repair. A break is surfaced, never
auto-corrected, because "fixing" a broken chain is indistinguishable from the tampering it detects.

### 3.4 Retention as additive schema, never a chain rewrite

Retention is split into a default-safe path and an explicitly-privileged one.

**The default path, `tenant:ai:audit:archive`, prunes nothing.** It (1) runs `verify(range)` over the
segment, refusing to proceed if the chain is already broken; (2) exports that segment to the operator's
WORM/SIEM via the same NDJSON/CSV `exportStream` in chain order; (3) persists a **signed checkpoint**
`{ tenantId, lastSeq, lastChecksum }` into a NEW `ai_audit_checkpoints` table (named constant
`AI_AUDIT_CHECKPOINT_TABLE`, qualified through `qualifyBackofficeTable` with the injected `schemaName`, on
the injected `connectionName`). No `ai_audit_logs` row is touched. The checkpoint is what a later
incremental verify (3.3) seeds from, so archiving and verifying compose.

**Physical pruning is an explicitly privileged, superuser-gated, audited, out-of-band path, off by
default.** Because the BEFORE UPDATE/DELETE/TRUNCATE triggers reject every row-level deletion for every role
(`00-foundation.md` section 2), the sanctioned way to reclaim storage is DDL, not DML: migrate
`ai_audit_logs` to a table partitioned by `occurred_at`, then `DETACH PARTITION` an aged segment. A
partition detach is a schema operation, not a row delete, so the append-only triggers still hold on the live
table and the invariant is never weakened. Correctness of a prune is re-provable end to end: the detached
segment verifies from its own signed export, and the live tail verifies from the checkpoint forward (3.3),
so the full chain remains attestable across the cut. This path is gated behind an explicit
superuser-acknowledged flag (the `acknowledge<X>` + doctor-check pattern from `00-foundation.md` section 4,
item 7), audited when exercised, and default-off.

Fail posture: **fail-closed before any detach.** The prune refuses unless the segment's export exists and
verifies and the checkpoint is written, because detaching a segment whose contents were never externally
anchored would silently destroy evidence.

### 3.5 Scheduling stays host-owned or a validated field, never a hardcoded cron

The recommended path is **zero new code**: the existing `tenant:ai:audit:verify` already exits 1 on the
first break (`ai_audit_verify.ts:54`), so the documented host-owned line
`node ace tenant:ai:audit:verify --json || alert` (`ai_audit_verify.ts:12`) is a complete alerting hook a
host wires into its own scheduler. The mechanism is the `verify()` API plus that command; scheduling is the
operator's.

If a host prefers in-process scheduling, it wires the core `TenantSchedulerService`, and the cron is a
**validated `config.ai.audit.verify.schedule` field**, never a hardcoded string: it is asserted at boot
through `fail()` (the `guard.ai_config_invalid` choke), the same way every other `config.ai` field is
validated (`validate_config.ts` `assertAuditConfig`, `validate_config.ts:254-262`). When a scheduled verify
finds a break it emits `guard.ai_audit_chain_broken` (a NEW registry entry, severity critical, following the
four-step guard act) plus a metric off the reject path. No cron literal ships in source.

### 3.6 Anomaly alerting: `ai_audit_anomaly_watcher.ts`

A new `ai_audit_anomaly_watcher.ts`, wired in the provider's `ready()` hook exactly where the auto-purge
listeners already subscribe (`ai_provider.ts:498-525`), resolves the `emitter` via `container.make`
(`ai_provider.ts:502`, the documented reason emitter subscriptions belong in `ready()`), subscribes to the
already-dispatched `IsthmusGuardTripped` event, and filters to `guard.ai_*` ids. It keeps sliding-window,
per-`(tenant, principal, guard)` counters whose window and threshold come from a validated
`AIAuditConfig.anomaly` block with named-constant, clamped defaults: `DEFAULT_AI_ANOMALY_WINDOW_MS` /
`MAX_AI_ANOMALY_WINDOW_MS` and `DEFAULT_AI_ANOMALY_THRESHOLD` / `MAX_AI_ANOMALY_THRESHOLD`, plus a
`MAX_AI_ANOMALY_TRACKED_KEYS` cap so the counter map is bounded (an unbounded key space is itself a DoS). On
a threshold breach it emits a NEW `guard.ai_anomaly` (spelled with the mandatory `ai_` segment so it clears
the `guard.ai_*` registry template and the collision guard) and fans a summary to the host
`AuditLogDestinationRegistry` (reusing the anchor path at `ai_audit_writer.ts:380-398`) or to an optional
`AIAuditConfig.onAnomaly` host hook.

Fail posture: **fail-open, fire-and-forget, never on the request path.** Reason: the watcher is an observer
of an already-dispatched event, so a slow or throwing alert must never degrade the request that tripped the
guard (the guard already did its fail-closed job at the choke point). This mirrors the metric bridge, which
is likewise fire-and-forget off the reject path (`ai_guard_audit.ts:56-63`), and the `#anchorSafe`
best-effort swallow (`ai_audit_writer.ts:364-371`). The watcher is torn down in `shutdown()` alongside the
other subscriptions (`ai_provider.ts:528-536`).

### 3.7 The first-class `ai` actor correction

`toAuditLogEntry` sets `actorType: 'system'` (`ai_audit_writer.ts:412`). Core's `AuditActorType` now
includes `'ai'` (`tenant_audit_log.ts:12`), added precisely so "the assistant did this" is queryable and
exportable rather than buried. The fix is at the source: change that literal to `'ai'`, and audit any
Layer-2 destination consumer that filters on `actorType` (a SIEM rule keyed on `system` would otherwise miss
the reclassified rows). This is a one-line correctness change proven by the anchor-mapping spec, not a new
mechanism.

### 3.8 Clear the stale docblock

`audit_seam.ts:4-8` is edited to drop the `TODO(WS-AI-7)` and the "default sink is a no-op" claim, and to
state what is true now: the real sinks (`PgChatAuditSink`, `PgEmbeddingAuditSink`, `PgRetrievalAuditSink`,
`PgToolAuditSink` in `audit_sinks.ts`) are live and the seam's no-op defaults remain only as the
audit-disabled fallback. Documentation-only, but it stops the file from misdescribing the shipped system.

## 4. Acceptance tests

Red-first, each stating the gap before the fix:

- **Reader isolation.** A tenant-scoped `AiAuditReader.query({ tenantId: B })` under active scope A trips
  `guard.ai_scope_mismatch` and throws `tenant_scope_mismatch` (the re-assert at
  `ai_audit_writer.ts:237-247`), never returning tenant B's rows.
- **Reader is SELECT-only and clamped.** `limit` beyond `MAX_AI_AUDIT_PAGE_SIZE` and `page` beyond
  `MAX_AI_AUDIT_PAGE` are clamped (the `pure.ts:20-24` reasoning); the emitted SQL contains no
  INSERT/UPDATE/DELETE; filters are all `?`-bound (a `principalHash` of `x' OR '1'='1` returns zero rows,
  not the table).
- **Read route default-deny.** With no `authorizeAudit` hook the route 403s; a malformed (non-function)
  hook fails boot through `guard.ai_config_invalid`; an allowing hook returns rows.
- **Export re-walks clean.** Export a multi-tenant chain to NDJSON, then re-walk the file with an
  independent re-implementation of `canonicalAuditFields`/`auditChecksum` and confirm every checksum and
  prev-link matches. Assert the file is in `(tenant_id, seq)` order, not `created_at`. A CSV cell beginning
  `=` is emitted apostrophe-prefixed (`audit_export.ts:57-64`).
- **Incremental verify equals full verify.** Seeding `verify()` from a mid-chain checkpoint and walking
  `seq > checkpoint.seq` yields the same break (or clean result) as a full walk over that tail, and touches
  no stored row (a byte-compare of the table before and after).
- **Archive prunes nothing.** `tenant:ai:audit:archive` writes an `ai_audit_checkpoints` row and an export
  but leaves `ai_audit_logs` row-count and every `checksum` unchanged; a subsequent full `verify()` still
  passes.
- **Physical prune stays gated.** The detach path refuses without the acknowledge flag and without a
  verifying export; the append-only triggers still reject a direct `DELETE` on the live table after a
  detach.
- **Anomaly watcher fires and is fail-open.** N `guard.ai_scope_mismatch` trips for one
  `(tenant, principal)` within `DEFAULT_AI_ANOMALY_WINDOW_MS` emit exactly one `guard.ai_anomaly` and one
  destination fan-out; a throwing `onAnomaly` hook is swallowed and never propagates to the tripping
  request; the counter map never exceeds `MAX_AI_ANOMALY_TRACKED_KEYS`.
- **Actor is `ai`.** The anchored `AuditLogEntry` carries `actorType: 'ai'` (`ai_audit_writer.ts:412`
  post-fix), pinned by the anchor-mapping spec.
- **Guard registry stays green.** The two new guards (`guard.ai_audit_chain_broken`, `guard.ai_anomaly`)
  each have a registry literal, an `emitAiGuardEvent` call site, an emission-matrix recipe, and keep
  `no_silent_ai_guard` green (the four-step act).

## Honesty bound

- Consumption detects tampering; it does not PREVENT it. A superuser who drops `ai_audit_logs` outright
  removes the evidence; the defense is off-box, the signed checkpoints and external NDJSON exports plus the
  host WORM/SIEM anchor, not the live table. This is the same bound the write-side chain carries
  (`00-foundation.md` section 5).
- The reader and export surfaces are only as isolated as the injected `activeScopeTenantId` and the
  `authorizeAudit` gate. A host that wires an allow-all authorizer has authorized cross-tenant reads; the
  mechanism is default-deny, the policy is the operator's.
- The anomaly watcher is a velocity heuristic on guard trips, not a detector of novel attacks. It sees only
  what already tripped a registered guard; an attack that never trips a `guard.ai_*` is invisible to it. It
  is an alerting convenience layered on the real controls, never a control itself.
- Physical pruning, even done correctly by detach, permanently removes rows from the live chain. Their
  integrity is thereafter attestable ONLY from the signed export; if that export is lost, the segment is
  unrecoverable and unverifiable. Enabling the prune path is an operator decision with that permanent cost.
- Retention and erasure sit where law meets storage. This wave ships the mechanism; whether a given
  retention window or archive destination satisfies the operator's legal duties is the operator's call,
  PENDING LEGAL ADVICE (`00-foundation.md` section 5). The library does not decide lawfulness.

## Open decisions owned by the user

1. **Scheduling home (recommended: host-owned cron over the existing command).** The zero-new-code path,
   `node ace tenant:ai:audit:verify --json || alert` (`ai_audit_verify.ts:12`), keeps scheduling in the
   operator's own scheduler where it belongs and adds no surface to maintain. The alternative wires the core
   `TenantSchedulerService` behind a validated `config.ai.audit.verify.schedule` field; take it only if
   in-process scheduling is a hard requirement. Either way the cron is never a source literal.
2. **Export default format.** NDJSON (recommended) for SIEM/streaming re-walk, CSV for spreadsheet-bound
   auditors. Recommend NDJSON as the default and CSV via `--format csv`, since the primary consumer of the
   AI chain is machine re-verification, not a spreadsheet.
3. **Physical retention enablement.** Off by default (recommended). The `occurred_at`-partition +
   `DETACH PARTITION` prune is designed and gated but stays disabled until an operator explicitly
   acknowledges the permanent-removal cost; most hosts should archive-and-keep, letting storage grow, rather
   than prune. Flipping it on is a separate go with its own review.
4. **Anomaly delivery target.** Fan to the existing host `AuditLogDestinationRegistry` (recommended, reuses
   the wired SIEM path) versus a dedicated `AIAuditConfig.onAnomaly` hook. Recommend the registry so anomaly
   alerts ride the same stream as every other audit signal; offer the hook for hosts that want anomalies
   routed to a separate pager.
5. **Reader authorization strictness.** Default-deny with a required `authorizeAudit` hook (recommended).
   The alternative, defaulting the read route to the same gate as `authorizeAIAccess`, is convenient but
   conflates "may use AI" with "may read everyone's audit trail"; keep them distinct and make audit-read its
   own explicit grant.
