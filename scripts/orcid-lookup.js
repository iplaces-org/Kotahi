#!/usr/bin/env node
/* iplaces: look up ORCIDs for the people that import-datacite-dois.js would
 * import WITHOUT one (Tetiaroa DOIs -> baileystation by default).
 *
 * It maps the DOIs exactly as the import does (name fixes, ORCIDs already
 * found on other iPlaces DOIs), then searches the public ORCID registry
 * (pub.orcid.org expanded-search, no login) by given + family name, and
 * compares each hit's institutions with the person's affiliations.
 *
 * Output: import-out/orcid-candidates.csv, one row per person:
 *   match  affiliation  one ORCID hit shares an institution with the person (use = yes)
 *          one-hit      exactly one person with that name in ORCID, no shared institution
 *          several      several people with that name (candidates listed)
 *          none         nobody with that name
 * Only "affiliation" rows start as use = yes. Check the others and type yes
 * in the use column for any you are sure of (ORCID links are in the row),
 * then run the import with --orcids import-out/orcid-candidates.csv
 *
 * Usage (from ~/Kotahi): node scripts/orcid-lookup.js [same options as the import, e.g. --only ...]
 * Requires Node 18+. Changes nothing anywhere.
 */
/* eslint-disable no-console, no-await-in-loop, no-restricted-syntax */
const fs = require('fs')
const path = require('path')
const { mapRecord, parseArgs, listDois, buildOrcidIndex, nameKey, str } = require('./import-datacite-dois')

const API = 'https://pub.orcid.org/v3.0/expanded-search/'
const sleep = ms => new Promise(r => setTimeout(r, ms))
const fold = s => str(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '')
const quote = s => `"${str(s).replace(/["\\]/g, ' ')}"`

const search = async (first, last) => {
  const q = `given-names:${quote(first)} AND family-name:${quote(last)}`
  const url = `${API}?q=${encodeURIComponent(q)}&rows=20`
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const r = await fetch(url, { headers: { Accept: 'application/json' } })
    if (r.status === 429 || r.status >= 500) { await sleep(2000 * (attempt + 1)); continue }
    if (!r.ok) throw new Error(`ORCID search HTTP ${r.status}`)
    const j = await r.json()
    return (j['expanded-result'] || []).map(x => ({
      orcid: x['orcid-id'],
      name: `${str(x['given-names'])} ${str(x['family-names'])}`.trim(),
      institutions: (x['institution-name'] || []).map(str).filter(Boolean),
    }))
  }
  throw new Error('ORCID search kept failing (rate limit?)')
}

// words that say nothing about which institution it is
const STOP = new Set(['university', 'universite', 'universidad', 'universitat', 'institute', 'institut', 'national', 'research', 'centre', 'center', 'department', 'sciences', 'science', 'school', 'college', 'laboratory', 'laboratoire', 'faculty', 'state', 'french', 'france', 'society', 'station', 'marine', 'ecology', 'biology', 'environmental', 'studies', 'california', 'american'])
const words = s => new Set(fold(s).toLowerCase().split(/[^a-z]+/).filter(w => w.length >= 5 && !STOP.has(w)))
const shares = (insts, affils) => {
  for (const i of insts) {
    const wi = words(i)
    for (const a of affils) {
      if (fold(i).toLowerCase() === fold(a).toLowerCase()) return a
      for (const w of words(a)) if (wi.has(w)) return a
    }
  }
  return ''
}

const csvCell = v => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`

const main = async () => {
  const o = parseArgs(process.argv.slice(2))
  console.log(`Reading DataCite (${o.prefix}, publisher "${o.publisher}") ...`)
  const all = await listDois(o)
  const wanted = all.filter(d => {
    const at = d.attributes
    const pub = typeof at.publisher === 'object' && at.publisher ? at.publisher.name : at.publisher
    const doi = str(at.doi).toLowerCase()
    if (o.only.length) return o.only.includes(doi)
    return str(pub) === o.publisher && !o.skip.includes(doi)
  })
  o.orcidIndex = await buildOrcidIndex(o)

  // people without an ORCID after the import's own matching
  const people = new Map()
  for (const d of wanted) {
    const doi = str(d.attributes.doi).toLowerCase()
    const { submission } = mapRecord(d.attributes, o.group, o)
    for (const x of submission.$authors) {
      if (x.orcid) continue
      const k = nameKey(x.firstName, x.lastName)
      const e = people.get(k) || { first: x.firstName, last: x.lastName, dois: new Set(), affils: new Set() }
      e.dois.add(doi)
      for (const r of x.ror || []) if (str(r.label)) e.affils.add(str(r.label))
      people.set(k, e)
    }
  }
  console.log(`${wanted.length} records, ${people.size} people without an ORCID. Searching ORCID (about ${Math.ceil(people.size / 4)} s) ...`)

  const rows = [['use', 'match', 'first', 'last', 'orcid', 'orcid_name', 'orcid_institutions', 'shared_institution', 'affiliations_on_dois', 'records', 'dois', 'other_candidates']]
  const counts = { affiliation: 0, 'one-hit': 0, several: 0, none: 0 }
  let n = 0
  for (const e of people.values()) {
    n += 1
    let hits = await search(e.first, e.last)
    if (!hits.length && (fold(e.first) !== e.first || fold(e.last) !== e.last)) hits = await search(fold(e.first), fold(e.last))
    await sleep(250)
    const affils = [...e.affils]
    const withShared = hits.map(h => ({ ...h, shared: shares(h.institutions, affils) })).filter(h => h.shared)
    let match
    let pick = null
    if (withShared.length === 1) { match = 'affiliation'; [pick] = withShared } else if (hits.length === 1) { match = 'one-hit'; [pick] = hits } else if (hits.length) match = 'several'
    else match = 'none'
    counts[match] += 1
    const others = hits.filter(h => h !== pick && (!pick || h.orcid !== pick.orcid)).slice(0, 6)
      .map(h => `${h.orcid} ${h.name}${h.institutions.length ? ` (${h.institutions.slice(0, 2).join('; ')})` : ''}`).join(' | ')
    rows.push([
      match === 'affiliation' ? 'yes' : '',
      match,
      e.first,
      e.last,
      pick ? `https://orcid.org/${pick.orcid}` : '',
      pick ? pick.name : '',
      pick ? pick.institutions.join('; ') : '',
      pick ? pick.shared || '' : '',
      affils.join('; '),
      e.dois.size,
      [...e.dois].join(' '),
      others,
    ])
    if (n % 25 === 0) console.log(`  ${n} / ${people.size}`)
  }
  const order = { affiliation: 0, 'one-hit': 1, several: 2, none: 3 }
  const body = rows.slice(1).sort((a, b) => order[a[1]] - order[b[1]] || b[9] - a[9])
  fs.mkdirSync('import-out', { recursive: true })
  const out = path.join('import-out', 'orcid-candidates.csv')
  fs.writeFileSync(out, `${[rows[0], ...body].map(r => r.map(csvCell).join(',')).join('\n')}\n`)
  console.log(`\nORCID lookup for ${people.size} people:`)
  console.log(`${String(counts.affiliation).padStart(4)}  affiliation  one ORCID with a shared institution (use = yes)`)
  console.log(`${String(counts['one-hit']).padStart(4)}  one-hit      one person with that name, no shared institution (check)`)
  console.log(`${String(counts.several).padStart(4)}  several      several people with that name (check)`)
  console.log(`${String(counts.none).padStart(4)}  none         not found`)
  console.log(`\n${out}  (open it in Numbers/Excel, type yes in "use" for any you confirm, save as CSV)`)
  console.log('Nothing was changed anywhere.')
}

main().catch(e => {
  console.error(`LOOKUP FAILED: ${e.message}`)
  process.exit(1)
})
