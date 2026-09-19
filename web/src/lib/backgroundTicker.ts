/**
 * `setInterval` that keeps its cadence in a background tab. The clock runs in
 * a Web Worker (see workers/ticker.worker.ts); each tick is delivered to
 * `onTick` on the main thread, where the real work (a fetch, a state update)
 * still happens.
 *
 * If a worker can't be created or dies (unsupported, blocked by a
 * Content-Security-Policy) this degrades to a plain `setInterval`: correct in
 * a foreground tab, just throttled in the background. Returns a stop function.
 */
export function startTicker(intervalMs: number, onTick: () => void): () => void {
  let worker: Worker | undefined
  let fallback: ReturnType<typeof setInterval> | undefined

  const fallBackToTimer = () => {
    worker?.terminate()
    worker = undefined
    fallback ??= setInterval(onTick, intervalMs)
  }

  try {
    worker = new Worker(new URL('../workers/ticker.worker.ts', import.meta.url), {
      type: 'module',
    })
    worker.onmessage = onTick
    worker.onerror = fallBackToTimer
    worker.postMessage({ type: 'start', intervalMs })
  } catch {
    fallBackToTimer()
  }

  return () => {
    worker?.terminate()
    worker = undefined
    clearInterval(fallback)
  }
}
