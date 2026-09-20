import { chromium } from 'playwright'
import { admin, APP, HOST as HOST_ORIGIN, SHOTS, cleanup } from '../lib.mjs'

const HOST = `${HOST_ORIGIN}/`

let pass = 0
let fail = 0
function check(label, ok, detail) {
  if (ok) { console.log(`  PASS: ${label}`); pass++ }
  else { console.log(`  FAIL: ${label}${detail !== undefined ? ` — ${detail}` : ''}`); fail++ }
}

// Everything about the host page that host CSS controls and the widget must not disturb.
const HOST_SELECTORS = ['header', 'h1', 'h2', 'p', '#host-buy', '#host-email', 'ul', '#products', '.card', '#about']
const PROPS = ['fontFamily', 'fontSize', 'color', 'backgroundColor', 'borderTopWidth', 'borderTopStyle',
  'borderLeftWidth', 'marginTop', 'marginBottom', 'paddingTop', 'lineHeight', 'letterSpacing',
  'textTransform', 'textDecorationLine', 'display', 'position', 'boxSizing']

async function snapshot(page) {
  return page.evaluate(({ selectors, props }) => {
    const styles = {}
    const rects = {}
    for (const sel of selectors) {
      const el = document.querySelector(sel)
      const cs = getComputedStyle(el)
      styles[sel] = Object.fromEntries(props.map((p) => [p, cs[p]]))
      const r = el.getBoundingClientRect()
      rects[sel] = [r.x, r.y, r.width, r.height].map((n) => Math.round(n * 100) / 100)
    }
    return {
      styles, rects,
      styleSheets: document.styleSheets.length,
      headChildren: document.head.children.length,
      styleTags: document.querySelectorAll('style').length,
      bodyChildren: document.body.children.length,
      scrollHeight: document.documentElement.scrollHeight,
      htmlFontSize: getComputedStyle(document.documentElement).fontSize,
    }
  }, { selectors: HOST_SELECTORS, props: PROPS })
}

async function main() {
  await cleanup()
  const browser = await chromium.launch()
  const consoleErrors = []

  // ---- Baseline: the SAME page with the widget script blocked. ----
  const baseCtx = await browser.newContext({ viewport: { width: 1200, height: 800 } })
  const basePage = await baseCtx.newPage()
  await basePage.route('**/widget.js', (r) => r.abort())
  await basePage.goto(HOST, { waitUntil: 'load' })
  const baseline = await snapshot(basePage)
  await basePage.screenshot({ path: `${SHOTS}/widget-1-host-baseline.png` })
  await baseCtx.close()

  const convoCountBefore = (await admin.from('conversations').select('id', { count: 'exact', head: true })).count

  // ---- With the widget. ----
  const ctx = await browser.newContext({ viewport: { width: 1200, height: 800 } })
  const page = await ctx.newPage()
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()) })
  page.on('pageerror', (e) => consoleErrors.push(String(e)))
  await page.goto(HOST, { waitUntil: 'load' })
  await page.waitForSelector('frontdesk-widget', { state: 'attached' })
  await page.waitForSelector('frontdesk-widget button[aria-label="Open chat"]')
  const withWidget = await snapshot(page)
  await page.screenshot({ path: `${SHOTS}/widget-2-closed.png` })

  console.log('\n[A1] Widget mounts from a single script tag, in a shadow root')
  check('<frontdesk-widget> exists with an open shadowRoot',
    await page.evaluate(() => !!document.querySelector('frontdesk-widget')?.shadowRoot))
  check('widget styles are inside the shadow root',
    await page.evaluate(() => (document.querySelector('frontdesk-widget').shadowRoot.querySelector('style')?.textContent.length ?? 0) > 1000))
  check('page load alone does not create a conversation (no ghost conversations)',
    (await admin.from('conversations').select('id', { count: 'exact', head: true })).count === convoCountBefore)

  console.log('\n[A2] Isolation OUT: the widget does not disturb the host page')
  check('no stylesheet added to the document', withWidget.styleSheets === baseline.styleSheets, `${baseline.styleSheets} -> ${withWidget.styleSheets}`)
  check('no <style>/<link> added to document.head', withWidget.headChildren === baseline.headChildren && withWidget.styleTags === baseline.styleTags)
  check('exactly one element added to <body> (the widget host)', withWidget.bodyChildren === baseline.bodyChildren + 1)
  const styleDiffs = HOST_SELECTORS.flatMap((sel) =>
    PROPS.filter((p) => baseline.styles[sel][p] !== withWidget.styles[sel][p]).map((p) => `${sel}.${p}`))
  check(`computed styles of ${HOST_SELECTORS.length} host elements x ${PROPS.length} properties unchanged`, styleDiffs.length === 0, styleDiffs.join(', '))
  const rectDiffs = HOST_SELECTORS.filter((sel) => JSON.stringify(baseline.rects[sel]) !== JSON.stringify(withWidget.rects[sel]))
  check('layout unchanged: every host element keeps its exact position and size', rectDiffs.length === 0, rectDiffs.join(', '))
  check('page height unchanged (widget takes no space in host layout)', withWidget.scrollHeight === baseline.scrollHeight, `${baseline.scrollHeight} -> ${withWidget.scrollHeight}`)
  check('host still looks hostile: its own button is still hotpink',
    withWidget.styles['#host-buy'].backgroundColor === 'rgb(255, 105, 180)', withWidget.styles['#host-buy'].backgroundColor)

  console.log('\n[A3] Isolation IN: the host page CSS does not reach the widget')
  await page.click('frontdesk-widget button[aria-label="Open chat"]')
  await page.waitForSelector('frontdesk-widget input[placeholder="Type a message…"]')
  await page.waitForTimeout(300)
  const inner = await page.evaluate(() => {
    const root = document.querySelector('frontdesk-widget').shadowRoot
    const cs = (el) => getComputedStyle(el)
    const panel = root.querySelector('[role="dialog"]')
    const input = root.querySelector('input')
    const sendBtn = root.querySelector('form button')
    const launcher = root.querySelector('button[aria-label="Close chat"][aria-expanded]')
    const hint = [...root.querySelectorAll('p')].find((p) => p.textContent.includes('say hello'))
    const title = [...root.querySelectorAll('p')].find((p) => p.textContent.includes('Chat with us'))
    const svg = root.querySelector('svg')
    const host = document.querySelector('frontdesk-widget')
    const hr = host.getBoundingClientRect()
    const pr = panel.getBoundingClientRect()
    return {
      panelWidth: Math.round(pr.width), panelHeight: Math.round(pr.height),
      panelBoxShadow: cs(panel).boxShadow, panelBorderStyle: cs(panel).borderTopStyle,
      panelBorderLeftWidth: cs(panel).borderLeftWidth, panelRadius: cs(panel).borderTopLeftRadius,
      inputFont: cs(input).fontFamily, inputSize: cs(input).fontSize, inputBg: cs(input).backgroundColor,
      inputBorderStyle: cs(input).borderTopStyle, inputBorderWidth: cs(input).borderTopWidth,
      sendBg: cs(sendBtn).backgroundColor, sendFont: cs(sendBtn).fontFamily, sendSize: cs(sendBtn).fontSize,
      sendRadius: cs(sendBtn).borderTopLeftRadius, sendBorderStyle: cs(sendBtn).borderTopStyle, sendTransform: cs(sendBtn).textTransform,
      launcherBg: cs(launcher).backgroundColor, launcherBoxShadow: cs(launcher).boxShadow,
      hintStyle: cs(hint).fontStyle, hintDecoration: cs(hint).textDecorationLine, hintColor: cs(hint).color, hintSize: cs(hint).fontSize, hintLetter: cs(hint).letterSpacing,
      titleSize: cs(title).fontSize, titleFont: cs(title).fontFamily,
      svgWidth: Math.round(svg.getBoundingClientRect().width), svgFill: cs(svg).fill,
      hostBox: [hr.width, hr.height], hostPosition: cs(host).position,
      hostBorder: cs(host).borderTopWidth, hostPadding: cs(host).paddingTop, hostMargin: cs(host).marginBottom,
      htmlFontSize: getComputedStyle(document.documentElement).fontSize,
    }
  })
  console.log('   (host <html> font-size is', inner.htmlFontSize + ' — a rem trap)')
  check('rem units: panel is exactly 360x480 despite html { font-size: 28px }', inner.panelWidth === 360 && inner.panelHeight === 480, `${inner.panelWidth}x${inner.panelHeight}`)
  check('text-sm is 14px, not scaled by the host root font-size', inner.hintSize === '14px' && inner.titleSize === '14px', `${inner.hintSize}/${inner.titleSize}`)
  check('host  * { box-sizing: content-box !important } did not apply (width is border-box)', inner.panelWidth === 360)
  check('@property fix: shadow-xl renders (box-shadow not "none")', inner.panelBoxShadow !== 'none', inner.panelBoxShadow.slice(0, 60))
  check('@property fix: launcher shadow-lg renders', inner.launcherBoxShadow !== 'none')
  check('@property fix: border-style is solid (would be none if --tw-border-style were unset)', inner.panelBorderStyle === 'solid' && inner.inputBorderStyle === 'solid', `${inner.panelBorderStyle}/${inner.inputBorderStyle}`)
  check('host input { border: 5px double red !important } did not apply', inner.inputBorderWidth === '1px' && inner.inputBorderStyle === 'solid', `${inner.inputBorderWidth} ${inner.inputBorderStyle}`)
  check('host input { font-size: 30px; yellow bg } did not apply', inner.inputSize === '14px' && inner.inputBg !== 'rgb(255, 255, 0)', `${inner.inputSize} ${inner.inputBg}`)
  check('host button { hotpink !important } did not apply to the widget send button', inner.sendBg !== 'rgb(255, 105, 180)', inner.sendBg)
  check('host button { border-radius:0; dashed border; uppercase; Times !important } did not apply',
    inner.sendRadius !== '0px' && inner.sendBorderStyle !== 'dashed' && inner.sendTransform === 'none' && !/times/i.test(inner.sendFont), `${inner.sendRadius} ${inner.sendBorderStyle} ${inner.sendTransform} ${inner.sendFont}`)
  check('host body font (Comic Sans) did not inherit in', !/comic|chalkboard|cursive/i.test(inner.inputFont) && !/comic|chalkboard/i.test(inner.titleFont), inner.titleFont.slice(0, 50))
  check('host p { italic; underline; teal } did not apply', inner.hintStyle === 'normal' && inner.hintDecoration === 'none' && inner.hintColor !== 'rgb(0, 128, 128)', `${inner.hintStyle} ${inner.hintDecoration} ${inner.hintColor}`)
  check('host body letter-spacing (1.5px) did not inherit in', inner.hintLetter === 'normal', inner.hintLetter)
  check('host div { border-left: 6px solid orange } did not apply', inner.panelBorderLeftWidth === '1px', inner.panelBorderLeftWidth)
  check('host svg { width: 120px; fill: red !important } did not apply', inner.svgWidth === 24 && inner.svgFill !== 'rgb(255, 0, 0)', `${inner.svgWidth}px ${inner.svgFill}`)
  check('host  body > * { padding; margin; border } did not affect the widget host element',
    inner.hostBox[0] === 0 && inner.hostBox[1] === 0 && inner.hostBorder === '0px' && inner.hostPadding === '0px' && inner.hostMargin === '0px', JSON.stringify(inner))
  await page.screenshot({ path: `${SHOTS}/widget-3-open.png` })

  console.log('\n[A4] Widget talks to Supabase on its own (Vite app is not running)')
  check('Vite dev server is down while the widget works',
    await fetch(`${APP}/`).then(() => false, () => true))
  const started = new Date().toISOString()
  const msg = `hello from the widget ${Date.now()}`
  await page.fill('frontdesk-widget input[placeholder="Type a message…"]', msg)
  await page.click('frontdesk-widget form button[type="submit"]')
  await page.waitForSelector(`frontdesk-widget >> text=${msg}`, { timeout: 10000 })
  await page.waitForSelector(`frontdesk-widget >> text=Sending…`, { state: 'detached', timeout: 10000 })
  check('sent message renders in the widget', true)

  const { data: convos } = await admin.from('conversations').select('*').gte('created_at', started).eq('customer_name', 'Demo Visitor')
  check('exactly one conversation created, named from data-customer-name', convos?.length === 1, `n=${convos?.length}`)
  const convo = convos?.[0]
  const { data: dbMsgs } = await admin.from('messages').select('*').eq('conversation_id', convo?.id)
  check('message row landed in the same messages table', dbMsgs?.some((m) => m.body === msg && m.sender_type === 'customer'))
  await page.waitForTimeout(1500)
  const routed = (await admin.from('conversations').select('assigned_agent_id').eq('id', convo.id).single()).data
  check('cross-origin call to the routing API worked (no agent online -> stays queued, no CORS error)', routed.assigned_agent_id === null && !consoleErrors.some((e) => /CORS|blocked/i.test(e)), consoleErrors.join(' | '))

  const reply = `agent reply ${Date.now()}`
  await admin.from('messages').insert({ conversation_id: convo.id, sender_type: 'agent', body: reply })
  await page.waitForSelector(`frontdesk-widget >> text=${reply}`, { timeout: 10000 })
  check('agent reply arrives live via the widget\'s OWN Realtime subscription', true)
  await page.screenshot({ path: `${SHOTS}/widget-4-conversation.png` })

  console.log('\n[A5] Conversation survives a reload')
  await page.reload({ waitUntil: 'load' })
  await page.waitForSelector('frontdesk-widget button[aria-label="Open chat"]')
  await page.click('frontdesk-widget button[aria-label="Open chat"]')
  await page.waitForSelector(`frontdesk-widget >> text=${reply}`, { timeout: 10000 })
  check('history restored from the same conversation after reload', true)
  const { count } = await admin.from('conversations').select('id', { count: 'exact', head: true }).eq('customer_name', 'Demo Visitor')
  check('reload did not create a second conversation', count === 1, `n=${count}`)

  check('no console errors from the widget', consoleErrors.length === 0, consoleErrors.join(' | '))

  await cleanup()
  await browser.close()
  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail === 0 ? 0 : 1)
}

main().catch(async (e) => { console.error('FAILED', e); await cleanup(); process.exit(1) })
