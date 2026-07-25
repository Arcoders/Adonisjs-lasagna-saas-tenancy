/**
 * Thin JSON fetch wrapper for the REST surfaces the consoles read.
 *
 * The browser consoles talk to the very same endpoints the programmatic API and
 * e2e suite drive — the operator console to the admin satellite under `/admin`,
 * the company console to the tenant-guarded domain API. Auth rides on the
 * session cookie (same origin), so no bearer is attached here; the server
 * accepts either a `web-*` session or a token on these routes.
 */

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string | null,
    message: string
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    credentials: 'same-origin',
    headers: {
      'Accept': 'application/json',
      'X-Requested-With': 'XMLHttpRequest',
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })

  const text = await res.text()
  const payload = text ? safeJson(text) : null

  if (!res.ok) {
    const code = (payload && (payload.code || payload.error)) || null
    const message =
      (payload && (payload.message || payload.error)) || `Request failed (${res.status})`
    throw new ApiError(res.status, code, message)
  }

  return payload as T
}

function safeJson(text: string): any {
  try {
    return JSON.parse(text)
  } catch {
    return { message: text }
  }
}

export const api = {
  get: <T>(url: string) => request<T>('GET', url),
  post: <T>(url: string, body?: unknown) => request<T>('POST', url, body),
  put: <T>(url: string, body?: unknown) => request<T>('PUT', url, body),
  del: <T>(url: string) => request<T>('DELETE', url),
}
