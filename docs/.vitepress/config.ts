import { defineConfig } from 'vitepress'
import { withMermaid } from 'vitepress-plugin-mermaid'
import { createRequire } from 'node:module'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const PKG = '@adonisjs-lasagna/saas-tenancy'
const REPO = 'https://github.com/Arcoders/Adonisjs-lasagna-saas-tenancy'
// Track the published core version so the nav label never goes stale.
const { version } = require('../../packages/core/package.json')

// One sidebar applied across the whole site, organised into the three AdonisJS-v7
// pillars: Start → Guides → Reference. The Guides pillar keeps the pedagogy in
// nested sub-groups (Core concepts / Building / Satellites / Production). Pages
// moved out of the old flat `/docs/*` layout in the 1.0 docs restructure; old
// URLs keep working via the redirect stubs emitted in `buildEnd` (see below).
const sidebar = [
  {
    text: 'Start',
    items: [
      { text: 'Introduction', link: '/start/introduction' },
      { text: 'Why multi-tenancy', link: '/start/why' },
      { text: 'Why AdonisJS?', link: '/start/why-adonisjs' },
      { text: 'Concepts', link: '/start/concepts' },
      { text: 'Quickstart', link: '/start/quickstart' },
      { text: 'Installation & configuration', link: '/start/installation' },
      {
        text: 'Tutorial: build a SaaS',
        collapsed: false,
        items: [
          { text: 'Overview', link: '/start/tutorial/' },
          { text: '1. Setup', link: '/start/tutorial/setup' },
          { text: '2. Tenants', link: '/start/tutorial/tenants' },
          { text: '3. Users & auth', link: '/start/tutorial/users' },
          { text: '4. Billing', link: '/start/tutorial/billing' },
          { text: '5. Reporting', link: '/start/tutorial/reporting' },
        ],
      },
    ],
  },
  {
    text: 'Guides',
    items: [
      {
        text: 'Core concepts',
        collapsed: false,
        items: [
          { text: 'Tenant identification', link: '/guides/tenant-identification' },
          {
            text: 'Data isolation',
            link: '/guides/data-isolation/',
            collapsed: true,
            items: [
              { text: 'schema-pg', link: '/guides/data-isolation/schema-pg' },
              { text: 'database-pg', link: '/guides/data-isolation/database-pg' },
              { text: 'rowscope-pg', link: '/guides/data-isolation/rowscope-pg' },
              { text: 'sqlite-memory', link: '/guides/data-isolation/sqlite-memory' },
            ],
          },
          { text: 'Request context & routing', link: '/guides/routing' },
          { text: 'Models & adapters', link: '/guides/models' },
          {
            text: 'Bootstrappers',
            link: '/guides/bootstrappers/',
            collapsed: true,
            items: [
              { text: 'Database', link: '/guides/bootstrappers/database' },
              { text: 'Cache', link: '/guides/bootstrappers/cache' },
              { text: 'Filesystem', link: '/guides/bootstrappers/filesystem' },
              { text: 'Mail', link: '/guides/bootstrappers/mail' },
              { text: 'Session', link: '/guides/bootstrappers/session' },
              { text: 'Broadcasting', link: '/guides/bootstrappers/broadcasting' },
            ],
          },
        ],
      },
      {
        text: 'Building',
        collapsed: false,
        items: [
          { text: 'Authentication', link: '/guides/authentication' },
          { text: 'Background jobs & queues', link: '/guides/jobs' },
          { text: 'Read replicas', link: '/guides/read-replicas' },
          { text: 'Contextual logging', link: '/guides/contextual-logging' },
          { text: 'Testing', link: '/guides/testing' },
          {
            text: 'Recipes',
            link: '/guides/cookbook/',
            collapsed: true,
            items: [
              {
                text: 'Adding features later',
                link: '/guides/cookbook/adding-features-incrementally',
              },
              {
                text: 'Tenant onboarding & offboarding',
                link: '/guides/cookbook/tenant-onboarding-offboarding',
              },
              {
                text: 'Per-tenant worker concurrency',
                link: '/guides/cookbook/per-tenant-worker-concurrency',
              },
              { text: 'Custom-domain HTTPS', link: '/guides/cookbook/custom-domain-https' },
              { text: 'Stripe + quotas', link: '/guides/cookbook/stripe-quotas' },
              { text: 'Multi-tenant WebSockets', link: '/guides/cookbook/multi-tenant-websockets' },
              { text: 'Multi-region replicas', link: '/guides/cookbook/multi-region-replicas' },
              { text: 'Custom isolation driver', link: '/guides/cookbook/custom-isolation-driver' },
              { text: 'Creating a satellite', link: '/guides/cookbook/creating-a-satellite' },
            ],
          },
        ],
      },
      {
        text: 'Satellites',
        collapsed: true,
        items: [
          { text: 'Overview', link: '/guides/satellites/' },
          { text: 'Audit', link: '/guides/satellites/audit' },
          { text: 'Feature flags', link: '/guides/satellites/feature-flags' },
          { text: 'Webhooks', link: '/guides/satellites/webhooks' },
          { text: 'Branding', link: '/guides/satellites/branding' },
          { text: 'SSO', link: '/guides/satellites/sso' },
          { text: 'WebSockets', link: '/guides/satellites/websockets' },
          { text: 'Metrics', link: '/guides/satellites/metrics' },
          { text: 'Reporting', link: '/guides/satellites/reporting' },
          { text: 'Quotas', link: '/guides/satellites/quotas' },
          { text: 'Billing', link: '/guides/satellites/billing' },
          { text: 'Backup', link: '/guides/satellites/backup' },
          { text: 'Impersonation', link: '/guides/satellites/impersonation' },
          { text: 'Admin', link: '/guides/satellites/admin' },
          { text: 'Admin REST API', link: '/guides/satellites/admin-rest-api' },
          { text: 'Extensibility', link: '/guides/extensibility' },
        ],
      },
      {
        text: 'Production',
        collapsed: true,
        items: [
          { text: 'Security', link: '/guides/security' },
          { text: 'Compliance (SOC2 & GDPR)', link: '/guides/compliance' },
          { text: 'Resilience', link: '/guides/resilience' },
          { text: 'Rate limiting', link: '/guides/rate-limiting' },
          { text: 'Health & monitoring', link: '/guides/health' },
          { text: 'Performance & benchmarks', link: '/guides/performance' },
          { text: 'Scaling limits', link: '/guides/scaling-limits' },
          { text: 'Deployment', link: '/guides/deployment' },
          { text: 'Documentation coverage', link: '/guides/documentation-coverage' },
        ],
      },
    ],
  },
  {
    text: 'Reference',
    items: [
      { text: 'Configuration', link: '/reference/configuration' },
      { text: 'CLI commands', link: '/reference/commands' },
      { text: 'Lifecycle events', link: '/reference/events' },
      { text: 'Hooks', link: '/reference/hooks' },
      { text: 'Services API', link: '/reference/services' },
      { text: 'Exceptions', link: '/reference/exceptions' },
      { text: 'Production checklist & runbook', link: '/reference/production-checklist' },
      { text: 'Stability', link: '/reference/stability' },
      { text: 'Upgrade to 1.0', link: '/reference/upgrade-to-1.0' },
      { text: 'Roadmap', link: '/reference/roadmap' },
      { text: 'Comparison', link: '/reference/comparison' },
      { text: 'Troubleshooting', link: '/reference/gotchas' },
      { text: 'FAQ', link: '/reference/faq' },
      { text: 'Known limitations', link: '/reference/known-limitations' },
      { text: 'Contributing', link: '/reference/contributing' },
      { text: 'Release notes', link: '/reference/release-notes' },
    ],
  },
]

// GitHub Pages serves static files only, so the docs restructure preserves old
// URLs with client-side redirect stubs. `redirects.json` maps every old page URL
// to its new one; for each we drop a tiny meta-refresh + canonical HTML file at
// the OLD path in the build output, pointing at the base-prefixed new URL.
function writeRedirectStubs(siteConfig: any) {
  const redirectsPath = fileURLToPath(new URL('../redirects.json', import.meta.url))
  const redirects: Record<string, string> = JSON.parse(readFileSync(redirectsPath, 'utf8'))
  const base = (siteConfig.site?.base ?? '/').replace(/\/$/, '')
  const outDir: string = siteConfig.outDir
  const stub = (to: string) =>
    `<!doctype html><html><head><meta charset="utf-8">` +
    `<meta http-equiv="refresh" content="0; url=${to}">` +
    `<link rel="canonical" href="${to}"><meta name="robots" content="noindex">` +
    `<title>Page moved</title></head><body>` +
    `This page moved. <a href="${to}">Continue →</a></body></html>\n`
  let count = 0
  for (const [oldUrl, newUrl] of Object.entries(redirects)) {
    const to = base + newUrl
    const rel = (oldUrl.endsWith('/') ? `${oldUrl}index.html` : `${oldUrl}.html`).replace(/^\//, '')
    const file = join(outDir, rel)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, stub(to), 'utf8')
    count++
  }
  console.log(`[docs] wrote ${count} redirect stubs for moved pages`)
}

// `withMermaid` wraps the VitePress config to render ```mermaid fenced code
// blocks as diagrams (used on the Concepts and Data isolation pages). It merges
// in its own markdown-it plugin and Vite SSR settings; the existing
// `markdown.config` table rule, `transformHead`, and `head` below are preserved.
export default withMermaid({
  ...defineConfig({
  title: 'Lasagna SaaS Tenancy',
  description:
    'SaaS multi-tenancy for AdonisJS 7. Connection routing, circuit breaker, queues, contextual logging, plans/quotas, backups, replicas, audit logs, webhooks, SSO, Stripe billing.',
  // Project-pages base — required so CSS/JS resolve under
  // arcoders.github.io/Adonisjs-lasagna-saas-tenancy/. Drop the
  // base (or set to '/') if you later move the site behind a
  // custom domain via a CNAME file.
  base: '/Adonisjs-lasagna-saas-tenancy/',
  cleanUrls: true,
  lastUpdated: true,

  // STYLE.md is a contributor guide for writing these docs, not a published page.
  // dev/ holds dev-facing design contracts (the doc-coverage RFC): they are living
  // engineering docs, kept out of the published site and the dead-link gate.
  srcExclude: ['STYLE.md', 'dev/*.md'],

  // After the static build, emit redirect stubs for every pre-restructure URL so
  // existing inbound links and bookmarks land on the new Start/Guides/Reference path.
  buildEnd(siteConfig) {
    writeRedirectStubs(siteConfig)
  },

  // Adaptive Shiki theme: light code on light pages, dark code on dark.
  // The minimalist restyle dropped the forced-dark code surface, so code
  // blocks now follow VitePress's default theme-aware styling.
  markdown: {
    theme: {
      light: 'github-light',
      dark: 'github-dark',
    },
    // Wrap every markdown table in a horizontally-scrollable container so wide
    // tables (e.g. the benchmark tables on the Performance page) scroll inside
    // their own box instead of overflowing the layout and colliding with the
    // right-hand table of contents. The wrapper carries the border/radius (see
    // `.vp-table-scroll` in theme/style.css).
    config(md) {
      md.renderer.rules.table_open = () => '<div class="vp-table-scroll">\n<table>\n'
      md.renderer.rules.table_close = () => '</table>\n</div>\n'
    },
  },

  head: [
    ['link', { rel: 'icon', type: 'image/png', sizes: '32x32', href: '/favicon-32.png' }],
    ['link', { rel: 'icon', type: 'image/png', sizes: '128x128', href: '/favicon.png' }],
    ['link', { rel: 'apple-touch-icon', sizes: '180x180', href: '/apple-touch-icon.png' }],
    ['meta', { name: 'theme-color', content: '#C26A4B' }],
    ['meta', { property: 'og:type', content: 'website' }],
    ['meta', { property: 'og:site_name', content: 'Lasagna SaaS Tenancy' }],
    ['meta', { property: 'og:image', content: '/og-default.svg' }],
    ['meta', { name: 'twitter:card', content: 'summary_large_image' }],
    ['meta', { name: 'twitter:image', content: '/og-default.svg' }],
  ],

  // Inject per-page og:title / og:description from each page's frontmatter,
  // falling back to the site-level defaults when a page doesn't set them.
  transformHead({ pageData }) {
    const fm = pageData.frontmatter ?? {}
    const title =
      fm.title ?? pageData.title ?? 'Lasagna SaaS Tenancy for AdonisJS 7'
    const description =
      fm.description ??
      pageData.description ??
      'Schema-based PostgreSQL SaaS tenancy for AdonisJS 7 — production multi-tenant plumbing in one package.'
    return [
      ['meta', { property: 'og:title', content: title }],
      ['meta', { property: 'og:description', content: description }],
      ['meta', { name: 'twitter:title', content: title }],
      ['meta', { name: 'twitter:description', content: description }],
      ['meta', { name: 'description', content: description }],
    ]
  },

  themeConfig: {
    siteTitle: 'Lasagna',
    logo: '/logo.png',

    nav: [
      { text: 'Start', link: '/start/introduction', activeMatch: '/start/' },
      { text: 'Guides', link: '/guides/tenant-identification', activeMatch: '/guides/' },
      { text: 'Reference', link: '/reference/configuration', activeMatch: '/reference/' },
      { text: 'Architecture', link: '/architecture', activeMatch: '/architecture' },
      { text: 'Showcase', link: '/showcase' },
      { text: 'Sponsor', link: '/sponsor' },
      {
        text: `v${version}`,
        items: [
          { text: 'Changelog', link: `${REPO}/blob/master/CHANGELOG.md` },
          { text: 'Release notes', link: '/reference/release-notes' },
          { text: 'npm', link: `https://www.npmjs.com/package/${PKG}` },
        ],
      },
    ],

    sidebar,

    socialLinks: [
      { icon: 'github', link: REPO },
      { icon: 'npm', link: `https://www.npmjs.com/package/${PKG}` },
    ],

    editLink: {
      pattern: `${REPO}/edit/master/docs/:path`,
      text: 'Edit this page on GitHub',
    },

    search: { provider: 'local' },

    footer: {
      message: 'Released under the MIT License.',
      copyright: 'Copyright © 2025-present Ismael Haytam Tanane',
    },

    outline: { level: [2, 3] },
  },
  }),

  // Mermaid rendering options, read by vitepress-plugin-mermaid via
  // `virtual:mermaid-config`. A larger base font and looser node/rank spacing
  // make the flowcharts render at a legible size instead of a compact thumbnail;
  // theme colors are left to mermaid's built-in light/dark themes (the plugin
  // swaps to its `dark` theme automatically when the page is in dark mode).
  mermaid: {
    flowchart: { useMaxWidth: true, htmlLabels: true, nodeSpacing: 54, rankSpacing: 64 },
    themeVariables: { fontSize: '18px' },
  },
})
