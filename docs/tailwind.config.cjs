/**
 * Tailwind config for the Lasagna VitePress theme.
 *
 * - Content scope: only the docs theme + the marketing markdown pages, so
 *   we don't accidentally tree-shake away utilities used by VitePress's
 *   own component output (which doesn't go through Tailwind anyway).
 * - Preflight is disabled: VitePress already ships its own CSS reset and
 *   typography. Re-applying Tailwind's would override headings, links, and
 *   prose spacing.
 * - Token bridge: every Lasagna design token is exposed as a Tailwind
 *   colour so utilities like `bg-lg-bg`, `text-lg-accent`, `border-lg-line`
 *   resolve to the CSS variables (i.e. dark-mode-aware out of the box).
 */
module.exports = {
  content: [
    './docs/.vitepress/theme/**/*.{vue,ts}',
    './docs/index.md',
    './docs/why.md',
    './docs/showcase.md',
    './docs/sponsor.md',
    './docs/quickstart.md',
  ],
  corePlugins: {
    preflight: false,
  },
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        lg: {
          bg: 'var(--lg-bg)',
          surface: 'var(--lg-surface)',
          'surface-alt': 'var(--lg-surface-alt)',
          text: 'var(--lg-text)',
          'text-muted': 'var(--lg-text-muted)',
          accent: 'var(--lg-accent)',
          'accent-soft': 'var(--lg-accent-soft)',
          'accent-2': 'var(--lg-accent-2)',
          'accent-2-soft': 'var(--lg-accent-2-soft)',
          'accent-3': 'var(--lg-accent-3)',
          'accent-4': 'var(--lg-accent-4)',
          line: 'var(--lg-line)',
          'line-strong': 'var(--lg-line-strong)',
          'code-bg': 'var(--lg-code-bg)',
          'code-fg': 'var(--lg-code-fg)',
        },
      },
      fontFamily: {
        serif: ['var(--lg-font-serif)'],
        sans: ['var(--lg-font-sans)'],
        mono: ['var(--lg-font-mono)'],
      },
      boxShadow: {
        'lg-card': 'var(--lg-shadow-card)',
      },
      borderRadius: {
        lg: '12px',
        xl: '20px',
      },
    },
  },
}
