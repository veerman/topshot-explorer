import { defineConfig } from 'vite'
import preact from '@preact/preset-vite'
import { readFileSync, readdirSync, existsSync, statSync, createReadStream } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { lookupUser } from './deploy/cloudflare/lookup.js'
import {
  makeChallenge, verifySignIn, makeSession, readSession, cookieValue, sessionCookie, clearedCookie, sessionMayLookup, SESSION_COOKIE
} from './deploy/cloudflare/auth.js'
import { WALL_SCHEMA, signWall, wallEntryFor, wallPending } from './deploy/cloudflare/wall.js'
import { fetchAccountGraph, wallKindOf, WALL_NOT_ELIGIBLE } from './deploy/cloudflare/graph.js'

// Wallet sign-in in dev: the same auth.js the Worker runs, with a dev
// secret unless SESSION_SECRET is set. Cookies are not Secure on http.
const DEV_SESSION_SECRET = (globalThis.process && globalThis.process.env.SESSION_SECRET) || 'dev-session-secret'
const readJsonBody = (req) => new Promise((resolve) => {
  let raw = ''
  req.on('data', (c) => { raw += c })
  req.on('end', () => { try { resolve(JSON.parse(raw || 'null')) } catch { resolve(null) } })
})
const devSession = (req) => readSession(DEV_SESSION_SECRET, cookieValue(req.headers.cookie, SESSION_COOKIE))

// The Early Adopters wall in dev: same wall.js as the Worker over a local
// SQLite file (scratch/wall-dev.sqlite), wrapped to D1's prepare/bind shape
const serveWall = () => ({
  name: 'serve-wall',
  configureServer(server) {
    let db = null
    const open = async () => {
      if (db) return db
      const { DatabaseSync } = await import('node:sqlite')
      const raw = new DatabaseSync(fileURLToPath(new URL('./scratch/wall-dev.sqlite', import.meta.url)))
      raw.exec(WALL_SCHEMA)
      try { raw.exec('ALTER TABLE wall ADD COLUMN kind TEXT') } catch { /* already there */ }
      db = {
        prepare: (sql) => ({
          bind: (...args) => {
            const st = raw.prepare(sql)
            return {
              first: async () => st.get(...args) ?? null,
              all: async () => ({ results: st.all(...args) }),
              run: async () => st.run(...args),
            }
          },
        }),
      }
      return db
    }
    const nameOf = async (address) => {
      const file = fileURLToPath(new URL('./scratch/census/census.sqlite', import.meta.url))
      if (!existsSync(file)) return null
      const { DatabaseSync } = await import('node:sqlite')
      const c = new DatabaseSync(file, { readOnly: true })
      const row = c.prepare('SELECT username FROM names WHERE address = ?').get(address.replace(/^0x/, ''))
      c.close()
      return (row && row.username) || null
    }
    server.middlewares.use('/wall', async (req, res) => {
      const path = (req.url || '/').split('?')[0]
      const params = new URL(req.url || '/', 'http://localhost').searchParams
      const json = (status, body) => {
        res.statusCode = status
        res.setHeader('content-type', 'application/json')
        res.setHeader('cache-control', 'no-store')
        res.end(JSON.stringify(body))
      }
      const d = await open()
      if (path === '/pending' && req.method === 'GET') return json(200, await wallPending(d, Number(params.get('after')) || 0))
      const session = await devSession(req)
      if (!session) return json(401, { error: 'sign in with a Flow wallet first' })
      if (path === '/me' && req.method === 'GET') {
        const entry = await wallEntryFor(d, session.address)
        return entry ? json(200, entry) : json(404, { error: 'not signed yet' })
      }
      if (path === '/sign' && req.method === 'POST') {
        const body = (await readJsonBody(req)) || {}
        const graph = await fetchAccountGraph('https://rest-mainnet.onflow.org', session.address)
        const kind = wallKindOf(graph)
        if (!kind) return json(403, { error: WALL_NOT_ELIGIBLE })
        const dapperChildren = graph.children.filter((c) => c.dapper).map((c) => c.address)
        let username = await nameOf(session.address)
        if (!username && kind === 'parent') for (const c of dapperChildren) { username = await nameOf(c); if (username) break }
        let height = null
        try { const j = await (await fetch('https://rest-mainnet.onflow.org/v1/blocks?height=sealed')).json(); height = Number(j[0]?.header?.height) || null } catch { /* no height */ }
        const facts = { kind, username, dapper: graph.dapper, parents: graph.parents.map((p) => p.address), children: dapperChildren }
        return json(200, await signWall(d, session.address, body.showName !== false, facts, height))
      }
      json(404, { error: 'no such route' })
    })
  },
})

const serveAuth = () => ({
  name: 'serve-auth',
  configureServer(server) {
    server.middlewares.use('/auth', async (req, res) => {
      const path = (req.url || '/').split('?')[0]
      const params = new URL(req.url || '/', 'http://localhost').searchParams
      const json = (status, body, headers = {}) => {
        res.statusCode = status
        res.setHeader('content-type', 'application/json')
        res.setHeader('cache-control', 'no-store')
        for (const [k, v] of Object.entries(headers)) res.setHeader(k, v)
        res.end(JSON.stringify(body))
      }
      if (path === '/challenge' && req.method === 'GET') {
        const ch = await makeChallenge(DEV_SESSION_SECRET, params.get('address'), req.headers.host || 'localhost')
        return ch ? json(200, ch) : json(400, { error: 'not a Flow address' })
      }
      if (path === '/verify' && req.method === 'POST') {
        const body = await readJsonBody(req)
        const result = await verifySignIn(DEV_SESSION_SECRET, 'https://rest-mainnet.onflow.org', req.headers.host || 'localhost', body)
        if (!result.ok) return json(401, { error: result.error })
        const token = await makeSession(DEV_SESSION_SECRET, result.address, '')
        return json(200, { address: result.address }, { 'set-cookie': sessionCookie(token, false) })
      }
      if (path === '/signout' && req.method === 'POST') return json(200, { ok: true }, { 'set-cookie': clearedCookie(false) })
      if (path === '/me' && req.method === 'GET') {
        const session = await devSession(req)
        return session ? json(200, { address: session.address }) : json(401, { error: 'not signed in' })
      }
      json(404, { error: 'no such route' })
    })
  },
})

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf-8'))

// Content hash per seed file, baked into the bundle as a ?v= cache
// buster: /seed/* can then be cached as immutable, and a deploy that
// leaves a seed unchanged leaves the visitor's cached copy valid
const seedVersion = (file) => {
  try {
    return createHash('md5').update(readFileSync(new URL(`./public/seed/${file}`, import.meta.url))).digest('hex').slice(0, 10)
  } catch {
    return '0'
  }
}

// Dev-only bridge to the gitignored assets/ tree (outputs derived from the
// recipes; never shipped). The experimental /assets page lists them via the
// synthesized manifest and loads the files straight from disk. A deployed
// build has no assets/ and the page reports that instead.
const serveDerivedAssets = () => {
  const root = fileURLToPath(new URL('./assets', import.meta.url))
  const list = (dir) => {
    try { return readdirSync(join(root, dir)).filter((f) => /\.(png|jpg)$/i.test(f)) } catch { return [] }
  }
  return {
    name: 'serve-derived-assets',
    configureServer(server) {
      server.middlewares.use('/assets', (req, res, next) => {
        const url = decodeURIComponent((req.url || '/').split('?')[0])
        if (url === '/manifest.json') {
          // Same shape media-sync.mjs uploads to the bucket: setArt maps
          // each set to its cover square (files[0] in the extractor index)
          const setArt = {}
          try {
            const index = JSON.parse(readFileSync(join(root, 'sets', 'index.json'), 'utf-8'))
            for (const [setID, entry] of Object.entries(index.sets || {})) {
              if (entry?.files?.[0]?.file) setArt[setID] = entry.files[0].file
            }
          } catch { /* no set art generated on this machine */ }
          res.setHeader('content-type', 'application/json')
          res.end(JSON.stringify({
            teams: { nba: list('logos/teams/nba'), wnba: list('logos/teams/wnba') },
            badges: list('logos/badges'),
            setArt,
          }))
          return
        }
        const file = join(root, url)
        if (!file.startsWith(root) || !existsSync(file) || !statSync(file).isFile()) return next()
        res.setHeader('content-type', file.endsWith('.png') ? 'image/png' : file.endsWith('.jpg') ? 'image/jpeg' : 'application/octet-stream')
        createReadStream(file).pipe(res)
      })
    },
  }
}

// Dev-only twin of the Worker's GET /lookup/user/<name> (deploy/cloudflare/
// lookup.js): the navbar box resolves a Top Shot username to its address
// on localhost the same way it does on the hosted site, minus the cache.
// Dev-only twin of GET /lookup/address/<addr> (worker.js lookupAddress):
// answers from the private census database when it is on this machine
// (scratch/census/census.sqlite), 404 otherwise, so the pages that name
// addresses behave on localhost as they do on the hosted site.
const serveAddressLookup = () => ({
  name: 'serve-address-lookup',
  configureServer(server) {
    const file = fileURLToPath(new URL('./scratch/census/census.sqlite', import.meta.url))
    let db = null
    const open = async () => {
      if (db || !existsSync(file)) return db
      const { DatabaseSync } = await import('node:sqlite')
      db = new DatabaseSync(file, { readOnly: true })
      return db
    }
    server.middlewares.use('/lookup/address', async (req, res) => {
      const raw = decodeURIComponent((req.url || '/').slice(1).split('?')[0]).trim().toLowerCase().replace(/^0x/, '')
      res.setHeader('content-type', 'application/json')
      res.setHeader('cache-control', 'no-store')
      // Same gate as the Worker: names are for signed-in readers
      if (!sessionMayLookup(await devSession(req))) { res.statusCode = 401; res.end(JSON.stringify({ error: 'sign in with a Flow wallet to see usernames' })); return }
      const d = /^[0-9a-f]{16}$/.test(raw) ? await open() : null
      if (!d) { res.statusCode = 404; res.end(JSON.stringify({ address: `0x${raw}` })); return }
      const row = d.prepare('SELECT g.dapper, g.parents, g.children, g.checked_at, n.username FROM accounts a LEFT JOIN graph g ON g.address = a.address LEFT JOIN names n ON n.address = a.address WHERE a.address = ?').get(raw)
      if (!row) { res.statusCode = 404; res.end(JSON.stringify({ address: `0x${raw}` })); return }
      const list = (x) => { try { return JSON.parse(x || '[]') } catch { return [] } }
      const named = (addrs) => addrs.map((x) => ({ address: `0x${x}`, username: (d.prepare('SELECT username FROM names WHERE address = ?').get(x) || {}).username || null }))
      res.end(JSON.stringify({ address: `0x${raw}`, username: row.username || null, dapper: row.dapper === null ? null : Boolean(row.dapper), parents: named(list(row.parents)), children: named(list(row.children)), checkedAt: row.checked_at || null }))
    })
  },
})

const serveUserLookup = () => ({
  name: 'serve-user-lookup',
  configureServer(server) {
    server.middlewares.use('/lookup/user', async (req, res) => {
      const name = decodeURIComponent((req.url || '/').slice(1).split('?')[0])
      const { status, body } = await lookupUser(name)
      res.statusCode = status
      res.setHeader('content-type', 'application/json')
      res.setHeader('cache-control', 'no-store')
      res.end(JSON.stringify(body))
    })
  },
})

// The app runs on Preact. The preset aliases react / react-dom imports to
// preact/compat, so react-router-dom and existing "react" imports work
// unchanged while no React code ships. The react/react-dom entries in
// package.json exist only to satisfy peer dependencies.
// https://vite.dev/config/
export default defineConfig({
  // devToolsEnabled: false drops preact/debug's per-vnode bookkeeping in
  // dev, which multiplies badly on 9k-row tables (Preact DevTools browser
  // extension integration goes with it; HMR is unaffected)
  plugins: [preact({ devToolsEnabled: false }), serveDerivedAssets(), serveUserLookup(), serveAddressLookup(), serveAuth(), serveWall()],
  // Imported JSON ships as a JSON.parse(string) rather than a JS object
  // literal: the JSON parser is several times faster than the JS parser
  // for the ~1.6MB of data files in the bundle
  json: { stringify: true },
  server: {
    fs: {
      // mediacube is a file: dependency vendored under packages/; npm links
      // it into node_modules, and the real path is inside the repo
      allow: ['.', fileURLToPath(new URL('./packages/mediacube', import.meta.url))],
    },
    watch: {
      // Generated/working trees hold no importable modules, and some get
      // written in bulk while the dev server runs (media-derive.mjs pours
      // ~18k thumbnails into assets/, builds rewrite dist/): watching them
      // drowns the event loop and wedges the server. The /assets
      // middleware reads from disk per request, so it needs no watcher.
      ignored: ['./assets/**', './ipfs_cache/**', './scratch/**', './dist/**'].map(
        (p) => fileURLToPath(new URL(p.slice(0, -3), import.meta.url)).replace(/\\/g, '/') + '/**'
      ),
    },
  },
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __BUILD_DATE__: JSON.stringify(new Date().toISOString().slice(0, 10)),
    __SEED_VERSION__: JSON.stringify(seedVersion('topshot-seed.json')),
    __OFFERS_VERSION__: JSON.stringify(seedVersion('topshot-offers.json')),
  },
})
