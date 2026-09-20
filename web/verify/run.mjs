// Runs the verification suites one at a time, restoring the shared database between them.
//
//   npm run verify                      every suite in the default set
//   npm run verify -- claim widget      only suites whose name contains "claim" or "widget"
//   npm run verify -- --list            what exists, what each needs, how long it takes
//   npm run verify -- --all             the default set plus the slow/manual ones
//
// Each suite's full output goes to verify/.out/<suite>.log; the console gets its result line. Exits non-zero if
// any suite failed, could not run, or its prerequisites are missing.
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

process.env.VERIFY_RUN_START = String(Date.now()) // lib.mjs uses it to tell this run's leftovers from real data
const { APP, HOST, API, SHOTS, admin, cleanup, assertSafeToRun, sleep } = await import('./lib.mjs')

const HERE = path.dirname(fileURLToPath(import.meta.url))

/**
 * needs: which servers must be up ('app' = Vite on APP, 'host' = the widget demo page, 'api' = the local functions).
 * appDown: the suite proves the widget works without the app, so the app must NOT be running.
 * group: 'default' runs in a normal pass; 'slow' takes many minutes; 'manual' needs a human decision or a deployment.
 */
const SUITES = [
  { name: 'routing-and-queue', needs: ['app', 'api'], group: 'default', mins: 1.5, note: 'run with VITE_ROUTING_TRIGGER=off (see README): with the dev client trigger AND the production webhooks both firing, an Online click pulls twice' },
  { name: 'presence-and-reassignment', needs: ['app', 'api', 'host'], group: 'default', mins: 3.5 },
  { name: 'widget-isolation', needs: ['host', 'api'], appDown: true, group: 'default', mins: 1.5 },
  { name: 'a11y-axe', needs: ['app', 'host'], group: 'default', mins: 1 },
  { name: 'a11y-keyboard', needs: ['app', 'api'], group: 'default', mins: 1.5 },
  { name: 'a11y-announcements', needs: ['app', 'host'], group: 'default', mins: 1.5 },
  { name: 'reconnect-roster', needs: ['app'], group: 'default', mins: 0.5 },
  { name: 'reconnect-missed-work', needs: ['app'], group: 'default', mins: 1 },
  { name: 'widget-first-message', needs: ['host'], group: 'default', mins: 0.5 },
  { name: 'scroll-to-newest', needs: ['app', 'host'], group: 'default', mins: 1.5 },
  { name: 'scroll-restore-position', needs: ['app'], group: 'default', mins: 0.5 },
  { name: 'claim-outcomes', needs: ['app'], group: 'default', mins: 1 },
  { name: 'claim-race-focus-and-tie', needs: ['app', 'api'], group: 'default', mins: 4.5 },
  { name: 'error-recovery', needs: ['app', 'host'], group: 'default', mins: 4.5 },
  { name: 'loading-states', needs: ['app', 'host'], group: 'default', mins: 1 },
  { name: 'lost-webhook-recovery', needs: ['app', 'api'], group: 'default', mins: 1.5 },
  { name: 'pull-vs-sweep', needs: ['api'], group: 'default', mins: 3, note: 'a stress test of a known benign race (an agent occasionally ends with two); asserts only the hard invariants and reports the rate' },
  { name: 'realtime-basic', needs: [], group: 'default', mins: 0.2 },
  { name: 'realtime-multi-channel', needs: [], group: 'default', mins: 0.2 },
  { name: 'claim-race', needs: ['app', 'api'], group: 'slow', mins: 10 },
  { name: 'background-tab', needs: ['app'], group: 'manual', mins: 8, note: 'a hidden real Chrome for minutes; see the file header' },
  { name: 'deployed', needs: ['host'], group: 'manual', mins: 3, note: 'targets a deployment: APP=https://… (needs the demo host page)' },
]

const args = process.argv.slice(2)
if (args.includes('--list')) {
  for (const s of SUITES) console.log(`${s.name.padEnd(28)} ${s.group.padEnd(8)} ~${String(s.mins).padStart(4)} min  needs: ${(s.needs.join(', ') || '-').padEnd(14)}${s.appDown ? ' (app must be DOWN)' : ''}${s.note ? `  — ${s.note}` : ''}`)
  process.exit(0)
}
const filters = args.filter((a) => !a.startsWith('--'))
const all = args.includes('--all')
const selected = SUITES.filter((s) => (filters.length ? filters.some((f) => s.name.includes(f)) : all ? s.group !== 'manual' || all : s.group === 'default'))
if (!selected.length) {
  console.error('No suite matches. Try --list.')
  process.exit(2)
}

const up = async (url) => { try { await fetch(url, { signal: AbortSignal.timeout(4000) }); return true } catch { return false } }
const state = { app: await up(APP), host: await up(HOST), api: await up(`${API}/api/reap-disconnected`) }
console.log(`servers: app ${state.app ? 'up' : 'DOWN'} (${APP}) · widget host ${state.host ? 'up' : 'DOWN'} (${HOST}) · api ${state.api ? 'up' : 'DOWN'} (${API})\n`)

await assertSafeToRun()
const results = []
for (const suite of selected) {
  const missing = suite.needs.filter((n) => !state[n])
  const blocked = suite.appDown && state.app
  if (missing.length || blocked) {
    const why = blocked ? 'the app must be stopped for this suite' : `needs ${missing.join(', ')} running`
    console.log(`SKIP  ${suite.name.padEnd(28)} ${why}`)
    results.push({ suite: suite.name, status: 'skipped', why })
    continue
  }
  await cleanup()
  const log = path.join(SHOTS, `${suite.name}.log`)
  const out = fs.createWriteStream(log)
  const t0 = Date.now()
  const code = await new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(HERE, 'suites', `${suite.name}.mjs`)], { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] })
    const killer = setTimeout(() => child.kill(), Math.max(suite.mins * 3, 5) * 60_000)
    child.stdout.pipe(out, { end: false })
    child.stderr.pipe(out, { end: false })
    child.on('close', (c) => { clearTimeout(killer); resolve(c ?? 1) })
  })
  out.end()
  await cleanup()
  const text = fs.readFileSync(log, 'utf8')
  const tally = [...text.matchAll(/(\d+) passed, (\d+) failed/g)].pop()
  const secs = ((Date.now() - t0) / 1000).toFixed(0)
  const ok = code === 0
  console.log(`${ok ? 'PASS ' : 'FAIL '} ${suite.name.padEnd(28)} ${tally ? `${tally[1]} passed, ${tally[2]} failed` : `exit ${code}`}  (${secs}s)${ok ? '' : `  → ${path.relative(process.cwd(), log)}`}`)
  results.push({ suite: suite.name, status: ok ? 'passed' : 'failed', tally: tally?.[0] })
  await sleep(1000)
}

const failed = results.filter((r) => r.status === 'failed')
const skipped = results.filter((r) => r.status === 'skipped')
console.log(`\n${results.length - failed.length - skipped.length} suite(s) passed, ${failed.length} failed, ${skipped.length} skipped`)
void admin
process.exit(failed.length || skipped.length ? 1 : 0)
