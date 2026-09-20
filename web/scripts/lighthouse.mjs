// Lighthouse over the two things a visitor first meets: the app's pages, and a third-party page that embeds the widget.
//
//   npm run lighthouse                       the deployed app (production build) + the local widget host page
//   APP=http://localhost:4173 npm run lighthouse   another target (e.g. `vite preview` of a local build)
//
// Each URL is audited twice, mobile (Lighthouse's default: emulated Moto G, slow-4G throttling) and desktop. Full
// reports (HTML + JSON) go to lighthouse-reports/ (git-ignored). Uses Playwright's Chromium, so nothing depends on
// which Chrome the machine happens to have.
//
// Loading the customer page (/) creates a conversation by design (the standalone page makes one on load), so this
// removes what it created afterwards. The widget host page does not: the widget only creates one on a first message.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import lighthouse from 'lighthouse'
import desktopConfig from 'lighthouse/core/config/desktop-config.js'
import * as chromeLauncher from 'chrome-launcher'
import { chromium } from 'playwright'
import { createClient } from '@supabase/supabase-js'

const WEB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const OUT = path.join(WEB, 'lighthouse-reports')
const APP = process.env.APP ?? 'https://frontdesk-sigma-mocha.vercel.app'
const HOST = process.env.HOST ?? 'http://localhost:5180'
fs.mkdirSync(OUT, { recursive: true })

const TARGETS = [
  { name: 'customer-page', url: `${APP}/` },
  { name: 'agent-console', url: `${APP}/agent` },
  { name: 'widget-host-page', url: `${HOST}/` },
]

const started = Date.now()
const chrome = await chromeLauncher.launch({ chromePath: chromium.executablePath(), chromeFlags: ['--headless=new', '--no-sandbox'] })
const rows = []
try {
  for (const target of TARGETS) {
    for (const form of ['mobile', 'desktop']) {
      const run = await lighthouse(
        target.url,
        { port: chrome.port, output: ['html', 'json'], logLevel: 'error', onlyCategories: ['performance', 'accessibility', 'best-practices', 'seo'] },
        form === 'desktop' ? desktopConfig : undefined,
      )
      const { lhr, report } = run
      const base = `${target.name}.${form}`
      fs.writeFileSync(path.join(OUT, `${base}.html`), report[0])
      fs.writeFileSync(path.join(OUT, `${base}.json`), report[1])
      const score = (id) => Math.round((lhr.categories[id]?.score ?? 0) * 100)
      const audit = (id) => lhr.audits[id]
      rows.push({
        page: target.name,
        form,
        perf: score('performance'),
        a11y: score('accessibility'),
        bp: score('best-practices'),
        seo: score('seo'),
        fcp: audit('first-contentful-paint').displayValue,
        lcp: audit('largest-contentful-paint').displayValue,
        tbt: audit('total-blocking-time').displayValue,
        cls: audit('cumulative-layout-shift').displayValue,
        kb: Math.round((audit('total-byte-weight').numericValue ?? 0) / 1024),
        // What is actually costing points, so the number can be acted on rather than just reported.
        failing: Object.values(lhr.audits)
          .filter((a) => a.score !== null && a.score < 0.9 && a.scoreDisplayMode !== 'informative' && a.scoreDisplayMode !== 'notApplicable' && a.scoreDisplayMode !== 'manual')
          .map((a) => `${a.id} (${a.score})`),
        runWarnings: lhr.runWarnings,
      })
      console.log(`  ${target.name.padEnd(17)} ${form.padEnd(8)} perf ${score('performance')}  a11y ${score('accessibility')}  best-practices ${score('best-practices')}  seo ${score('seo')}`)
    }
  }
} finally {
  // chrome-launcher can fail to delete its temp profile on Windows (EPERM). That must not skip the cleanup below.
  try {
    await chrome.kill()
  } catch (err) {
    console.warn('(chrome temp profile not removed:', err.code ?? err.message, ')')
  }
  // Remove the conversation(s) the customer page created while being audited.
  const url = process.env.VITE_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) {
    console.error('\n!! could not clean up: no Supabase credentials in the environment (run via `npm run lighthouse`). The customer page creates a conversation on load, so conversations named "Customer" may have been left behind.')
    process.exitCode = 1
  } else {
    const admin = createClient(url, key, { auth: { persistSession: false } })
    const { data } = await admin.from('conversations').delete().eq('customer_name', 'Customer').gte('created_at', new Date(started - 5_000).toISOString()).select('id')
    console.log(`\ncleaned up ${data?.length ?? 0} conversation(s) created by loading the customer page`)
  }
}

console.log('\npage               form     perf a11y  bp  seo   FCP     LCP     TBT      CLS    transfer')
for (const r of rows) console.log(`${r.page.padEnd(18)} ${r.form.padEnd(8)} ${String(r.perf).padStart(4)} ${String(r.a11y).padStart(4)} ${String(r.bp).padStart(3)} ${String(r.seo).padStart(4)}   ${r.fcp.padEnd(7)} ${r.lcp.padEnd(7)} ${r.tbt.padEnd(8)} ${r.cls.padEnd(6)} ${r.kb} KB`)
console.log('\nwhat is costing points (audits under 0.9):')
for (const r of rows) if (r.failing.length) console.log(`  ${r.page} / ${r.form}: ${r.failing.join(', ')}`)
fs.writeFileSync(path.join(OUT, 'summary.json'), JSON.stringify(rows, null, 2))
console.log(`\nreports: ${path.relative(process.cwd(), OUT)}`)
