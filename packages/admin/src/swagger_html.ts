/**
 * Tiny Swagger UI shell for the admin API docs. `swagger-ui-dist` is intentionally
 * NOT a dependency (zero footprint), so the assets are loaded from a base the
 * operator provides, never a public CDN the package ships by default.
 *
 * Enable the rendered docs by pointing `cdnBase` (or the `LASAGNA_ADMIN_SWAGGER_CDN`
 * env var) at a Swagger UI dist:
 *   - self-hosted: `/swagger/` (assets you serve from `public/`), or
 *   - a CDN you explicitly trust and pin: `https://cdn.example.com/swagger-ui-dist@5/`.
 * With neither set, the docs route renders a short placeholder explaining this rather
 * than silently fetching third-party JavaScript. This keeps a shipped package from
 * carrying a remote-asset supply-chain surface no operator opted into.
 */

const CDN_ENV_VAR = 'LASAGNA_ADMIN_SWAGGER_CDN'

export interface SwaggerOptions {
  /** Base URL/path for the Swagger UI dist assets (absolute https URL or a `/`-rooted path). */
  cdnBase?: string
  title?: string
}

function htmlEscape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/'/g, '&#39;')
    .replace(/"/g, '&quot;')
}

/**
 * The asset base ends up as the `src` of `<script>`/`<link>` tags. Accept only an
 * absolute https URL or a `/`-rooted path so an operator cannot inject a
 * `javascript:` URL into a docs page served behind the admin auth gate. Returns null
 * when no base is configured (param nor env) or the value is unsafe. The caller then
 * renders the placeholder instead of a remote fetch.
 */
function resolveCdnBase(value: string | undefined): string | null {
  const v = value ?? process.env[CDN_ENV_VAR] ?? ''
  if (!v) return null
  if (v.startsWith('/')) return v
  if (/^https:\/\/[a-zA-Z0-9.-]+\//.test(v)) return v
  return null
}

/** The placeholder shown when no Swagger UI asset base is configured. */
function renderDocsPlaceholder(specUrl: string, title: string): string {
  const safeSpec = htmlEscape(specUrl)
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>body{font-family:system-ui,sans-serif;max-width:42rem;margin:3rem auto;padding:0 1rem;line-height:1.5}code{background:#f4f4f5;padding:.1rem .3rem;border-radius:.25rem}</style>
</head>
<body>
<h1>${title}</h1>
<p>The interactive API docs need a Swagger UI asset base, which this package does not
ship (no bundled or default third-party CDN). Set it once, then reload:</p>
<ul>
<li>self-host the <code>swagger-ui-dist</code> assets and set <code>${CDN_ENV_VAR}=/swagger/</code>, or</li>
<li>point <code>${CDN_ENV_VAR}</code> at a CDN you explicitly trust and pin.</li>
</ul>
<p>The raw OpenAPI document is always available at <a href="${safeSpec}">${safeSpec}</a>.</p>
</body>
</html>`
}

export function renderSwaggerHtml(specUrl: string, options: SwaggerOptions = {}): string {
  const title = htmlEscape(options.title ?? 'Lasagna Multitenancy Admin API')
  const base = resolveCdnBase(options.cdnBase)
  if (base === null) return renderDocsPlaceholder(specUrl, title)

  const cdn = htmlEscape(base)
  // `specUrl` ends up both in HTML attribute context and inside a JS
  // string literal. HTML-escape covers both: single quotes become
  // `&#39;` which JS parsers tolerate.
  const safeSpec = htmlEscape(specUrl)
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<link rel="stylesheet" href="${cdn}swagger-ui.css">
<style>body { margin: 0; padding: 0; }</style>
</head>
<body>
<div id="swagger-ui"></div>
<script src="${cdn}swagger-ui-bundle.js" crossorigin></script>
<script src="${cdn}swagger-ui-standalone-preset.js" crossorigin></script>
<script>
window.addEventListener('load', function () {
  window.ui = SwaggerUIBundle({
    url: '${safeSpec}',
    dom_id: '#swagger-ui',
    deepLinking: true,
    presets: [SwaggerUIBundle.presets.apis, SwaggerUIStandalonePreset.slice(1)],
    plugins: [SwaggerUIBundle.plugins.DownloadUrl],
    layout: 'StandaloneLayout',
  });
});
</script>
</body>
</html>`
}
