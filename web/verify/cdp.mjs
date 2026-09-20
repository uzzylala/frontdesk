// Minimal raw CDP client (no Playwright): nothing between us and Chrome's real visibility state.
export async function cdpConnect(wsUrl) {
  const ws = new WebSocket(wsUrl)
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
  let id = 0; const pending = new Map()
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { const {res, rej} = pending.get(m.id); pending.delete(m.id); if (m.error) rej(new Error(m.error.message))
    else res(m.result) } }
  return {
    send: (method, params = {}) => new Promise((res, rej) => { const i = ++id; pending.set(i, {res, rej}); ws.send(JSON.stringify({id: i, method, params})) }),
    eval: async function (expr) { const r = await this.send('Runtime.evaluate', {expression: expr, returnByValue: true, awaitPromise: true}); return r.result.value },
    close: () => ws.close(),
  }
}
