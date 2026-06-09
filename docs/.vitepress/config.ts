import { defineConfig } from 'vitepress'
import { withMermaid } from 'vitepress-plugin-mermaid'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const PKG = '@adonisjs-lasagna/saas-tenancy'
const REPO = 'https://github.com/Arcoders/Adonisjs-lasagna-saas-tenancy'
// Track the published core version so the nav label never goes stale.
const { version } = require('../../packages/core/package.json')

// One task-ordered sidebar applied across the whole site (Getting Started →
// Core Concepts → Guides → Satellites → Production → Reference → Resources).
// Root pages (/why, /quickstart, /security) are linked by absolute path so the
// same tree shows everywhere; the home page renders no sidebar.
const sidebar = [
  {
    text: 'Getting Started',
    items: [
      { text: 'Introduction', link: '/docs/introduction' },
      { text: 'Why multi-tenancy', link: '/why' },
      { text: 'Concepts', link: '/docs/concepts' },
      { text: 'Quickstart', link: '/quickstart' },
      { text: 'Installation & configuration', link: '/docs/installation' },
    ],
  },
  {
    text: 'Core Concepts',
    items: [
      { text: 'Tenant identification', link: '/docs/tenant-identification' },
      {
        text: 'Data isolation',
        link: '/docs/data-isolation/',
        collapsed: false,
        items: [
          { text: 'schema-pg', link: '/docs/data-isolation/schema-pg' },
          { text: 'database-pg', link: '/docs/data-isolation/database-pg' },
          { text: 'rowscope-pg', link: '/docs/data-isolation/rowscope-pg' },
          { text: 'sqlite-memory', link: '/docs/data-isolation/sqlite-memory' },
        ],
      },
      { text: 'Request context & routing', link: '/docs/routing' },
      { text: 'Models & adapters', link: '/docs/models' },
      {
        text: 'Bootstrappers',
        link: '/docs/bootstrappers/',
        collapsed: true,
        items: [
          { text: 'Database', link: '/docs/bootstrappers/database' },
          { text: 'Cache', link: '/docs/bootstrappers/cache' },
          { text: 'Filesystem', link: '/docs/bootstrappers/filesystem' },
          { text: 'Mail', link: '/docs/bootstrappers/mail' },
          { text: 'Session', link: '/docs/bootstrappers/session' },
          { text: 'Broadcasting', link: '/docs/bootstrappers/broadcasting' },
        ],
      },
    ],
  },
  {
    text: 'Guides',
    items: [
      { text: 'Authentication', link: '/docs/authentication' },
      { text: 'Background jobs & queues', link: '/docs/jobs' },
      { text: 'Read replicas', link: '/docs/read-replicas' },
      { text: 'Contextual logging', link: '/docs/contextual-logging' },
      { text: 'Testing', link: '/docs/testing' },
      {
        text: 'Recipes',
        link: '/docs/cookbook/',
        collapsed: true,
        items: [
          { text: 'Custom-domain HTTPS', link: '/docs/cookbook/custom-domain-https' },
          { text: 'Stripe + quotas', link: '/docs/cookbook/stripe-quotas' },
          { text: 'Multi-region replicas', link: '/docs/cookbook/multi-region-replicas' },
          { text: 'Custom isolation driver', link: '/docs/cookbook/custom-isolation-driver' },
        ],
      },
    ],
  },
  {
    text: 'Satellites',
    items: [
      { text: 'Overview', link: '/docs/satellites/' },
      { text: 'Audit', link: '/docs/satellites/audit' },
      { text: 'Feature flags', link: '/docs/satellites/feature-flags' },
      { text: 'Webhooks', link: '/docs/satellites/webhooks' },
      { text: 'Branding', link: '/docs/satellites/branding' },
      { text: 'SSO', link: '/docs/satellites/sso' },
      { text: 'Metrics', link: '/docs/satellites/metrics' },
      { text: 'Quotas', link: '/docs/satellites/quotas' },
      { text: 'Billing', link: '/docs/satellites/billing' },
      { text: 'Impersonation', link: '/docs/satellites/impersonation' },
      { text: 'Admin REST API', link: '/docs/admin-rest-api' },
    ],
  },
  {
    text: 'Production',
    items: [
      { text: 'Security', link: '/security' },
      { text: 'Resilience', link: '/docs/resilience' },
      { text: 'Health & monitoring', link: '/docs/health' },
      { text: 'Performance & benchmarks', link: '/docs/performance' },
      { text: 'Scaling limits', link: '/docs/scaling-limits' },
      { text: 'Deployment', link: '/docs/deployment' },
      { text: 'Production checklist & runbook', link: '/docs/production-checklist' },
    ],
  },
  {
    text: 'Reference',
    items: [
      { text: 'Configuration', link: '/docs/configuration' },
      { text: 'CLI commands', link: '/docs/commands' },
      { text: 'Lifecycle events', link: '/docs/events' },
      { text: 'Hooks', link: '/docs/hooks' },
      { text: 'Services API', link: '/docs/services' },
      { text: 'Exceptions', link: '/docs/exceptions' },
    ],
  },
  {
    text: 'Resources',
    items: [
      { text: 'Stability', link: '/docs/stability' },
      { text: 'Roadmap', link: '/docs/roadmap' },
      { text: 'Upgrade to 1.0', link: '/docs/upgrade-to-1.0' },
      { text: 'Comparison vs stancl', link: '/docs/comparison' },
      { text: 'Troubleshooting', link: '/docs/gotchas' },
      { text: 'FAQ', link: '/docs/faq' },
      { text: 'Known limitations', link: '/docs/known-limitations' },
      { text: 'Contributing', link: '/docs/contributing' },
      { text: 'Release notes', link: '/docs/release-notes' },
    ],
  },
]

// `withMermaid` wraps the VitePress config to render ```mermaid fenced code
// blocks as diagrams (used on the Concepts and Data isolation pages). It merges
// in its own markdown-it plugin and Vite SSR settings; the existing
// `markdown.config` table rule, `transformHead`, and `head` below are preserved.
export default withMermaid(
  defineConfig({
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

  // Code blocks are always rendered on the dark Lasagna code surface
  // (see `--lg-code-bg` in theme/style.css), so force a dark Shiki theme
  // in both light and dark modes — otherwise the light theme's dark
  // tokens render on our dark background and become unreadable.
  // (Switches to adaptive light/dark with the minimalist restyle.)
  markdown: {
    theme: {
      light: 'github-dark',
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
    ['link', { rel: 'icon', type: 'image/svg+xml', href: '/favicon.svg' }],
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
    logo: { light: '/logo.svg', dark: '/logo-dark.svg' },

    nav: [
      { text: 'Docs', link: '/docs/introduction', activeMatch: '/docs/' },
      { text: 'Why', link: '/why' },
      { text: 'Quickstart', link: '/quickstart' },
      {
        text: 'Reference',
        link: '/docs/configuration',
        activeMatch: '/docs/(configuration|commands|events|hooks|services|exceptions)',
      },
      { text: 'Showcase', link: '/showcase' },
      { text: 'Sponsor', link: '/sponsor' },
      {
        text: `v${version}`,
        items: [
          { text: 'Changelog', link: `${REPO}/blob/master/CHANGELOG.md` },
          { text: 'Release notes', link: '/docs/release-notes' },
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
)
