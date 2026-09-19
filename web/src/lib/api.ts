/**
 * POSTs JSON to one of web/api/*. `apiBase` is empty for the same-origin app
 * (Vite proxies /api locally, Vercel serves it in production) and an absolute
 * origin for the embeddable widget, which runs on a third-party host page.
 */
export async function postJson<T = unknown>(
  path: string,
  body: unknown,
  apiBase = '',
): Promise<T> {
  const res = await fetch(`${apiBase}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  return (await res.json()) as T
}
