#!/usr/bin/env node
/* iplaces: look up ORCIDs for the people that import-datacite-dois.js would
 * import WITHOUT one (Tetiaroa DOIs -> baileystation by default).
 *
 * It maps the DOIs exactly as the import does (name fixes, ORCIDs already
 * found on other iPlaces DOIs), then searches the public ORCID registry
 * (pub.orcid.org expanded-search, no login) by given + family name, and
 * compares each hit's institutions with the person's affiliations.
 *
 * For every candidate it reads the public ORCID record (employers, schools,
 * keywords, work titles) and scores the fit: shared institution 5, French
 * Polynesia in their record 3, +1 per topic word shared with the person's
 * DOIs (titles, keywords, abstracts; max 8). The best candidate is picked
 * when it scores 3+ and at least twice the next one.
 *
 * Output: import-out/orcid-candidates.csv, one row per person:
 *   match  affiliation  best fit, sharing an institution with the DOI
 *          likely       best fit by French Polynesia / topic
 *          one-hit      only one person with that name, no evidence either way
 *          several      no clear winner (candidates listed with their fit)
 *          none         nobody with that name
 * use = yes where the pick scores 6+ with two kinds of evidence (or 7+ on
 * topic alone); "why" says what matched. Check the rest and type yes
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
const STOP = new Set(['university', 'universite', 'universidad', 'universitat', 'institute', 'institut', 'national', 'research', 'centre', 'center', 'department', 'sciences', 'science', 'school', 'college', 'laboratory', 'laboratoire', 'faculty', 'state', 'french', 'france', 'society', 'station', 'marine', 'ecology', 'biology', 'environmental', 'studies', 'california', 'american',
  'about', 'after', 'among', 'based', 'between', 'could', 'during', 'effect', 'effects', 'first', 'impact', 'impacts', 'other', 'project', 'their', 'there', 'these', 'those', 'three', 'through', 'under', 'using', 'where', 'which', 'while', 'within', 'would', 'should', 'years', 'study', 'analysis', 'species', 'general', 'review', 'results', 'paragraph', 'class', 'island', 'islands'])
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

// One candidate's public record: employers, schools, keywords, work titles
const record = async orcid => {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const r = await fetch(`https://pub.orcid.org/v3.0/${orcid}/record`, { headers: { Accept: 'application/json' } })
    if (r.status === 429 || r.status >= 500) { await sleep(2000 * (attempt + 1)); continue }
    if (!r.ok) return { orgs: [], works: [], keywords: [] }
    const j = await r.json()
    const act = j['activities-summary'] || {}
    const orgsOf = (sec, key) => ((act[sec] || {})['affiliation-group'] || [])
      .flatMap(g => (g.summaries || []).map(x => str(((x[key] || {}).organization || {}).name))).filter(Boolean)
    const works = ((act.works || {}).group || [])
      .map(g => str(((((g['work-summary'] || [])[0] || {}).title || {}).title || {}).value)).filter(Boolean)
    const keywords = (((j.person || {}).keywords || {}).keyword || []).map(k => str(k.content)).filter(Boolean)
    return {
      orgs: [...orgsOf('employments', 'employment-summary'), ...orgsOf('educations', 'education-summary'), ...orgsOf('invited-positions', 'invited-position-summary'), ...orgsOf('memberships', 'membership-summary')],
      works,
      keywords,
    }
  }
  return { orgs: [], works: [], keywords: [] }
}
const PLACE = /polyn[eé]si|tahiti|mo[ʻ']?orea|tetiaroa|criobe|malard|pacific island|atoll|society islands/i
// How well a candidate fits: shared institution 5, French Polynesia in
// their institutions or works 3, +1 per topic word shared with the DOIs (max 8)
const score = (cand, e) => {
  const reasons = []
  let total = 0
  const orgs = [...new Set([...cand.institutions, ...cand.rec.orgs])]
  const inst = shares(orgs, [...e.affils])
  if (inst) { total += 5; reasons.push(`institution ${inst}`) }
  if (orgs.some(x => PLACE.test(x)) || cand.rec.works.some(x => PLACE.test(x))) { total += 3; reasons.push('French Polynesia in their record') }
  const theirs = new Set()
  for (const t of [...cand.rec.works, ...cand.rec.keywords]) for (const w of words(t)) theirs.add(w)
  const common = [...e.topic].filter(w => theirs.has(w))
  if (common.length) { total += Math.min(8, common.length); reasons.push(`topic words: ${common.slice(0, 6).join(', ')}`) }
  return { total, reasons, orgs, works: cand.rec.works.length }
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
      const e = people.get(k) || { first: x.firstName, last: x.lastName, dois: new Set(), affils: new Set(), topic: new Set() }
      e.dois.add(doi)
      for (const w of words(`${submission.$title} ${submission.keywords || ''} ${str(submission.$abstract).replace(/<[^>]+>/g, ' ')}`)) e.topic.add(w)
      for (const r of x.ror || []) if (str(r.label)) e.affils.add(str(r.label))
      people.set(k, e)
    }
  }
  console.log(`${wanted.length} records, ${people.size} people without an ORCID. Searching ORCID and reading candidates' records (a few minutes) ...`)

  const rows = [['use', 'match', 'first', 'last', 'orcid', 'orcid_name', 'orcid_institutions', 'why', 'affiliations_on_dois', 'records', 'dois', 'other_candidates']]
  const counts = { affiliation: 0, likely: 0, 'one-hit': 0, several: 0, none: 0 }
  let n = 0
  for (const e of people.values()) {
    n += 1
    let hits = await search(e.first, e.last)
    if (!hits.length && (fold(e.first) !== e.first || fold(e.last) !== e.last)) hits = await search(fold(e.first), fold(e.last))
    await sleep(250)
    const affils = [...e.affils]
    const cands = []
    for (const h of hits.slice(0, 8)) {
      const rec = await record(h.orcid)
      await sleep(150)
      cands.push({ ...h, rec })
    }
    for (const c of cands) c.fit = score(c, e)
    cands.sort((x, y) => y.fit.total - x.fit.total)
    const [best, second] = cands
    let match
    let pick = null
    if (!best) match = 'none'
    else if (best.fit.total >= 3 && (!second || best.fit.total >= 2 * second.fit.total)) { match = best.fit.reasons[0].startsWith('institution') ? 'affiliation' : 'likely'; pick = best } else if (cands.length === 1) { match = 'one-hit'; pick = best } else match = 'several'
    counts[match] += 1
    // use = yes only with two kinds of evidence, or a strong topic match
    const strong = pick && pick.fit.total >= 6 && (match === 'affiliation' || pick.fit.reasons.length >= 2 || pick.fit.total >= 7)
    const others = cands.filter(h => h !== pick).slice(0, 6)
      .map(h => `${h.orcid} ${h.name} [fit ${h.fit.total}]${h.fit.orgs.length ? ` (${h.fit.orgs.slice(0, 2).join('; ')})` : ''}`).join(' | ')
    rows.push([
      strong ? 'yes' : '',
      match,
      e.first,
      e.last,
      pick ? `https://orcid.org/${pick.orcid}` : '',
      pick ? pick.name : '',
      pick ? pick.fit.orgs.slice(0, 4).join('; ') : '',
      pick ? `fit ${pick.fit.total}: ${pick.fit.reasons.join('; ') || 'only person with this name'}` : '',
      affils.join('; '),
      e.dois.size,
      [...e.dois].join(' '),
      others,
    ])
    if (n % 25 === 0) console.log(`  ${n} / ${people.size}`)
  }
  const order = { affiliation: 0, likely: 1, 'one-hit': 2, several: 3, none: 4 }
  const body = rows.slice(1).sort((a, b) => order[a[1]] - order[b[1]] || b[9] - a[9])
  fs.mkdirSync('import-out', { recursive: true })
  const out = path.join('import-out', 'orcid-candidates.csv')
  fs.writeFileSync(out, `${[rows[0], ...body].map(r => r.map(csvCell).join(',')).join('\n')}\n`)
  console.log(`\nORCID lookup for ${people.size} people:`)
  console.log(`${String(counts.affiliation).padStart(4)}  affiliation  best fit shares an institution with the DOI`)
  console.log(`${String(counts.likely).padStart(4)}  likely       best fit by French Polynesia / topic of their works`)
  console.log(`${String(counts['one-hit']).padStart(4)}  one-hit      one person with that name, no shared institution (check)`)
  console.log(`${String(counts.several).padStart(4)}  several      several people with that name (check)`)
  console.log(`${String(counts.none).padStart(4)}  none         not found`)
  console.log(`\n${out}  (use = yes on ${rows.slice(1).filter(r => r[0] === 'yes').length} strong matches; "why" says what matched; change use as you like, save as CSV)`)
  console.log('Nothing was changed anywhere.')
}

main().catch(e => {
  console.error(`LOOKUP FAILED: ${e.message}`)
  process.exit(1)
})
