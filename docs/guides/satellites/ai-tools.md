---
title: AI tools
description: Let the model answer live questions about a tenant's own data by calling server-defined tools — a default-deny registry, per-tool authorization, tenant-scoped execution, and bounded, audited calls.
---

# AI tools

The AI satellite on its own is a RAG-over-documents gateway: it can answer "what is
our refund policy?" from your knowledge base, but not "how many bookings do I have
right now?" — that needs a query against the tenant's own tables. Tool calling closes
that gap. You register server-defined tools, the model decides which to call and with
what arguments, and the satellite runs them inside the asking tenant's scope.

This page covers:

- the [one-tool quickstart](#quickstart-one-read-only-tool) with `readOnlyTool`
- the [security posture](#the-security-posture) you get by default and what you opt into
- [authorizing](#authorizing-a-tool) each call per tenant and per user
- the [bounds](#bounds) that cap rounds, calls, time and spend
- what the [client sees](#what-the-client-sees) on the stream
- [action tools](#action-tools-mutating), the honest state of mutating tools
- the [honest limits](#honest-limits)

Tool calling is threat vector #12 and invariant **I7** in the
[AI security guide](/guides/satellites/ai-security), and OWASP **LLM06** (Excessive
Agency). Read that page for the full model; this one is the how-to.

## Quickstart: one read-only tool

Tools are declared in your `config.ai.tools` block. `readOnlyTool` is the minimal
path — everything else defaults safely.

```ts
// config/multitenancy.ts
import { readOnlyTool } from '@adonisjs-lasagna/ai/tools'

export default {
  ai: {
    // ...allowedProviders, defaultProvider, etc.
    tools: {
      registry: [
        readOnlyTool(
          'count_bookings',
          'Count this company\'s bookings, optionally narrowed to one status.',
          {
            type: 'object',
            properties: { status: { type: 'string', enum: ['confirmed', 'active'] } },
          },
          async (args) => {
            const { default: Booking } = await import('#app/models/tenant_scoped/booking')
            const rows = await Booking.query().count('* as count').pojo<{ count: string }>()
            return { total: Number(rows[0]?.count ?? 0) }
          }
        ),
      ],
      authorizeTool: (ctx, tenant, tool) => ({ kind: 'allow' }),
    },
  },
}
```

That is a working tool. The handler is an ordinary Lucid query: because `Booking`
extends `TenantBaseModel` and the satellite runs the handler inside
`tenancy.run(tenant)`, it reads the asking company's schema and nothing else. You
write no tenant filter, and you cannot forget one.

<Callout type="warning" title="Import models inside the handler">
`config/multitenancy.ts` loads before the provider boots, so a top-level model import
pulls the base models in too early and throws. Import them inside the handler with
`await import(...)`, as above.
</Callout>

Without `config.ai.tools`, chat behaves exactly as before with zero overhead: no
tools are advertised, and the plain streaming path runs unchanged.

## The security posture

Tool calling is the one place the model's output causes *your* code to run against a
tenant's data, so every default is closed:

| Posture | Default | Why |
|---|---|---|
| Tools offered | **None** | No `registry` and no `resolveTools` means the model is offered nothing. Registering a tool never auto-exposes it. |
| Authorization | **Deny** | With tools present but no `authorizeTool`, every call is refused. You opt out with `acknowledgeUnauthorizedTools`, and the `ai_tools` doctor check warns until you do. |
| Mutating tools | **Refused** | `mode: 'action'` tools are never advertised and always refused. See [action tools](#action-tools-mutating). |
| Provider support | **Fail closed** | A tool request to a provider that does not declare `capabilities.tools` is a 403, never a silent drop that answers as if tools were unavailable. |
| Arguments | **Whitelist** | Rebuilt from your `inputSchema.properties`, so an undeclared or prototype-polluting key never reaches your handler. |
| Results | **Untrusted data** | Fenced into a `role: 'tool'` turn, never an instruction turn. |
| Calls | **Audited** | One `op: 'tool'` row per call on the hash-chained audit log: tool name, mode, outcome, round. Never arguments, never results. |

The load-bearing one is tenant scoping. The executor re-asserts the *ambient*
tenancy scope before it binds the tenant's, so a request that somehow arrives inside
another tenant's scope is refused (`tenant_scope_mismatch`, a critical Isthmus guard)
rather than served. That is the confused-deputy check, and
[`check-ai-invariant-7`](https://github.com/Arcoders/Adonisjs-lasagna-saas-tenancy/blob/master/scripts/check-ai-invariant-7.mjs)
fails the build if it is deleted or moved after the bind.

## Authorizing a tool

`authorizeTool` runs per call. Membership is already proven by the tenant guard, so
this hook answers a narrower question: may *this* caller run *this* tool?

```ts
// config/multitenancy.ts
tools: {
  registry: fleetTools,
  authorizeTool: (ctx, tenant, tool) => {
    const staff = ctx.auth.use('web-tenant').user
    if (!staff) return { kind: 'deny' }
    if (staff.role === 'owner') return { kind: 'allow' }
    if (staff.role === 'agent' && tool !== 'revenue_summary') return { kind: 'allow' }
    return { kind: 'deny' }
  },
}
```

An `allow` may carry a `filter` that narrows what the tool may see. It arrives as
`context.filter`, so one tool can serve several privilege levels:

```ts
authorizeTool: (ctx, tenant, tool) => ({
  kind: 'allow',
  filter: { agentId: ctx.auth.use('web-tenant').user!.id },
})
```

The hook is fail-closed in every direction: a `deny`, a throw, or a malformed return
all refuse the call with `tool_denied` (403), never a 500. The same holds for
`resolveTools`, the per-request registry hook — a resolver that cannot decide refuses
the request rather than degrading to "this tenant gets no tools", which would answer
ungrounded as though tool calling were unavailable.

## Bounds

Every bound has a named-constant default and a hard ceiling you cannot configure past.

| Option | Default | Ceiling | Caps |
|---|---|---|---|
| `maxRounds` | 4 | 8 | Provider round-trips per request. |
| `maxToolsPerRound` | 4 | 8 | Tools executed per round (over-limit runs the first N and logs the drop). |
| `maxToolCallsPerRequest` | 16 | 16 | Total calls across the request. |
| `toolTimeoutMs` | 5000 | 30000 | One tool's wall time. |
| `maxToolResultChars` | 4000 | 16000 | A fenced result's size. |
| `maxToolArgsChars` | 8000 | 16000 | Raw argument text, bounded before parsing. |
| `maxConcurrentPerTenant` | 8 | 32 | In-flight streams admitting a tool loop, per tenant. |

Spend is capped by construction, not by these alone: a tool request takes **one**
quota reservation for the whole loop (`maxTokens × maxRounds`), so a runaway loop hits
the tenant's `aiTokens` budget rather than multiplying it. Hitting a ceiling mid-loop
ends the stream in-band with `tool_budget_exhausted`; the text already streamed stands.

## What the client sees

A tool call is announced on the SSE stream as a `tool_call` frame carrying the name
and id — the arguments are excluded unless you set `surfaceToolArgs`:

```
event: tool_call
data: {"name":"count_bookings","id":"call_00_Ttq..."}
```

Handle it separately from `token` frames, or you will paint raw JSON into the answer:

```ts
if (event === 'tool_call') {
  const { name } = JSON.parse(payload)
  showActivity(`🔧 ${name}`)
  continue
}
```

Because the loop lives inside the same single pump, everything else is unchanged: one
stream, monotonic ids, one terminal `done`. A mid-stream tool failure is an in-band
`event: error` carrying only the classified code, never an HTTP status — headers
flushed long before a tool ever ran.

A tool that merely fails is not a stream failure. Its error degrades to a bounded
result the model can react to, and the loop continues.

## Action tools (mutating)

`mode: 'action'` marks a tool that writes. **Action tools are refused
unconditionally today.** They are never advertised to the model, and a call to one is
denied with `tool_action_disabled`.

<Callout type="info" title="Why the kill-switch is still down">
`actionTools.enabled` exists and validates, but the human-confirmation flow it gates
(a signed confirmation token and idempotency of effect) has not shipped. Rather than
let writes through half-guarded, the satellite refuses them. Setting `enabled: true`
today only tells the `ai_tools` doctor check to say so; it does not enable writes.
</Callout>

The consequence is worth stating plainly: an indirect prompt injection can make the
model *propose* a write, but there is no path for it to perform one. Today's agency
is read-only by construction.

## Honest limits

- **The model chooses.** Tool calling is the model deciding what to look up. It can
  call the wrong tool, or answer without calling one. The satellite bounds what a call
  can *do*; it cannot make the model's choice correct.
- **Your handler owns its query cost.** The satellite's overhead is O(1) per call, but
  a handler that scans a large table does so on the request path, inside the loop's
  timeout.
- **`maxConcurrentPerTenant` gates total in-flight streams**, not tool loops exactly:
  it reuses the shared liveness set, so a tenant already busy with plain chats can be
  refused a new tool loop. That is deliberate (it is what protects the connection
  pool), and it is per-process, like every per-pod rail.
- **Results are fenced, not sanitized.** Fencing is defense in depth; role separation
  is the control. A tool result containing hostile text reaches the model as data, by
  design — a customer legitimately named `</tool_result>` must still be readable.
- **`parseInput` is synchronous.** A host validator that supersedes the shipped
  checker must be sync, so an async validator (vine, for instance) cannot satisfy it.
  Prefer the shipped subset checker: it also gives you whitelist reconstruction, which
  `parseInput` bypasses.

## Read next

- [AI security & threat model](/guides/satellites/ai-security) — vector #12, invariant I7, and the full posture.
- [AI satellite](/guides/satellites/ai) — config, routes and the streaming gateway.
- [Quotas](/guides/satellites/quotas) — the `aiTokens` budget a tool loop reserves against.
