#!/usr/bin/env node
/*
 * cms-sync: compare station-master against each station's live Kotahi CMS files.
 *
 * Only `drift` exists so far, and it is READ-ONLY: it calls the two CMS read
 * queries Flax itself uses (getActiveCmsFilesTree, getCmsFileContent) and never
 * a mutation. Plan: /mnt/project-files/planning/shared-flax-templates-plan.md
 *
 *   node scripts/cms-sync.js drift
 *   node scripts/cms-sync.js drift --groups gumpstation,wams --diff content/pages/browse.njk
 *
 * Options:
 *   --server URL       Kotahi server (default https://iplaces-test-server.fly.dev)
 *   --groups a,b       stations to check (default: manifest "stations")
 *   --master DIR       default station-master/cmsTemplateFiles
 *   --manifest FILE    default station-master/manifest.json (built-in default if absent)
 *   --out DIR          where live copies + drift.md go (default cms-sync-out/<timestamp>)
 *   --diff PATH        also print `diff -u master live` for that file, per station
 *   KOTAHI_TOKEN env   optional bearer token, only if the reads turn out to need auth
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

const args = parseArgs(process.argv.slice(2))

async function main() {
  if (args._[0] !== 'drift') {
    console.error('usage: node scripts/cms-sync.js drift [--groups a,b] [--diff PATH]')
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

  const allGroups = await gql(server, null, '{ groups { id name } }')
  const live = {}

  for (const name of groups) {
    const g = allGroups.groups.find(x => x && x.name === name)
    if (!g) throw new Error(`no group named "${name}" on ${server}`)
    process.stdout.write(`reading ${name} … `)
    live[name] = await readLive(server, g.id)
    const dir = path.join(outDir, 'live', name)
    for (const [p, content] of Object.entries(live[name])) {
      fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true })
      fs.writeFileSync(path.join(dir, p), content)
    }
    console.log(`${Object.keys(live[name]).length} files`)
  }

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

// ---------- live CMS reads (the same two queries Flax uses)

async function readLive(server, groupId) {
  const res = await gql(server, groupId, '{ getActiveCmsFilesTree }')
  const tree = JSON.parse(res.getActiveCmsFilesTree)
  const files = []
  const walk = (node, prefix) => {
    for (const child of node.children || []) {
      const p = prefix ? `${prefix}/${child.name}` : child.name
      if (child.fileId) files.push({ path: p, fileId: child.fileId })
      else walk(child, p)
    }
  }
  walk(tree, '')

  const out = {}
  await pool(files, 6, async f => {
    const r = await gql(
      server,
      groupId,
      'query($id: ID!) { getCmsFileContent(id: $id) { content } }',
      { id: f.fileId },
    )
    out[f.path] = r.getCmsFileContent.content ?? ''
  })
  return out
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
    if (argv[i].startsWith('--')) out[argv[i].slice(2)] = argv[i + 1]?.startsWith('--') ? true : argv[++i]
    else out._.push(argv[i])
  }
  return out
}

main().catch(err => {
  console.error(`\nFAILED: ${err.message}`)
  process.exit(1)
})
