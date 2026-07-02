---
title: Isthmus guard registry
description: The named registry of every fail-closed guard in the package, the severity-graded isthmus:* event each guard emits on rejection, the ContextSeal, the per-severity rate limiter, and the Prometheus counters that make an intrusion probe visible to ops.
---

# Isthmus guard registry

The Isthmus is the consolidation layer over the package's fail-closed guards. Before it,
a rejected intrusion probe (a malformed tenant id headed for DDL, a CR/LF header
injection in a redirect path, an SSRF-shaped webhook URL) threw the right exception but
told nobody. Now every guard has a registry entry with documented evidence, emits a
severity-graded `IsthmusGuardTripped` event on rejection, and shows up in four
Prometheus metric families, and an architecture spec plus a CI gate keep the registry
and the guards from drifting apart. This page covers:

- the three pillars and what lives in each
- the event taxonomy and how to subscribe to it
- the ContextSeal, the one guard that changes behavior (a typed 500 on tenant-context mismatch)
- the per-severity rate limiter and why nothing is ever dropped silently
- the audit-coverage Index that CI enforces, and the 6-month review
- what was deliberately rejected, and why

## The three pillars

| Pillar | Property | Representative guards |
|---|---|---|
| **Guard** (what enters) | Input validation, fail-closed | tenant identifier policy, redirect host/label/port/path, config bounds, resolution-safety posture, resolver chain, metric name/value, `/metrics` mount guard, RLS setting name, broadcast channels, outbound fetch (SSRF), webhook URLs |
| **Seal** (what persists) | Isolation boundaries | connection `search_path` pin, strict scope requirement, cross-tenant write refusal, tenant-context mismatch (ContextSeal) |
| **Audit** (what happened) | Severity-graded observability | the `scope:bypass` escape-hatch audit (the template the Isthmus generalizes) |

Every entry in the registry
([`src/isthmus/registry.ts`](https://github.com/Arcoders/Adonisjs-lasagna-saas-tenancy/blob/master/packages/core/src/isthmus/registry.ts))
carries a stable id (`guard.tenant_identifier`, `seal.tenant_context`, …), a bug class,
a severity, its guard file, **required non-empty evidence** (a CVE, an incident, an
inherent risk, or an invariant), and review dates. The admission policy is thinness by
construction: no entry without documented evidence, no speculative guards, and a guard
that cannot cite why it exists does not get registered.

## The event

Every registered guard calls the emit helper on the line *before* its throw. The throw
is unchanged; the event is additive observability. Subscribe to the single public event
class and filter on the payload:

```ts
// start/events.ts
import emitter from '@adonisjs/core/services/emitter'
import { IsthmusGuardTripped } from '@adonisjs-lasagna/saas-tenancy/events'

emitter.on(IsthmusGuardTripped, (event) => {
  if (event.payload.severity === 'critical') {
    // page: isthmus:seal:tenant:mismatch, isthmus:seal:connection:mismatch, ...
  }
})
```

The payload (`IsthmusGuardTrippedPayload` from `/types`) carries the registry fields
plus trip-site context: `id`, `pillar`, `bugClass`, `severity`, the taxonomy `event`
name, `tenantId` (when known), and a small `metadata` record. Event names follow
`isthmus:<pillar>:<class>:<outcome>` (for example `isthmus:guard:identifier:rejected`);
the one grandfathered name is `scope:bypass`, which shipped before the taxonomy.

<Callout type="note" title="Listeners never touch the reject path">
Dispatch is fire-and-forget: the guard bumps its counters, hands the event to the
emitter, and throws without waiting for listeners. A slow or throwing listener can
neither block nor mask the rejection. Keep listeners light anyway; heavy synchronous
work delays other listeners of the same event.
</Callout>

## ContextSeal scope

ContextSeal fires only when BOTH an active `tenancy.run()` scope AND an HTTP context
resolve a tenant id and they disagree. On the guarded HTTP path both sources are always
present and agree (the guard itself opens the tenancy scope from the request), so
normal requests are unaffected; the comparand is memoized per request, making the check
a string compare per query. When they disagree, the query does not route: the adapter
emits `isthmus:seal:tenant:mismatch` (critical) and throws
`IsthmusTenantMismatchException` (`500`, `E_ISTHMUS_TENANT_MISMATCH`).

Background jobs run inside `tenancy.run()` but have no `HttpContext`, so ContextSeal
never fires in jobs; tenant validation there is the dispatcher's payload check plus
`TenantJob` context entry, which fails closed on an invalid id.

<Callout type="warning" title="Deliberate cross-tenant work inside a request">
Code inside a tenant-resolving request that enters `tenancy.run(otherTenant)` and then
queries a tenant model now gets a typed 500 instead of silently routing under the other
tenant. That disagreement is the context-confusion bug class the seal exists to stop.
For deliberate cross-tenant work, dispatch a job (no HTTP context, seal inert) or pass
an explicit `{ connection }` query option (checked before tenant resolution, never
sealed).
</Callout>

## Rate limiting and drop accounting

Event dispatch is budgeted per severity per process over a 10-second fixed window:
`critical: 200`, `high: 100`, `warn: 50`, `info: 20`. Each severity has an independent
window, so a burst at one severity cannot starve another. The budgets are deliberately
finite ("critical is unlimited" would let an attacker turn the alerting signal into a
load amplifier) and deliberately not host-configurable (a tunable audit limiter is a
disable-your-own-alarms vector).

Nothing is lost silently. The trip counters bump *before* the limiter, so the
Prometheus totals stay exact even when dispatch drops, and every suppressed or failed
dispatch increments the dropped counter with a reason:

| Metric | Labels | Meaning |
|---|---|---|
| `multitenancy_isthmus_guarded_total` | `pillar`, `severity` | Guard trips, rolled up |
| `multitenancy_isthmus_rejected_total` | `pillar`, `severity`, `id` | Guard trips, per guard |
| `multitenancy_isthmus_dropped_total` | `severity`, `reason` | Dispatches suppressed (`rate_limited`) or failed (`no_emitter`) |
| `multitenancy_isthmus_index` | | Registered guard coverage: registered / (registered + allowlisted silent) |

All four families render on the guarded [`/metrics` endpoint](/guides/health).

## The audit-coverage Index

CI (`npm run check:isthmus`, part of `npm run check`) scans the core source for
fail-closed throw sites and computes:

```
Index = sites in registered-and-emitting files / (all detected sites − allowlisted) × 100
```

An unregistered guard lowers the Index until it is registered or allowlisted with a
written reason, so the floor (90, override with `ISTHMUS_MIN_INDEX`; measure-only with
`ISTHMUS_REPORT_ONLY=1`) gates something real. The same scan runs as an architecture
spec, so a silent guard fails the unit suite before it ever reaches CI. The gate also
prints every entry past its `nextReview` date; the registry is reviewed every 6 months
and the floor ratchets to `floor(measured) − 2`, never downward.

## Satellite-emitted guards

Satellites reuse the event channel, not the machinery. The AI satellite keeps its
own guard registry (ids `guard.ai_*`, events `isthmus:guard:ai_*:rejected`, inside
the same taxonomy) and dispatches this page's `IsthmusGuardTripped` class before
each of its fail-closed throws, so one subscription observes both layers. The
`ai_` class segment makes collision with kernel ids structurally impossible.

Three boundaries keep the layers honest:

- The kernel registry, the `check-isthmus` gate and the Index are kernel-only by
  construction (the id union derives from the kernel's own literal array). The AI
  satellite mirrors the discipline with its own `@architecture` scan and a
  registry-driven emission matrix in its test suite.
- Rate limiting is per layer: the satellite reuses the kernel's budget *values*
  but keeps its own windows, so a burst on the AI surface can never starve the
  kernel's critical-event budget or skew its dropped counters.
- The `multitenancy_isthmus_*` Prometheus counters render kernel guards only. AI
  trips surface through the event and through the per-tenant
  `ai_guard_rejections` metric.

See the [AI satellite guide](/guides/satellites/ai#guard-events) for the guard
list and a subscription example.

## What was rejected, and why

- **A proxy/interception layer over AdonisJS APIs.** Evaluated first, rejected on
  evidence: the package barely consumes the risky APIs, and the real surfaces were
  already hardened. The Isthmus consolidates existing guards; it does not intercept the
  framework.
- **"Critical events are never rate-limited."** Unbounded emission is itself a load
  vector. Finite budgets plus exact counters achieve the goal safely.
- **Host-configurable budgets or an `enforce | warn` ContextSeal mode.** Both are
  disable-your-own-alarms vectors, and nothing has shipped that would need a migration
  path.
- **Buffering events that fail to dispatch pre-boot.** A config-phase guard aborts the
  deploy loudly; that exception is the signal. A replay queue would add state for
  events no listener can be subscribed to yet (the drop is still counted under
  `no_emitter`).
- **Fabricated evidence.** Registry entries cite a real CVE, incident, inherent risk,
  or invariant, or they do not exist.

## Read next

- [Security model](/guides/security) — what the package guards and what the host owns
- [Health & monitoring](/guides/health) — the `/metrics` endpoint the counters render on
- [Lifecycle events](/reference/events) — every other typed event, and subscription patterns
- [Exception reference](/reference/exceptions) — `E_ISTHMUS_TENANT_MISMATCH` among friends
- [Architecture](/architecture#fail-closed-vs-fail-open-the-policy-matrix) — the fail-closed policy matrix the Isthmus rows joined
