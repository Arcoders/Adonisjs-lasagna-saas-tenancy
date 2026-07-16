/**
 * Minimal stub of the AdonisJS `HttpRequest` surface the resolvers read
 * (`header`, `hostname`, `url`, `qs`, `input`). Lets the resolution tier run
 * with zero HTTP machinery.
 */
export function fakeRequest(
  opts: {
    headers?: Record<string, string>
    hostname?: string
    url?: string
    qs?: Record<string, string>
  } = {}
): any {
  const headers = opts.headers ?? {}
  return {
    header: (key: string) => headers[key] ?? headers[key.toLowerCase()],
    hostname: () => opts.hostname ?? 'acme.localhost',
    url: (_withQs?: boolean) => opts.url ?? '/acme/resource',
    qs: () => opts.qs ?? {},
    input: (key: string) => opts.qs?.[key],
  }
}
