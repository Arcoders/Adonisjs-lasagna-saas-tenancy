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
- [action tools](#action-tools-mutating), where a write waits for a human to confirm it
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
| Mutating tools | **Human-confirmed** | `mode: 'action'` tools run only after a human confirms a signed challenge, and only with the kill-switch on, `authorizeTool` allowing, `summarizeArgs` present and audit on. See [action tools](#action-tools-mutating). |
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

A mutating tool adds one more frame the client handles: a `tool_confirmation_required`
carrying a human-readable `summary` and a `token`. It is not an error — it is the loop
pausing for a human. Show the summary, and on agreement re-send the request with the
token. See [action tools](#action-tools-mutating) for the full round-trip.

## Action tools (mutating)

`mode: 'action'` marks a tool that writes. A write never happens on the model's say-so
alone: the satellite stops the loop, hands the client a signed confirmation to put to a
human, and runs the tool only once that human agrees. Read tools are untouched by any
of this.

### What it takes to enable one

An action tool is the sharpest edge in the package, so it is deliberately several locks
deep. All of these hold, or the call is refused:

- **`actionTools: { enabled: true }`** — the kill-switch, off by default. One flag turns
  every write off, however registered. It is static app config read at boot, so flipping
  it needs a restart; there is no hot global off (a per-tenant runtime lever is your own
  `resolveTools` / `authorizeTool`, consulted per request).
- **`authorizeTool` returns `allow`** — an action tool ignores
  `acknowledgeUnauthorizedTools`. The read-tool convenience of running unauthorized never
  extends to a write; a real hook must really say allow.
- **`summarizeArgs`** — mandatory. It renders the one line the human reads before
  confirming. A tool without it is refused per tool (`tool_action_disabled`) rather than
  shipped with a weaker default, because a human confirming against nothing is a rubber
  stamp.
- **A resolvable principal** — the confirmation binds to a person, so an action a request
  cannot attribute to anyone is refused.
- **Audit on** — `config.ai.audit.enabled` must not be `false`. An action records its
  intent before it runs, so with audit off the machinery is not wired and every action is
  refused `tool_action_unavailable`.

```ts
// config/multitenancy.ts
import { defineTool } from '@adonisjs-lasagna/ai/tools'

tools: {
  registry: [
    defineTool({
      name: 'cancel_booking',
      description: 'Cancel a booking and refund the customer.',
      inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      mode: 'action',
      // HOST code, over the VALIDATED arguments. This is exactly what the human is
      // shown; the model never authors it, so an injection cannot write its own prompt.
      summarizeArgs: (args) => `Cancel booking ${args.id} and refund the customer`,
      handler: async (args) => {
        const { default: Booking } = await import('#app/models/tenant_scoped/booking')
        const booking = await Booking.findOrFail(args.id)
        await booking.cancelAndRefund()
        return { cancelled: true }
      },
    }),
  ],
  authorizeTool: (ctx, tenant, tool) => ({ kind: 'allow' }),
  actionTools: { enabled: true },
}
```

### The confirmation round-trip

1. The model proposes the action. The loop plans the whole round, sees an unconfirmed
   write, runs nothing, and emits a `tool_confirmation_required` frame:

   ```
   event: tool_confirmation_required
   data: {"id":"call_01_...","name":"cancel_booking","summary":"Cancel booking BK-1042 and refund the customer","token":"aitc1...","expiresAt":1737000000000}
   ```

2. Your client shows `summary` to the human and, if they agree, sends the SAME chat
   request again with the token echoed in a header:

   ```
   X-Ai-Tool-Confirmation: aitc1...
   ```

3. The satellite re-derives the tenant, user, tool and arguments from that request,
   confirms they match what the token authorizes, fences the effect so it happens at most
   once, records the intent, and runs the handler.

The token is a bearer capability with a five-minute TTL. It carries no tenant, user, tool
or argument in the clear: everything it authorizes is re-derived from the request being
served and compared against the token's MAC, so a captured token names nothing and
authorizes only the one action it was minted for.

<Callout type="warning" title="Scrub the confirmation header from your logs">
`X-Ai-Tool-Confirmation` is a short-lived capability, and like any bearer token in a
header it lands in access logs, proxy logs and APM traces by default. Add it to your log
redaction list. The five-minute TTL and the principal binding limit the blast radius;
they do not replace scrubbing.
</Callout>

A round holding two writes challenges both together and runs neither until both are
confirmed, so a round is never half-applied. If the model rephrases an argument between
the challenge and the confirmation, the token no longer matches and the action is refused
(`tool_confirmation_invalid`) rather than run against arguments the human never saw, so
prefer a deterministic sampling temperature for conversations that reach action tools.

If you want to run an action with no summarizer, or with `requiresConfirmation: false`,
you cannot: both are refused (`tool_action_disabled`). There is no path to a model-driven
write that a human did not see and agree to.

## Honest limits

- **Confirmation stops autonomy, not injection.** A human-in-the-loop confirmation turns
  a silent autonomous write into a click a person has to make. It does *not* stop prompt
  injection: an injection can propose an action AND emit text engineering the human into
  confirming it. What bounds the damage is everything around the click — `authorizeTool`
  limits what any confirmation can reach, the host-authored `summarizeArgs` keeps model
  prose out of the decision, the loop stops at the frame so no model text follows it, and
  the blast radius of a narrow, reversible action tool is a review question, not a
  mechanism. Keep action tools narrow and reversible.
- **At-most-once, not exactly-once.** The effect ledger guarantees a confirmed action
  fires at most once. A stream that dies after the effect but before the client sees the
  result leaves the action done and unacknowledged; the honest failure direction is *no*
  effect, never a double one.
- **Erasing a user does not revoke their pending tokens.** A GDPR purge does not reach
  into the action ledger to expire confirmation tokens already minted for that user. The
  five-minute TTL bounds the window; this is a stated limit, deferred to the governance
  satellite.
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
