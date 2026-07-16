# Documentation style guide

This is the contributor guide for writing Lasagna's docs. It is **not** a published page
(`srcExclude` keeps it out of the built site). The goal is a learning-first manual that
teaches, in the AdonisJS v7 tradition: every page answers *what is this?*, *why do I need it?*,
and *how do I use it?*.

If you change this guide, keep it short. The point is that a contributor can read it in five
minutes and write a page that matches the rest of the site.

## Information architecture

The site is organised into three pillars. Put a new page in the one that matches the reader's
intent, and add it to the sidebar in [.vitepress/config.ts](.vitepress/config.ts).

| Pillar | Directory | URL prefix | For |
|---|---|---|---|
| **Start** | `docs/start/` | `/start/…` | Onboarding: introduction, why, concepts, quickstart, installation. |
| **Guides** | `docs/guides/` | `/guides/…` | Building with Lasagna: core concepts, features, satellites, production. |
| **Reference** | `docs/reference/` | `/reference/…` | Lookups: configuration, commands, events, hooks, services, exceptions, meta. |

Satellites live under `docs/guides/satellites/`. Recipes under `docs/guides/cookbook/`.

### Moving or renaming a page

Changing a file's path changes its public URL. Pages are served from GitHub Pages (static), so
broken inbound links cannot be fixed server-side. When you move a page:

1. Add the old → new URL to [redirects.json](redirects.json).
2. The `buildEnd` hook in [.vitepress/config.ts](.vitepress/config.ts) emits a meta-refresh
   stub at every old URL at build time — verify with `npm run docs:build`.
3. Update the sidebar and any internal links. The build's dead-link check fails on a miss, so
   it is your safety net; run it before pushing.

## Callouts: use the `<Callout>` component

Use the Vue [`<Callout>`](.vitepress/theme/components/Callout.vue) component, **not** raw
`:::note` / `:::tip` markdown containers. It is type-checked and supports a title.

```md
<Callout type="tip" title="One sentence">
The shortest possible statement of the idea.
</Callout>
```

`type` is one of `note` (default), `tip`, `info`, `warning`, `danger`. `title` is optional and
falls back to the type name.

| Type | When to use |
|---|---|
| `tip` | A best practice, shortcut, or recommended path. |
| `note` | Extra context or a clarification. |
| `info` | Neutral FYI / background. |
| `warning` | A pitfall the reader can hit. **Always include the fix in the same callout.** |
| `danger` | A breaking change or data-loss risk. |

## Page conventions

Every page should have:

1. **Frontmatter** with `title` and `description` (the description feeds SEO + the OG tags):
   ```md
   ---
   title: Webhooks
   description: HMAC-signed outbound events with a delivery state machine and retries.
   ---
   ```
2. **A feature-summary lead** right after the H1 — a one-paragraph or bulleted "what you'll
   learn / what you get" so the reader knows what the page covers before the details.
3. **Complete, runnable code examples.** Include the file path as the first line and real
   imports — no fragments, no pseudo-code:
   ```ts
   // start/kernel.ts
   import { TrackMetricsMiddleware } from '@adonisjs-lasagna/saas-tenancy/middleware'
   ```
4. **A "Read next"** section at the end linking the next logical pages, so readers stay in flow.

## Writing rules

- **No sandwich pattern.** Show the code, then explain the consequence. Don't explain the same
  code both before and after the block.
- **Every warning ships a solution.** If you tell the reader something can go wrong, tell them
  how to avoid or fix it in the same place.
- **Confident, direct language.** State how it works. Avoid hedging ("you might possibly want
  to maybe…") and avoid over-explaining the obvious.
- **Prefer the helper, name the real symbol.** Document the actual exported name and import
  path; verify it against source rather than memory. The integrity tests
  (`npm run test:integrity`) guard that every command and config key is documented, but they
  can't catch a wrong signature.
- **Natural prose.** No em-dash separators; write the way the surrounding pages read.

## Before you push

- `npm run docs:build` — must pass with **zero dead links** and emit the redirect stubs.
- `npm run test:integrity` — guards that every ace command, config option, and package has docs.
