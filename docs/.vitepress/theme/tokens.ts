/**
 * Lasagna design tokens. Single source of truth for the Zellige × Lasagna
 * identity. Two consumers:
 *
 *   1. `style.css` reads these as CSS custom properties.
 *   2. `tailwind.config.cjs` mirrors them as Tailwind colour utilities.
 *
 * Palette v2 — saturated. The v1 palette read as muted; v2 turns the dial up
 * without leaving the Moroccan-tile + warm-cream identity.
 */

export const colors = {
  light: {
    bg: '#FAF1E8',          // warm cream (was #FBF7F4)
    surface: '#FFFFFF',
    surfaceAlt: '#F4E6D5',  // honey paper for nav bands
    text: '#1A0F08',         // espresso, denser than #2E2A26
    textMuted: '#7A5C44',    // tile-shadow brown
    accent: '#D8552A',       // saturated terracotta (was #C26A4B)
    accentSoft: '#F0916E',
    accent2: '#0F6F86',      // deep Zellige teal (was #2A6B7C)
    accent2Soft: '#3FA0B5',
    accent3: '#F2A53A',      // saffron — the new third voice
    accent4: '#3B3F8E',      // Zellige indigo for rare highlights
    line: '#E8D4BE',
    lineStrong: '#B07344',
    codeBg: '#1A0F08',
    codeFg: '#F4E6D5',
    shadow: 'rgba(216, 85, 42, 0.14)',
  },
  dark: {
    bg: '#120A05',           // near-black with warm cast
    surface: '#1E140C',
    surfaceAlt: '#2A1B10',
    text: '#FBF1E4',
    textMuted: '#C7A98A',
    accent: '#FF7A4A',       // brighter on dark
    accentSoft: '#D8552A',
    accent2: '#4FB8CC',      // teal pops on dark
    accent2Soft: '#0F6F86',
    accent3: '#FFC773',      // saffron stays warm
    accent4: '#7B82E0',      // indigo lifts up
    line: '#3A241A',
    lineStrong: '#8A5A3A',
    codeBg: '#0A0503',
    codeFg: '#FBF1E4',
    shadow: 'rgba(0, 0, 0, 0.55)',
  },
} as const

export const radii = {
  sm: '6px',
  md: '14px',
  lg: '22px',
  pill: '9999px',
} as const

export const fonts = {
  // Fraunces is the magazine-grade variable serif. Optical sizing + soft
  // terminals make headings feel modern without giving up serif personality.
  // Inter Display covers everything else; JetBrains Mono for code.
  serif: '"Fraunces", "Newsreader", Georgia, "Iowan Old Style", serif',
  sans: '"Inter", "Inter Display", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
  mono: '"JetBrains Mono", ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',
} as const

export const fontFeatures = {
  sans: '"cv02", "cv03", "cv04", "cv11", "ss01"',
  mono: '"calt", "liga", "ss01", "ss02"',
  serif: '"liga", "kern", "ss01", "ss02"',
} as const

export const shadows = {
  cardLight:
    '0 1px 2px rgba(26, 15, 8, 0.05), 0 16px 40px -12px rgba(216, 85, 42, 0.18)',
  cardDark:
    '0 1px 2px rgba(0, 0, 0, 0.5), 0 18px 44px -12px rgba(0, 0, 0, 0.65)',
  glowAccent:
    '0 0 0 1px rgba(216, 85, 42, 0.3), 0 12px 32px -8px rgba(216, 85, 42, 0.45)',
} as const

export function cssVars(scope: 'light' | 'dark'): string {
  const c = colors[scope]
  const lines = [
    `--lg-bg: ${c.bg};`,
    `--lg-surface: ${c.surface};`,
    `--lg-surface-alt: ${c.surfaceAlt};`,
    `--lg-text: ${c.text};`,
    `--lg-text-muted: ${c.textMuted};`,
    `--lg-accent: ${c.accent};`,
    `--lg-accent-soft: ${c.accentSoft};`,
    `--lg-accent-2: ${c.accent2};`,
    `--lg-accent-2-soft: ${c.accent2Soft};`,
    `--lg-accent-3: ${c.accent3};`,
    `--lg-accent-4: ${c.accent4};`,
    `--lg-line: ${c.line};`,
    `--lg-line-strong: ${c.lineStrong};`,
    `--lg-code-bg: ${c.codeBg};`,
    `--lg-code-fg: ${c.codeFg};`,
    `--lg-shadow: ${c.shadow};`,
    `--lg-shadow-card: ${scope === 'dark' ? shadows.cardDark : shadows.cardLight};`,
    `--lg-shadow-glow: ${shadows.glowAccent};`,
  ]
  return lines.join('\n  ')
}
