#!/usr/bin/env node
/*
 * cms-sync: compare station-master against each station's live Kotahi CMS files.
 *
 * drift   READ-ONLY: the two CMS read queries Flax itself uses.
 * push    shows diffs, backs up live files, test-builds each station on the
 *         Flax machine with the new files (fly ssh), asks "yes", writes with
 *         updateResource, reads back, then rebuilds (KOTAHI_TOKEN) or tells you
 *         to click Publish. Refuses files hand-edited in a CMS since the last push.
 * verify  page count vs record count + HTTP 200 per station, after a publish.
 * restore pushes files back from a backup folder.
 * Plan: /mnt/project-files/planning/shared-flax-templates-plan.md
 *
 *   node scripts/cms-sync.js drift
 *   node scripts/cms-sync.js push --dry-run
 *   node scripts/cms-sync.js push layouts/_partials/cover.njk --groups wams
 *
 * Options:
 *   --server URL       Kotahi server (default https://iplaces-test-server.fly.dev)
 *   --groups a,b       stations to check (default: manifest "stations")
 *   --master DIR       default station-master/cmsTemplateFiles
 *   --manifest FILE    default station-master/manifest.json (built-in default if absent)
 *   --out DIR          where live copies + drift.md go (default cms-sync-out/<timestamp>)
 *   --diff PATH        also print `diff -u master live` for that file, per station
 *   KOTAHI_TOKEN env   bearer token (group admin); needed for rebuild, maybe for push
 *
 * Node 18+, no dependencies.
 */

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { execFileSync } = require('child_process')

const DEFAULT_MANIFEST = {
  stations: ['gumpstation', 'wams'], // obfs retired 2026-10-19 (deploy script commit 5047af4c2)
  // Never pushed, never compared. `!` re-includes a path as shared.
  stationOwned: [
    'data/station.json',
    'data/issues.json',
    'data/cms*.json',
    'data/site.json',
    'data/articleQuery.json',
    'content/pages/*.njk',
    '!content/pages/browse.njk',
    '!content/pages/archive.njk',
    '!content/pages/page.njk',
    '!content/pages/issue_template.njk',
  ],
  overrides: {},
}

const USAGE = `usage (run from ~/Kotahi):
  node scripts/cms-sync.js drift   [--groups a,b] [--diff PATH]
  node scripts/cms-sync.js push    [PATH ...] [--groups a,b] [--dry-run] [--yes] [--force]
  node scripts/cms-sync.js verify  [--groups a,b]
  node scripts/cms-sync.js restore PATH ... --from cms-sync-out/<time>/live --groups a`

const args = parseArgs(process.argv.slice(2))

async function main() {
  const cmd = args._[0]
  if (!['drift', 'push', 'verify', 'restore'].includes(cmd)) {
    console.error(USAGE)
    process.exit(2)
  }

  const server = (args.server || 'https://iplaces-test-server.fly.dev').replace(/\/$/, '')
  const masterDir = args.master || 'station-master/cmsTemplateFiles'
  const manifestPath = args.manifest || 'station-master/manifest.json'
  const manifest = fs.existsSync(manifestPath)
    ? JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
    : DEFAULT_MANIFEST
  const groups = args.groups ? args.groups.split(',') : manifest.stations
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const outDir = args.out || path.join('cms-sync-out', stamp)

  if (!fs.existsSync(masterDir)) throw new Error(`no master at ${masterDir} (run from ~/Kotahi)`)

  const isOwned = makeMatcher(manifest.stationOwned || [])
  const master = readTree(masterDir)
  const shared = Object.keys(master).filter(p => !isOwned(p)).sort()

  console.log(`server   ${server}`)
  console.log(`master   ${masterDir} (${Object.keys(master).length} files, ${shared.length} shared)`)
  console.log(`manifest ${fs.existsSync(manifestPath) ? manifestPath : 'built-in default'}`)
  console.log(`stations ${groups.join(', ')}\n`)

  if (cmd === 'verify') return verify(groups)

  const allGroups = await gql(server, null, '{ groups { id name } }')
  const live = {}
  const ids = {}
  const folders = {}
  const groupIds = {}

  for (const name of groups) {
    const g = allGroups.groups.find(x => x && x.name === name)
    if (!g) throw new Error(`no group named "${name}" on ${server}`)
    process.stdout.write(`reading ${name} … `)
    const r = await readLive(server, g.id)
    live[name] = r.files
    ids[name] = r.ids
    folders[name] = r.folders
    groupIds[name] = g.id
    const dir = path.join(outDir, 'live', name)
    for (const [p, content] of Object.entries(live[name])) {
      fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true })
      fs.writeFileSync(path.join(dir, p), content)
    }
    console.log(`${Object.keys(live[name]).length} files`)
  }

  const ctx = { server, masterDir, master, manifest, isOwned, groups, live, ids, folders, groupIds, outDir }
  if (cmd === 'push') return push(ctx)
  if (cmd === 'restore') return restore(ctx)

  // ---- compare
  const rows = shared.map(p => {
    const statuses = {}
    for (const name of groups) {
      const overridden = (manifest.overrides?.[name] || []).includes(p)
      statuses[name] = overridden ? 'override' : compare(p, master[p], live[name][p])
    }
    return { path: p, statuses }
  })

  const extras = {}
  for (const name of groups) {
    extras[name] = Object.keys(live[name])
      .filter(p => !(p in master) && !isOwned(p))
      .sort()
  }

  const report = renderReport({ server, masterDir, groups, rows, extras, manifest })
  fs.mkdirSync(outDir, { recursive: true })
  fs.writeFileSync(path.join(outDir, 'drift.md'), report)
  console.log(`\n${report}`)
  console.log(`report + live copies: ${outDir}/ (nothing on the server was changed)`)

  if (args.diff) {
    for (const name of groups) {
      console.log(`\n===== ${args.diff} : master vs ${name}`)
      const livePath = path.join(outDir, 'live', name, args.diff)
      if (!fs.existsSync(livePath)) { console.log('(missing in station)'); continue }
      try {
        execFileSync('diff', ['-u', path.join(masterDir, args.diff), livePath], { stdio: 'inherit' })
        console.log('(identical)')
      } catch (_) { /* diff exits 1 when files differ */ }
    }
  }
}

// ---------- push / restore / verify

const FLAX_APP = 'iplaces-test-flax'
const FLAX_ROOT = process.env.CMS_SYNC_FLAX_ROOT || '/app' // override only for local tests
const STATE_FILE = 'station-master/cms-sync-state.json'
const sha = s => crypto.createHash('sha256').update(s).digest('hex').slice(0, 16)

function restore(ctx) {
  if (!args.from) throw new Error('restore needs --from cms-sync-out/<time>/live')
  const read = (g, p) => {
    const f = path.join(args.from, g, p)
    return fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : undefined
  }
  return push(ctx, read, { label: `backup ${args.from}`, allowOwned: true })
}

async function push(ctx, readSource, opts = {}) {
  const { server, master, isOwned, manifest, groups, live, ids, folders, groupIds, outDir } = ctx
  // Station-owned files that every station must have (e.g. data/issues.json):
  // created from master when missing, never overwritten.
  const createIfMissing = manifest.createIfMissing || []
  const creates = {}
  const base = readSource || ((g, p) => master[p])
  // station.json is station-owned, but the manifest can set named keys in it
  // ("stationJson": {"*": {defaults, added only when missing}, "<group>": {always set}}).
  const stationJson = readSource ? {} : stationJsonUpdates(manifest, groups, live)
  const source = (g, p) => (p === 'data/station.json' && stationJson[g] !== undefined ? stationJson[g] : base(g, p))
  const label = opts.label || 'station-master'
  const requested = args._.slice(1)
  const state = fs.existsSync(STATE_FILE) ? JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) : {}

  // ---- plan
  const plan = {}
  const problems = []
  for (const g of groups) {
    plan[g] = []
    creates[g] = new Set()
    const candidates = requested.length ? [...requested] : Object.keys(master).filter(p => !isOwned(p))
    if (!requested.length) for (const p of createIfMissing) if (!candidates.includes(p)) candidates.push(p)
    if (!requested.length && stationJson[g] !== undefined && !candidates.includes('data/station.json')) candidates.push('data/station.json')
    for (const p of candidates) {
      const want = source(g, p)
      if (want === undefined) { if (requested.length) problems.push(`${g}: ${p} is not in ${label}`); continue }
      const managed = p === 'data/station.json' && stationJson[g] !== undefined
      const seed = createIfMissing.includes(p) && live[g][p] === undefined
      if (createIfMissing.includes(p) && !seed && !opts.allowOwned) continue
      if (isOwned(p) && !opts.allowOwned && !managed && !seed) { problems.push(`${g}: ${p} is station-owned (manifest); not pushed`); continue }
      if ((manifest.overrides?.[g] || []).includes(p)) { console.log(`skip ${g}: ${p} (listed override)`); continue }
      const have = live[g][p]
      if (have === undefined) {
        const dir = path.posix.dirname(p) === '.' ? '' : path.posix.dirname(p)
        if (folders[g][dir] === undefined) { problems.push(`${g}: ${p} is missing and so is its folder "${dir}"; create the folder in the CMS first`); continue }
        creates[g].add(p)
        plan[g].push(p)
        continue
      }
      if (compare(p, want, have) === 'same') continue
      const last = state[g]?.[p]
      if (last && !managed && sha(have) !== last && !args.force) {
        problems.push(`${g}: ${p} was edited in the CMS since the last push. Fold that edit into master, or re-run with --force`)
        continue
      }
      plan[g].push(p)
    }
  }

  for (const msg of problems) console.log(`! ${msg}`)
  const total = groups.reduce((n, g) => n + plan[g].length, 0)
  if (!total) {
    console.log(problems.length ? '\nNothing to push (see ! lines above).' : '\nNothing to push: every requested file already matches.')
    return
  }

  // ---- show the diffs
  const candDir = path.join(outDir, 'candidate')
  for (const g of groups) {
    for (const p of plan[g]) {
      const f = path.join(candDir, g, p)
      fs.mkdirSync(path.dirname(f), { recursive: true })
      fs.writeFileSync(f, source(g, p))
      console.log(`\n===== ${g}: ${p}  (live → ${label})`)
      if (creates[g].has(p)) { console.log(`(new file, will be created)\n${source(g, p).slice(0, 600)}`); continue }
      try { execFileSync('diff', ['-u', path.join(outDir, 'live', g, p), f], { stdio: 'inherit' }) } catch (_) { /* differs */ }
    }
  }
  console.log(`\nPlan: ${groups.map(g => `${g} ${plan[g].length} file(s)`).join(', ')}`)
  console.log(`Backup of current live files: ${path.join(outDir, 'live')}/`)
  if (args['dry-run']) { console.log('\n--dry-run: nothing was changed.'); return }

  // ---- pre-flight: build each station with the candidate files, on the Flax machine
  if (!args['skip-preflight']) {
    for (const g of groups.filter(x => plan[x].length)) {
      const files = Object.fromEntries(plan[g].map(p => [p, source(g, p)]))
      const r = preflight(g, live[g], files)
      console.log(`pre-flight ${g}: ${r.recs} records; current CMS builds ${r.base.pages} pages${r.base.exit ? ' (FAILS: publishing as-is would 403)' : ''}; with changes ${r.cand.pages} pages, exit ${r.cand.exit}${r.cand.index ? '' : ', NO index.html'}`)
      if (!r.ok) {
        console.log(r.cand.log)
        throw new Error(`pre-flight build failed for ${g}; nothing was pushed to any station`)
      }
    }
  }

  if (!args.yes && !(await confirm(`Push ${total} file(s) now? Type yes: `))) {
    console.log('Stopped; nothing was changed.')
    return
  }

  // ---- write, then read back
  for (const g of groups) {
    for (const p of plan[g]) {
      const want = source(g, p)
      if (creates[g].has(p)) {
        const dir = path.posix.dirname(p) === '.' ? '' : path.posix.dirname(p)
        const made = await gql(server, groupIds[g], 'mutation($id: ID!) { addResourceToFolder(id: $id, type: false) { id fileId } }', { id: folders[g][dir] })
        await gql(server, groupIds[g], 'mutation($id: ID!, $n: String!) { renameResource(id: $id, name: $n) { id } }', { id: made.addResourceToFolder.id, n: path.posix.basename(p) })
        ids[g][p] = made.addResourceToFolder.fileId
        console.log(`created ${g}: ${p}`)
      }
      await gql(server, groupIds[g], 'mutation($id: ID!, $c: String!) { updateResource(id: $id, content: $c) { id } }', { id: ids[g][p], c: want })
      const back = await gql(server, groupIds[g], 'query($id: ID!) { getCmsFileContent(id: $id) { content } }', { id: ids[g][p] })
      if (compare(p, want, back.getCmsFileContent.content) !== 'same') throw new Error(`${g}: ${p} did not read back as written; stop and check the CMS`)
      state[g] = state[g] || {}
      state[g][p] = sha(back.getCmsFileContent.content)
      console.log(`pushed ${g}: ${p}`)
    }
  }
  fs.writeFileSync(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`)

  // ---- rebuild
  const changed = groups.filter(g => plan[g].length)
  if (process.env.KOTAHI_TOKEN) {
    for (const g of changed) {
      const r = await gql(server, groupIds[g], 'mutation { rebuildFlaxSite(params: "{}") { status error } }')
      console.log(`rebuild ${g}: ${r.rebuildFlaxSite.status || r.rebuildFlaxSite.error}`)
    }
    console.log(`\nWhen the builds finish: node scripts/cms-sync.js verify --groups ${changed.join(',')}`)
  } else {
    console.log(`\nNow click Publish in the CMS of: ${changed.join(', ')}`)
    console.log(`Then: node scripts/cms-sync.js verify --groups ${changed.join(',')}`)
  }
  console.log(`Commit ${STATE_FILE} with the template change.`)
}

function stationJsonUpdates(manifest, groups, live) {
  const spec = manifest.stationJson || {}
  const out = {}
  for (const g of groups) {
    const raw = live[g]['data/station.json']
    if (raw === undefined || (!spec['*'] && !spec[g])) continue
    const cur = JSON.parse(raw)
    const next = { ...cur }
    for (const [k, v] of Object.entries(spec['*'] || {})) if (!(k in next)) next[k] = v
    Object.assign(next, spec[g] || {})
    if (canon(next) === canon(cur)) continue
    out[g] = /\n\s+"/.test(raw) ? `${JSON.stringify(next, null, 2)}\n` : JSON.stringify(next)
  }
  return out
}

function preflight(g, liveFiles, files) {
  // Builds the station exactly as a Publish would right now: the live CMS files
  // (read by this script), plus Flax's own data/articleQuery.json. Not a copy of
  // /app/src/<g>, which can hold stale files the CMS no longer has (20 Oct: wams
  // built fine from a leftover data/issues.json, then 403'd on publish).
  //
  // Flax's eleventy.config.js beforeBuild deletes every non-asset directory in
  // inputDir.replace("src", "public"), so the input sits under a throwaway
  // .../src/<g> with a throwaway "public" twin. Never build from /app/src.
  const R = '/tmp/cms-sync'
  const IN = `${R}/src/${g}`
  const OUT = `${R}/public/${g}`
  const enc = obj => Object.fromEntries(Object.entries(obj)
    .filter(([p]) => p !== 'data/articleQuery.json')
    .map(([p, c]) => [p, Buffer.from(c).toString('base64')]))
  flaxUpload(`${R}-base.json`, JSON.stringify(enc(liveFiles)))
  flaxUpload(`${R}-cand.json`, JSON.stringify(enc({ ...liveFiles, ...files })))
  const write = which => `node -e 'const fs=require("fs"),path=require("path");const d=JSON.parse(fs.readFileSync("${R}-${which}.json"));for(const[k,v] of Object.entries(d)){const f=path.join("${IN}",k);fs.mkdirSync(path.dirname(f),{recursive:true});fs.writeFileSync(f,Buffer.from(v,"base64"))}'`
  const fresh = which => [
    `rm -rf ${R}/src ${R}/public && mkdir -p ${IN}/data ${R}/public`,
    write(which),
    `cp ${FLAX_ROOT}/src/${g}/data/articleQuery.json ${IN}/data/articleQuery.json`,
  ].join(' && ')
  const build = log => `npx eleventy --pathprefix=${g} --input=${IN} --output=${OUT} > ${R}/${log}.log 2>&1`
  const out = flaxRun([
    `mkdir -p ${R}`,
    `cd ${FLAX_ROOT}`,
    `echo RECS=$(grep -o shortId ${FLAX_ROOT}/src/${g}/data/articleQuery.json | wc -l)`,
    fresh('base'),
    `${build('base')}; echo BASE_EXIT=$?`,
    `echo BASE_PAGES=$(ls ${OUT}/articles 2>/dev/null | wc -l)`,
    fresh('cand'),
    `${build('cand')}; echo CAND_EXIT=$?`,
    `echo CAND_PAGES=$(ls ${OUT}/articles 2>/dev/null | wc -l)`,
    `test -f ${OUT}/index.html && echo CAND_INDEX=1`,
    `echo ---LOG; grep -iE "error|problem" ${R}/cand.log | head -20; tail -3 ${R}/cand.log`,
    `rm -rf ${R}/src ${R}/public ${R}-base.json ${R}-cand.json`,
  ].join('\n'))
  const num = k => Number((out.match(new RegExp(`${k}=(\\d+)`)) || [])[1])
  const recs = num('RECS')
  const base = { exit: num('BASE_EXIT'), pages: num('BASE_PAGES') }
  const cand = { exit: num('CAND_EXIT'), pages: num('CAND_PAGES'), index: /CAND_INDEX=1/.test(out), log: out.split('---LOG')[1] || out }
  if (!(recs > 0)) throw new Error(`pre-flight: no records found in ${FLAX_ROOT}/src/${g}/data/articleQuery.json; publish ${g} once, then re-run. Nothing was pushed.`)
  // The recipe-11a check: one article page per record, plus a homepage.
  const ok = cand.exit === 0 && cand.index && cand.pages === recs
  return { ok, recs, base, cand }
}

// Copy a (possibly large) text file to the Flax machine in base64 chunks.
function flaxUpload(dest, content) {
  const b64 = Buffer.from(content).toString('base64')
  fly(`sh -c 'rm -f ${dest}.b64'`)
  for (let i = 0; i < b64.length; i += 60000) fly(`sh -c 'printf %s ${b64.slice(i, i + 60000)} >> ${dest}.b64'`)
  fly(`sh -c 'base64 -d ${dest}.b64 > ${dest} && rm -f ${dest}.b64'`)
}

// Ship a script to the Flax machine, then run it.
function flaxRun(script) {
  const tag = `/tmp/cms-sync-${process.pid}.sh`
  flaxUpload(tag, script)
  return fly(`sh -c 'sh ${tag}; rm -f ${tag}'`)
}

function fly(cmd) {
  for (let attempt = 1; ; attempt++) {
    try {
      return execFileSync('fly', ['ssh', 'console', '-a', FLAX_APP, '-C', cmd], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (err) {
      if (attempt >= 2) throw new Error(`fly ssh failed: ${(err.stderr || err.message).toString().slice(0, 400)}`)
    }
  }
}

async function verify(groups) {
  let bad = 0
  for (const g of groups) {
    const out = fly(`sh -c 'echo PAGES=$(ls ${FLAX_ROOT}/public/${g}/articles 2>/dev/null | wc -l); echo IDS=$(grep -o shortId ${FLAX_ROOT}/src/${g}/data/articleQuery.json | wc -l); test -f ${FLAX_ROOT}/public/${g}/index.html && echo INDEX=1; true'`)
    const pages = Number((out.match(/PAGES=(\d+)/) || [])[1])
    const recs = Number((out.match(/IDS=(\d+)/) || [])[1])
    let code = 0
    try { code = (await fetch(`https://${FLAX_APP}.fly.dev/${g}/`)).status } catch (_) { /* leave 0 */ }
    const ok = code === 200 && /INDEX=1/.test(out) && pages === recs
    if (!ok) bad++
    console.log(`${ok ? 'OK  ' : 'FAIL'} ${g}: HTTP ${code}, ${pages} article pages for ${recs} records${/INDEX=1/.test(out) ? '' : ', no index.html'}`)
  }
  if (bad) process.exitCode = 1
}

function confirm(question) {
  const rl = require('readline').createInterface({ input: process.stdin, output: process.stdout })
  return new Promise(resolve => rl.question(question, a => { rl.close(); resolve(a.trim() === 'yes') }))
}

// ---------- live CMS reads (the same two queries Flax uses)

async function readLive(server, groupId) {
  const res = await gql(server, groupId, '{ getActiveCmsFilesTree }')
  const tree = JSON.parse(res.getActiveCmsFilesTree)
  const files = []
  const folders = { '': tree.id }
  const walk = (node, prefix) => {
    for (const child of node.children || []) {
      const p = prefix ? `${prefix}/${child.name}` : child.name
      if (child.fileId) files.push({ path: p, fileId: child.fileId })
      else { folders[p] = child.id; walk(child, p) }
    }
  }
  walk(tree, '')

  const out = {}
  const ids = {}
  for (const f of files) ids[f.path] = f.fileId
  await pool(files, 6, async f => {
    const r = await gql(
      server,
      groupId,
      'query($id: ID!) { getCmsFileContent(id: $id) { content } }',
      { id: f.fileId },
    )
    out[f.path] = r.getCmsFileContent.content ?? ''
  })
  return { files: out, ids, folders }
}

async function gql(server, groupId, query, variables) {
  const headers = { 'content-type': 'application/json' }
  if (groupId) headers['group-id'] = groupId
  if (process.env.KOTAHI_TOKEN) headers.authorization = `Bearer ${process.env.KOTAHI_TOKEN}`
  let lastErr
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const resp = await fetch(`${server}/graphql`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ query, variables }),
      })
      const body = await resp.json()
      if (body.errors?.length) {
        const msg = body.errors.map(e => e.message).join('; ')
        if (/not authori[sz]ed|forbidden/i.test(msg)) {
          throw Object.assign(new Error(`${msg} (set KOTAHI_TOKEN)`), { fatal: true })
        }
        throw new Error(msg)
      }
      return body.data
    } catch (err) {
      if (err.fatal) throw err
      lastErr = err
      // first call can hit a stopped machine; give it a moment
      await new Promise(r => setTimeout(r, 2000 * attempt))
    }
  }
  throw lastErr
}

async function pool(items, size, fn) {
  let i = 0
  const worker = async () => { while (i < items.length) await fn(items[i++]) }
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, worker))
}

// ---------- comparison

function compare(p, masterContent, liveContent) {
  if (liveContent === undefined) return 'missing'
  if (masterContent === liveContent) return 'same'
  // getCmsFileContent re-serialises JSON files (axios parses them), so compare parsed
  if (p.endsWith('.json')) {
    try {
      if (canon(JSON.parse(masterContent)) === canon(JSON.parse(liveContent))) return 'same'
    } catch (_) { /* fall through to text compare */ }
  }
  if (norm(masterContent) === norm(liveContent)) return 'ws-only'
  return 'differs'
}

const norm = s => s.replace(/\r\n/g, '\n').replace(/[ \t]+$/gm, '').replace(/\s+$/, '')

function canon(v) {
  if (Array.isArray(v)) return `[${v.map(canon).join(',')}]`
  if (v && typeof v === 'object') {
    return `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${canon(v[k])}`).join(',')}}`
  }
  return JSON.stringify(v)
}

function readTree(root) {
  const out = {}
  const walk = rel => {
    for (const ent of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
      if (ent.name === '.DS_Store') continue
      const p = rel ? `${rel}/${ent.name}` : ent.name
      if (ent.isDirectory()) walk(p)
      else out[p] = fs.readFileSync(path.join(root, p), 'utf8')
    }
  }
  walk('')
  return out
}

// `*` matches within one path segment; a leading `!` re-includes. Last match wins.
function makeMatcher(patterns) {
  const compiled = patterns.map(raw => {
    const neg = raw.startsWith('!')
    const pat = neg ? raw.slice(1) : raw
    const re = new RegExp(`^${pat.split('*').map(escapeRe).join('[^/]*')}$`)
    return { neg, re }
  })
  return p => {
    let owned = false
    for (const { neg, re } of compiled) if (re.test(p)) owned = !neg
    return owned
  }
}

const escapeRe = s => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')

// ---------- report

function renderReport({ server, masterDir, groups, rows, extras, manifest }) {
  const mark = { same: '✓', 'ws-only': '≈', differs: '✗', missing: '–', override: 'o' }
  const lines = []
  lines.push(`# CMS drift ${new Date().toISOString().slice(0, 16)}Z`)
  lines.push('')
  lines.push(`${server} vs ${masterDir}. ✓ same · ≈ whitespace only · ✗ differs · – missing · o listed override`)
  lines.push('')

  const drifted = rows.filter(r => groups.some(g => !['same', 'override'].includes(r.statuses[g])))
  lines.push(`## Shared files that drift (${drifted.length} of ${rows.length})`)
  lines.push('')
  if (drifted.length) {
    lines.push(`| file | ${groups.join(' | ')} |`)
    lines.push(`|---|${groups.map(() => '---').join('|')}|`)
    for (const r of drifted) {
      lines.push(`| ${r.path} | ${groups.map(g => mark[r.statuses[g]]).join(' | ')} |`)
    }
  } else {
    lines.push('None. Every shared file matches station-master.')
  }
  lines.push('')

  lines.push('## Per station')
  lines.push('')
  for (const g of groups) {
    const count = s => rows.filter(r => r.statuses[g] === s).length
    lines.push(`- **${g}**: ${count('same')} same, ${count('differs')} differ, ${count('ws-only')} whitespace-only, ${count('missing')} missing` +
      (count('override') ? `, ${count('override')} override` : ''))
  }
  lines.push('')

  const anyExtra = groups.some(g => extras[g].length)
  lines.push('## In a station but not in master (and not station-owned)')
  lines.push('')
  if (!anyExtra) lines.push('None.')
  for (const g of groups) {
    if (extras[g].length) lines.push(`- **${g}**: ${extras[g].join(', ')}`)
  }
  lines.push('')

  const ov = Object.entries(manifest.overrides || {}).filter(([, v]) => v.length)
  if (ov.length) {
    lines.push('## Listed overrides')
    lines.push('')
    for (const [g, v] of ov) lines.push(`- **${g}**: ${v.join(', ')}`)
    lines.push('')
  }
  return lines.join('\n')
}

function parseArgs(argv) {
  const out = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const BOOL = ['dry-run', 'yes', 'force', 'skip-preflight']
    const key = argv[i].slice(2)
    if (argv[i].startsWith('--')) out[key] = BOOL.includes(key) ? true : argv[++i]
    else out._.push(argv[i])
  }
  return out
}

main().catch(err => {
  console.error(`\nFAILED: ${err.message}`)
  process.exit(1)
})
