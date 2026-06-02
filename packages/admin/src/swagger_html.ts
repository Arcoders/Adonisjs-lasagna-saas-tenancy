/**
 * Tiny Swagger UI shell. Loads `swagger-ui-dist` from a public CDN — keeping
 * `swagger-ui-dist` out of the package's peer dependencies (zero footprint).
 *
 * Operators who want to self-host the assets can override `cdnBase` to point
 * at their own copy (e.g. served from `public/`). For air-gapped deploys,
 * vendor `swagger-ui.css`, `swagger-ui-bundle.js` and `swagger-ui-standalone-preset.js`.
 */

const DEFAULT_CDN = 'https://unpkg.com/swagger-ui-dist@5/'

export interface SwaggerOptions {
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
 * `cdnBase` ends up as the `src` of `<script>`/`<link>` tags. Restrict it
 * to absolute https URLs (or a path that starts with `/`) so an operator
 * cannot accidentally — or maliciously — inject a `javascript:` URL into
 * a docs HTML page that may be served over the admin auth gate.
 */
function safeCdnBase(value: string | undefined): string {
  const v = value ?? DEFAULT_CDN
  if (v.startsWith('/')) return v
  if (/^https:\/\/[a-zA-Z0-9.-]+\//.test(v)) return v
  return DEFAULT_CDN
}

export function renderSwaggerHtml(specUrl: string, options: SwaggerOptions = {}): string {
  const cdn = htmlEscape(safeCdnBase(options.cdnBase))
  const title = htmlEscape(options.title ?? 'Lasagna Multitenancy Admin API')
  // `specUrl` ends up both in HTML attribute context and inside a JS
  // string literal. HTML-escape covers both — single quotes become
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
