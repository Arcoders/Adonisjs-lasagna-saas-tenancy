import { defineConfig } from 'vitepress'

const PKG = '@adonisjs-lasagna/saas-tenancy'
const REPO = 'https://github.com/Arcoders/Adonisjs-lasagna-saas-tenancy'

export default defineConfig({
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
  markdown: {
    theme: {
      light: 'github-dark',
      dark: 'github-dark',
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
      { text: 'Why', link: '/why' },
      { text: 'Quickstart', link: '/quickstart' },
      {
        text: 'Docs',
        items: [
          { text: 'Introduction', link: '/docs/introduction' },
          { text: 'Concepts', link: '/docs/concepts' },
          { text: 'Installation', link: '/docs/installation' },
          { text: 'Tenant identification', link: '/docs/tenant-identification' },
          { text: 'Data isolation', link: '/docs/data-isolation/' },
          { text: 'Bootstrappers', link: '/docs/bootstrappers/' },
          { text: 'Commands', link: '/docs/commands' },
          { text: 'Satellites', link: '/docs/satellites/' },
          { text: 'Lifecycle events', link: '/docs/events' },
          { text: 'Background jobs', link: '/docs/jobs' },
          { text: 'Health & metrics', link: '/docs/health' },
          { text: 'Read replicas', link: '/docs/read-replicas' },
          { text: 'Contextual logging', link: '/docs/contextual-logging' },
          { text: 'Routing', link: '/docs/routing' },
          { text: 'Testing', link: '/docs/testing' },
          { text: 'Admin REST API', link: '/docs/admin-rest-api' },
          { text: 'Deployment', link: '/docs/deployment' },
          { text: 'Cookbook', link: '/docs/cookbook/' },
          { text: 'Comparison vs stancl', link: '/docs/comparison' },
          { text: 'Contributing', link: '/docs/contributing' },
          { text: 'Release notes', link: '/docs/release-notes' },
        ],
      },
      { text: 'Showcase', link: '/showcase' },
      { text: 'Sponsor', link: '/sponsor' },
      {
        text: 'v0.2.0',
        items: [
          { text: 'Changelog', link: `${REPO}/blob/master/CHANGELOG.md` },
          { text: 'Release notes', link: '/docs/release-notes' },
          { text: 'npm', link: `https://www.npmjs.com/package/${PKG}` },
        ],
      },
    ],

    sidebar: {
      '/docs/': [
        {
          text: 'Getting started',
          items: [
            { text: 'Introduction', link: '/docs/introduction' },
            { text: 'Concepts', link: '/docs/concepts' },
            { text: 'Installation', link: '/docs/installation' },
          ],
        },
        {
          text: 'Tenant lifecycle',
          items: [
            { text: 'Tenant identification', link: '/docs/tenant-identification' },
            {
              text: 'Data isolation',
              link: '/docs/data-isolation/',
              collapsed: true,
              items: [
                { text: 'schema-pg', link: '/docs/data-isolation/schema-pg' },
                { text: 'database-pg', link: '/docs/data-isolation/database-pg' },
                { text: 'rowscope-pg', link: '/docs/data-isolation/rowscope-pg' },
                { text: 'sqlite-memory', link: '/docs/data-isolation/sqlite-memory' },
              ],
            },
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
            { text: 'Commands', link: '/docs/commands' },
          ],
        },
        {
          text: 'Service surface',
          items: [
            {
              text: 'Satellites',
              link: '/docs/satellites/',
              collapsed: true,
              items: [
                { text: 'Audit', link: '/docs/satellites/audit' },
                { text: 'Feature flags', link: '/docs/satellites/feature-flags' },
                { text: 'Webhooks', link: '/docs/satellites/webhooks' },
                { text: 'Branding', link: '/docs/satellites/branding' },
                { text: 'SSO', link: '/docs/satellites/sso' },
                { text: 'Metrics', link: '/docs/satellites/metrics' },
                { text: 'Quotas', link: '/docs/satellites/quotas' },
                { text: 'Billing', link: '/docs/satellites/billing' },
                { text: 'Impersonation', link: '/docs/satellites/impersonation' },
              ],
            },
            { text: 'Routing', link: '/docs/routing' },
            { text: 'Lifecycle events', link: '/docs/events' },
            { text: 'Background jobs', link: '/docs/jobs' },
            { text: 'Health & metrics', link: '/docs/health' },
            { text: 'Read replicas', link: '/docs/read-replicas' },
            { text: 'Contextual logging', link: '/docs/contextual-logging' },
            { text: 'Testing', link: '/docs/testing' },
            { text: 'Admin REST API', link: '/docs/admin-rest-api' },
          ],
        },
        {
          text: 'Operate',
          items: [
            { text: 'Deployment', link: '/docs/deployment' },
            { text: 'Security', link: '/security' },
            {
              text: 'Cookbook',
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
          text: 'Reference',
          items: [
            { text: 'Comparison vs stancl', link: '/docs/comparison' },
            { text: 'Contributing', link: '/docs/contributing' },
            { text: 'Release notes', link: '/docs/release-notes' },
          ],
        },
      ],
      '/': [
        {
          text: 'Getting started',
          items: [
            { text: 'Quickstart', link: '/quickstart' },
            { text: 'Why Lasagna', link: '/why' },
            { text: 'Security', link: '/security' },
          ],
        },
        {
          text: 'Documentation',
          items: [
            { text: 'Introduction', link: '/docs/introduction' },
            { text: 'Concepts', link: '/docs/concepts' },
            { text: 'Installation', link: '/docs/installation' },
            { text: 'All sections →', link: '/docs/introduction' },
          ],
        },
        {
          text: 'Community',
          items: [
            { text: 'Showcase', link: '/showcase' },
            { text: 'Sponsor', link: '/sponsor' },
          ],
        },
      ],
    },

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
})
