// Env / secret scoping check: is the service-role key confined to the server, and can it be found anywhere it
// shouldn't be? Run with `npm run check:env` (loads web/.env.local). It never prints a secret, only whether one was
// found and where.
//
// The two Supabase keys have very different reach:
//   anon / publishable  is meant to ship to browsers; RLS is what limits it.
//   service role        bypasses RLS entirely. It must exist only in server-side code and the server environment.
//
// Where a secret can leak, and what is checked for each:
//   1. what git tracks          .env.local untracked + ignored; the one tracked env file holds no secret
//   2. git history              the key's value / a service-key pattern was never committed, on any branch
//   3. client source            src/ never reads a service-role variable; no VITE_-prefixed name suggests a secret
//   4. local build output       dist/ (app + widget) contains no service-key value
//   5. the DEPLOYED bundles     the same scan against the live app and widget.js
//   6. Vercel variables         the service key is not exposed to the browser under a VITE_ name
//   7. the API's responses      error paths don't echo key material
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const WEB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const ROOT = path.resolve(WEB, '..')
const DEPLOYED = process.env.DEPLOYED_URL ?? 'https://frontdesk-sigma-mocha.vercel.app'
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY
const ANON = process.env.VITE_SUPABASE_ANON_KEY
if (!SERVICE || !ANON) throw new Error('Needs SUPABASE_SERVICE_ROLE_KEY and VITE_SUPABASE_ANON_KEY (run via `npm run check:env`).')

let pass = 0
let fail = 0
const check = (label, ok, detail) => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}: ${label}${!ok && detail ? ` — ${detail}` : ''}`)
  if (ok) pass++
  else fail++
}
const git = (...args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 }).trim()

/** Shapes a service credential takes: the new `sb_secret_…` keys, or a legacy JWT whose payload says service_role. */
const SERVICE_SHAPE = /sb_secret_[A-Za-z0-9_-]{16,}/
function jwtRole(token) {
  try {
    return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()).role
  } catch {
    return null
  }
}
/** Scans text for the service key's exact value, a service-key-shaped token, or a JWT with role=service_role. */
function findServiceKey(text) {
  if (text.includes(SERVICE)) return 'the exact service-role key value'
  if (SERVICE_SHAPE.test(text)) return 'a token shaped like a service key (sb_secret_…)'
  for (const jwt of text.match(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g) ?? []) {
    if (jwtRole(jwt) === 'service_role') return 'a JWT whose role is service_role'
  }
  return null
}
function* walk(dir) {
  if (!fs.existsSync(dir)) return
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) yield* walk(p)
    else yield p
  }
}

console.log('\n[0] The keys themselves')
check('the "anon" key really is the low-privilege one (publishable, or a JWT with role=anon)', ANON.startsWith('sb_publishable_') || jwtRole(ANON) === 'anon', 'VITE_SUPABASE_ANON_KEY looks like a privileged key')
check('the service key is a different value from the anon key', SERVICE !== ANON)

// Positive control: every "nothing found" below is only meaningful if the scanner can find something.
const fakeJwt = (role) => `eyJhbGciOiJIUzI1NiJ9.${Buffer.from(JSON.stringify({ role })).toString('base64url')}.c2lnbmF0dXJlLXBhZGRpbmc`
check(
  'scanner self-test: finds the real key, an sb_secret_ token and a service_role JWT; ignores an anon JWT and plain text',
  !!findServiceKey(`const k = "${SERVICE}"`) && !!findServiceKey(`x sb_secret_${'a'.repeat(30)} y`) && !!findServiceKey(`t=${fakeJwt('service_role')}`) && !findServiceKey(`t=${fakeJwt('anon')}`) && !findServiceKey('nothing to see'),
)

console.log('\n[1] What git tracks')
const tracked = git('ls-files').split('\n')
const trackedEnv = tracked.filter((f) => /(^|\/)\.env(\.|$)/.test(f))
check('no .env.local (or any secret-bearing env file) is tracked', !trackedEnv.some((f) => f.endsWith('.env.local') || f.endsWith('.env.production.local')), trackedEnv.join(', '))
for (const f of trackedEnv) {
  const found = findServiceKey(fs.readFileSync(path.join(ROOT, f), 'utf8'))
  check(`tracked ${f} contains no service credential`, !found, found ?? '')
}
try {
  git('check-ignore', '-q', 'web/.env.local')
  check('web/.env.local is git-ignored (a new checkout cannot commit it by accident)', true)
} catch {
  check('web/.env.local is git-ignored', false)
}
const trackedScan = []
for (const f of tracked) {
  if (/\.(png|jpg|ico|woff2?|lock)$|package-lock/.test(f)) continue
  try {
    const found = findServiceKey(fs.readFileSync(path.join(ROOT, f), 'utf8'))
    if (found) trackedScan.push(`${f}: ${found}`)
  } catch {
    /* deleted in the working tree */
  }
}
check('no tracked file anywhere in the repo contains a service credential', trackedScan.length === 0, trackedScan.join('; '))

console.log('\n[2] Git history (every commit, every branch)')
const exact = git('log', '--all', '--oneline', `-S${SERVICE}`)
check('the service key\'s exact value was never committed', exact === '', `in: ${exact.split('\n')[0]}`)
const shaped = git('log', '--all', '--oneline', '-G', 'sb_secret_[A-Za-z0-9_-]{16,}')
check('no service-key-shaped token (sb_secret_…) was ever committed', shaped === '', `in: ${shaped.split('\n')[0]}`)
const envEver = git('log', '--all', '--oneline', '--diff-filter=A', '--', '**/.env.local', '.env.local', 'web/.env.local')
check('.env.local was never added to the repository', envEver === '', envEver.split('\n')[0])

console.log('\n[3] Client source')
const srcHits = []
for (const f of walk(path.join(WEB, 'src'))) {
  if (!/\.(ts|tsx|js|jsx)$/.test(f)) continue
  const text = fs.readFileSync(f, 'utf8')
  if (/SERVICE_ROLE|service_role|sb_secret_/.test(text.replace(/\/\/.*|\/\*[\s\S]*?\*\//g, ''))) srcHits.push(path.relative(WEB, f))
}
check('nothing under src/ (the browser bundle\'s source) references a service-role variable', srcHits.length === 0, srcHits.join(', '))
const viteNames = new Set()
for (const f of [...walk(path.join(WEB, 'src')), ...walk(path.join(WEB, 'server')), ...walk(path.join(WEB, 'api'))]) {
  for (const m of fs.readFileSync(f, 'utf8').matchAll(/VITE_[A-Z0-9_]+/g)) viteNames.add(m[0])
}
const suspicious = [...viteNames].filter((n) => /SECRET|SERVICE|PRIVATE|PASSWORD|TOKEN/.test(n))
check(`no VITE_-prefixed variable (which Vite inlines into the public bundle) is named like a secret [${[...viteNames].sort().join(', ')}]`, suspicious.length === 0, suspicious.join(', '))
const serverFiles = [...walk(path.join(WEB, 'server')), ...walk(path.join(WEB, 'api'))].filter((f) => /\.ts$/.test(f))
const serviceReaders = serverFiles.filter((f) => /SUPABASE_SERVICE_ROLE_KEY/.test(fs.readFileSync(f, 'utf8'))).map((f) => path.relative(WEB, f).replace(/\\/g, '/'))
check('the service key is read in exactly one server-side place (server/supabaseAdmin.ts)', serviceReaders.length === 1 && serviceReaders[0] === 'server/supabaseAdmin.ts', serviceReaders.join(', '))

console.log('\n[4] Local build output')
const dist = path.join(WEB, 'dist')
if (fs.existsSync(dist)) {
  const bad = []
  let scanned = 0
  for (const f of walk(dist)) {
    if (!/\.(js|css|html|map)$/.test(f)) continue
    scanned++
    const found = findServiceKey(fs.readFileSync(f, 'utf8'))
    if (found) bad.push(`${path.relative(WEB, f)}: ${found}`)
  }
  check(`no service credential in any of the ${scanned} built files (app + widget)`, bad.length === 0, bad.join('; '))
  const widget = fs.existsSync(path.join(dist, 'widget.js')) ? fs.readFileSync(path.join(dist, 'widget.js'), 'utf8') : ''
  check('the widget bundle carries the anon key (it must, to talk to Supabase) and nothing stronger', widget.includes(ANON) && !findServiceKey(widget))
} else {
  console.log('  (skipped: no dist/ — run `npm run build` first)')
}

console.log(`\n[5] The DEPLOYED bundles (${DEPLOYED})`)
try {
  const html = await (await fetch(`${DEPLOYED}/agent`)).text()
  const assets = [...new Set([...html.matchAll(/(?:src|href)="(\/assets\/[^"]+\.(?:js|css))"/g)].map((m) => m[1]))]
  const urls = [...assets.map((a) => DEPLOYED + a), `${DEPLOYED}/widget.js`]
  const bad = []
  let bytes = 0
  for (const u of urls) {
    const text = await (await fetch(u)).text()
    bytes += text.length
    const found = findServiceKey(text)
    if (found) bad.push(`${u.replace(DEPLOYED, '')}: ${found}`)
  }
  check(`no service credential in the ${urls.length} live files served to a browser (${Math.round(bytes / 1024)} KB, incl. widget.js)`, bad.length === 0, bad.join('; '))
  const widgetText = await (await fetch(`${DEPLOYED}/widget.js`)).text()
  check('the live widget carries the anon key only', widgetText.includes(ANON))
} catch (err) {
  check('could fetch the deployment', false, String(err))
}

console.log('\n[6] Vercel environment variables (names and scopes only; values are never read)')
if (!fs.existsSync(path.join(WEB, '.vercel', 'project.json'))) {
  // Not a failure: a fresh clone simply isn't linked to the project (.vercel/ is git-ignored).
  console.log('  (skipped: this checkout is not linked to a Vercel project; run `vercel link` in web/ to include this check)')
} else try {
  const out = execFileSync('npx', ['vercel', 'env', 'ls'], { cwd: WEB, encoding: 'utf8', shell: true, timeout: 60_000, stdio: ["ignore", "pipe", "ignore"] })
  const rows = out.split('\n').map((l) => l.trim().split(/\s{2,}/)).filter((c) => /^[A-Z][A-Z0-9_]+$/.test(c[0]))
  for (const [name, value, type, envs] of rows) console.log(`     ${name.padEnd(28)} ${type.padEnd(8)} ${envs}${name.startsWith('VITE_') ? '' : '   (value ' + value.toLowerCase() + ')'}`)
  const names = rows.map((r) => r[0])
  check('SUPABASE_SERVICE_ROLE_KEY exists as a server variable', names.includes('SUPABASE_SERVICE_ROLE_KEY'))
  check('it has no VITE_-prefixed twin that would inline it into the browser bundle', !names.some((n) => /^VITE_.*(SERVICE|SECRET)/.test(n)))
  const svc = rows.find((r) => r[0] === 'SUPABASE_SERVICE_ROLE_KEY')
  check('it is a Secret-type variable (write-only in the dashboard; its value is never displayed)', svc?.[2] === 'Secret', svc?.[2])
  check('and scoped to Production only, not Preview or Development', svc?.[3] === 'Production', svc?.[3])
  check('the browser-visible VITE_ variables are plain Config (public by design), not Secret', rows.filter((r) => r[0].startsWith('VITE_')).every((r) => r[2] === 'Config'))
} catch (err) {
  check('could list Vercel variables (needs `vercel login`)', false, String(err.message).split('\n')[0])
}

console.log('\n[7] The API does not leak on error paths')
const leaks = []
let probes = 0
for (const [name, init] of [
  ['GET (wrong method)', { method: 'GET' }],
  ['POST with an invalid id', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"conversationId":"not-a-uuid"}' }],
  ['POST with an empty body', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }],
]) {
  for (const fn of ['route-conversation', 'agent-online', 'reap-disconnected']) {
    const res = await fetch(`${DEPLOYED}/api/${fn}`, init)
    const text = await res.text()
    probes++
    if (findServiceKey(text) || /at .*\.(ts|js):\d+|node_modules|stack/i.test(text)) leaks.push(`${fn} / ${name} -> ${res.status}: ${text.slice(0, 100)}`)
  }
}
check(`none of ${probes} error-path probes echoed a credential or a stack trace`, leaks.length === 0, leaks.join(' | '))

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
