#!/usr/bin/env node
// Downloads the current DataCite record and the full change history
// (DataCite "activities") of every DOI in the iPlaces DataCite repository,
// so we can see which metadata a publish or republish removed, and when.
// Read only: public DataCite API, no login, nothing is changed anywhere.
//
// Usage: node scripts/datacite-history.js [--client sjyq.omytlw] [--only <doi>...]
// Writes datacite-history-out/<time>/: dois/<doi>.json (record + activities)
// and losses.csv (one row per item an update removed).
const fs = require('fs')
const path = require('path')

const args = process.argv.slice(2)
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d }
const CLIENT = opt('--client', 'sjyq.omytlw')
const onlyIdx = args.indexOf('--only')
const ONLY = onlyIdx >= 0 ? args.slice(onlyIdx + 1).filter(a => !a.startsWith('--')) : null
const API = 'https://api.datacite.org'
const OUT = path.join('datacite-history-out', new Date().toISOString().replace(/[:.]/g, '-'))
fs.mkdirSync(path.join(OUT, 'dois'), { recursive: true })

const sleep = ms => new Promise(r => setTimeout(r, ms))
const getJson = async url => {
  for (let i = 0; ; i++) {
    const r = await fetch(url, { headers: { Accept: 'application/vnd.api+json' } })
    if (r.ok) return r.json()
    if (r.status === 404) return null
    if (i >= 4) throw new Error(`${url}: HTTP ${r.status}`)
    await sleep(2000 * (i + 1))
  }
}

const listDois = async () => {
  if (ONLY) return ONLY.map(d => d.toLowerCase())
  const out = []
  let url = `${API}/dois?client-id=${CLIENT}&page[size]=500&page[cursor]=1&fields[dois]=doi`
  while (url) {
    const p = await getJson(url)
    p.data.forEach(d => out.push(d.id.toLowerCase()))
    url = p.links && p.links.next
  }
  return out
}

const getActivities = async doi => {
  const all = []
  let url = `${API}/dois/${doi}/activities?page[size]=100`
  while (url) {
    const p = await getJson(url)
    if (!p) break
    all.push(...(p.data || []))
    url = p.links && p.links.next && p.links.next !== url ? p.links.next : null
  }
  return all
}

// ---- loss detection: for each update, items in the old value missing from the new one
const norm = v => JSON.stringify(v, (k, x) => (x === null || x === '' || (Array.isArray(x) && !x.length) ? undefined : typeof x === 'string' ? x.trim().toLowerCase() : x))
const orcid = s => (String(s || '').match(/\d{4}-\d{4}-\d{4}-\d{3}[\dx]/i) || [''])[0].toLowerCase()
const KEYS = {
  geo_locations: g => norm(g),
  subjects: s => `${String(s.subject || '').trim().toLowerCase()}|${s.subjectScheme || ''}|${s.valueUri || ''}|${s.classificationCode || ''}`,
  dates: d => `${d.dateType}${/accepted|updated|issued|submitted/i.test(d.dateType) ? '' : `|${d.date}`}`,
  contributors: c => `${String(c.name || '').trim().toLowerCase()}|${c.contributorType}`,
  rights_list: r => String(r.rightsIdentifier || r.rightsUri || r.rights || '').trim().toLowerCase(),
  funding_references: f => `${String(f.funderName || '').trim().toLowerCase()}|${f.funderIdentifier || ''}|${f.awardNumber || ''}`,
  related_identifiers: r => `${String(r.relatedIdentifier || '').trim().toLowerCase()}|${r.relationType}`,
  related_items: r => norm(r.relatedItemIdentifier || r.titles || r),
  descriptions: d => `${d.descriptionType}|${String(d.description || '').replace(/\s+/g, ' ').trim().toLowerCase().slice(0, 80)}`,
  identifiers: i => norm(i),
  alternate_identifiers: i => norm(i),
  sizes: s => norm(s),
  formats: s => norm(s),
  creators: c => `${String(c.name || `${c.familyName}, ${c.givenName}`).trim().toLowerCase()}|${(c.nameIdentifiers || []).map(n => orcid(n.nameIdentifier)).filter(Boolean).sort().join(',')}|${(c.affiliation || []).map(a => (typeof a === 'object' ? a.affiliationIdentifier || '' : '')).filter(Boolean).sort().join(',')}`,
}
const SCALARS = ['language', 'version', 'publisher', 'types', 'publication_year']
const asArr = v => (Array.isArray(v) ? v : v == null ? [] : [v])

const lossesFor = (doi, acts) => {
  const rows = []
  for (const a of acts) {
    const at = a.attributes || {}
    if (at.action !== 'update' || !at.changes) continue
    const when = at['prov:generatedAtTime']
    for (const [field, change] of Object.entries(at.changes)) {
      if (!Array.isArray(change) || change.length !== 2) continue
      const [oldV, newV] = change
      if (KEYS[field]) {
        const have = new Set(asArr(newV).map(KEYS[field]))
        for (const item of asArr(oldV)) if (item && !have.has(KEYS[field](item))) rows.push({ doi, when, version: at.version, field, item })
      } else if (SCALARS.includes(field)) {
        const o = norm(oldV); const n = norm(newV)
        if (o && o !== n) rows.push({ doi, when, version: at.version, field, item: oldV, now: newV })
      }
    }
  }
  return rows
}

const csv = v => `"${String(v == null ? '' : typeof v === 'string' ? v : JSON.stringify(v)).replace(/"/g, '""')}"`

const main = async () => {
  const dois = await listDois()
  console.log(`${dois.length} DOIs in ${CLIENT}; saving to ${OUT}`)
  const lossRows = []
  let done = 0
  const queue = [...dois]
  const worker = async () => {
    while (queue.length) {
      const doi = queue.shift()
      try {
        const rec = await getJson(`${API}/dois/${doi}?publisher=true&affiliation=true`)
        const acts = await getActivities(doi)
        fs.writeFileSync(path.join(OUT, 'dois', `${doi.replace(/\//g, '_')}.json`), JSON.stringify({ doi, record: rec && rec.data, activities: acts }))
        const url = rec && rec.data && rec.data.attributes.url
        lossesFor(doi, acts).forEach(r => lossRows.push({ ...r, url }))
      } catch (e) {
        console.log(`! ${doi}: ${e.message}`)
      }
      done++
      if (done % 50 === 0) console.log(`${done}/${dois.length}`)
      await sleep(150)
    }
  }
  await Promise.all([worker(), worker(), worker(), worker()])
  lossRows.sort((a, b) => String(a.when).localeCompare(String(b.when)))
  fs.writeFileSync(path.join(OUT, 'losses.csv'), ['doi,url,when,version,field,removed,now', ...lossRows.map(r => [r.doi, r.url, r.when, r.version, r.field, r.item, r.now].map(csv).join(','))].join('\n'))
  const byField = {}
  lossRows.forEach(r => { byField[r.field] = (byField[r.field] || new Set()).add(r.doi) })
  console.log('\nDOIs that lost something, by field:')
  Object.entries(byField).sort((a, b) => b[1].size - a[1].size).forEach(([f, s]) => console.log(`  ${f}: ${s.size}`))
  console.log(`\nDONE. ${OUT}/losses.csv`)
}
main().catch(e => { console.error(e); process.exit(1) })
