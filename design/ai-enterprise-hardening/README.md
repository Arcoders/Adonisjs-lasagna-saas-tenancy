# The AI Satellite Enterprise-Hardening Bundle: Design Document

STATUS: This is a DESIGN document and the guide for a set of PR-sized implementation waves, not
a rewrite. Most of the defenses an "enterprise-grade AI" brief worries about already ship in
`@adonisjs-lasagna/ai` and are test-covered (see the baseline ledger in `00-foundation.md`). What
follows closes the genuine gaps at the root, expressed as proper seams and contracts rather than
local patches. Lasagna 1.0 is not yet released; the two deep data-at-rest items (Wave 5) are
designed and plumbed default-off, and enabling them per host is a separate go.

## The framing principle

Security is a property the OPERATOR earns by wiring the mechanisms correctly, never a claim the
library makes on their behalf. The AI satellite ships MECHANISMS and fail-closed defaults; the
operator owns the policy. No document here claims "prompt-injection-proof", "unhackable", or
"GDPR/SOC2/Ley 09-08 compliant". Every topic doc closes with an explicit honesty bound stating what
its mechanism does NOT guarantee, because a control whose limits are hidden is worse than one whose
limits are stated: the operator plans around a stated limit and gets blindsided by a hidden one.

The governing direction from the user is non-negotiable and reproduced in `00-foundation.md`: no
patches, no theater, everything solved from the root, nothing hardwired. A regex wall that pretends
to be prompt-injection defense is theater; the structural role separation that actually holds the
boundary is the control. Where this bundle adds a detector, the detector is a pluggable seam with a
fail posture set by policy, not a hardcoded ruleset masquerading as protection.

## The documents

Read in this order. The build order and the wave-dependency ordering are the same:
`foundation -> resilience -> injection -> audit -> data-at-rest`, with the threat model framing all
of it. Where a topic doc disagrees with `00-foundation.md`, the foundation is right.

| # | Doc | One line |
|---|---|---|
| 0 | [`00-foundation.md`](./00-foundation.md) | The constitution: the governing direction, the baseline ledger of what already ships (do not rebuild), the named-constant and fail-posture discipline, the honesty bound, and the section template every topic doc is measured against. |
| 1 | [`01-threat-model.md`](./01-threat-model.md) | The OWASP LLM Top 10 (2025) delta against what already ships, plus the probability x impact risk matrix that ranks the genuine gaps. Extends, does not duplicate, the existing 18-vector table in `docs/guides/satellites/ai-security.md`. |
| 2 | [`02-resilience-foundation.md`](./02-resilience-foundation.md) | Waves 0 and 1: the type and error foundation (compile-forced retryability, the extracted stream hotspot, typed Redis seams) and the resilience foundation (one policy seam over every request-path Redis read, a DB-outage classifier at the vector-store boundary, unmetered-spend fail-closed at boot). Dissolves both latent 500 bugs at the root. |
| 3 | [`03-injection-defense.md`](./03-injection-defense.md) | Wave 3: the structural built-in made observable, plus an `InjectionClassifier` async host contract as the seam. No hardwired semantic ruleset ships as the boundary. |
| 4 | [`04-audit-consumption.md`](./04-audit-consumption.md) | Wave 4: the audit consumption pillar. A read/query API, NDJSON/CSV export in chain order, checkpoint-aware verify with no chain mutation, non-destructive retention, anomaly alerting off the guard bus, and the first-class `ai` actor correction. |
| 5 | [`05-data-at-rest.md`](./05-data-at-rest.md) | Wave 5: the gated data-at-rest design. Per-tenant memory DEK and embeddings content-at-rest encryption, fully designed and cost-out, shipped as seam + config that default to today's behavior. Enabling per host is a separate go. |
| 6 | [`06-execution-plan.md`](./06-execution-plan.md) | The phased plan with per-wave acceptance tests, the verification recipe against the real stack, and the success metrics. |

The wave-dependency ordering is one-way in the sense that matters: Waves 0 and 1 come first because
they dissolve the two latent 500 bugs and lay the resilience foundation the chaos tier (Wave 2)
verifies. Waves 3 and 4 are largely independent of each other. Wave 5 is designed here but its
enablement is gated behind a separate go.

## Open decisions owned by the user

These are the choices this bundle deliberately leaves to the operator. Each topic doc restates the
ones it touches. The recommended default is named in each case, and the recommendation matches the
executed plan unless the user says otherwise.

1. **Wave-1 resilience policy home.** Satellite-owned `config.ai.resilience` (recommended, no core
   change) versus adding AI keys to the core `ResilienceConfig`. Detailed in `02`.
2. **Wave-3 semantic default.** Seam-only (recommended, no theater) versus shipping an optional,
   clearly-labeled, fully-overridable reference classifier that is never the boundary. Detailed in `03`.
3. **Wave-4 scheduling.** A documented host cron over the existing verify command (recommended,
   zero new code) versus wiring the core scheduler behind a validated `config.ai.audit.verify.schedule`
   field. Detailed in `04`.
4. **Wave-5 enablement.** Designed and plumbed default-off in this initiative. Flipping any host to
   `tenant-dek` memory or `encryptContent` embeddings is a separate go with its own review. Detailed in `05`.
5. **Wave ordering past the foundation.** Waves 0 and 1 first (they dissolve the latent bugs and
   underpin the chaos tier); 3 and 4 are largely independent; the recommended order is
   `0 -> 1 -> 2 -> 3 -> 4 -> 5`.

## Relationship to the existing security documentation

This bundle does not replace `docs/guides/satellites/ai-security.md`, it extends it. That page holds
the shipped 18-vector threat table, the eight structural invariants I1 through I8 (each pinned by a
`check-ai-invariant-*` source-scan guard), the OWASP LLM crosswalk, the honest-limits section, and
the guard-id catalogue. The threat model here (`01`) is the delta on top of that page: what the new
waves change, and the probability x impact ranking that decided which gaps were worth closing now.
When a wave lands, the corresponding sections of `ai-security.md`, `ai.md`, and `audit.md` are
updated in the same PR, and the guard count and invariant list on that page are reconciled with the
registry (the registry currently carries 27 guard entries; the page's "18 guards" figure predates
the WS-AI-11 additions).
