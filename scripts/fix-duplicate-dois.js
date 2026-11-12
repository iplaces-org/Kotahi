#!/usr/bin/env node
/* iplaces: clean up DOIs that the Gump migration duplicated.
 *
 * The migration meant to update the old 10.17913 DOIs, but Kotahi builds the
 * DOI from the station's prefix (10.60950), so it minted a second DOI for the
 * same record (e.g. 10.17913/100501.9190 -> DataCite Commons, and
 * 10.60950/100501.9190 -> iplacesalliance.org/gumpstation/articles/8).
 * A findable DOI can't be deleted. The fix makes the two records match: the
 * OLD DOI gets a copy of the NEW DOI's metadata (titles, creators, related
 * identifiers, dates, ...), the same iPlaces landing page, and
 * "IsIdenticalTo <new DOI>". The new (10.60950) DOI is not touched here
 * (Kotahi manages it); add "IsIdenticalTo <old DOI>" to the record's Related
 * identifiers and republish it so the link goes both ways.
 * Run this AFTER the record has been republished, so the copy is current.
 * --links-only: change only the old DOI's url and add IsIdenticalTo.
 *
 * Pairs are found two ways, within the iPlaces DataCite repository:
 *   suffix  the same suffix under both prefixes (certain)
 *   title   same title (case/space-insensitive), old DOI not on iplacesalliance.org,
 *           new DOI on iplacesalliance.org; only 1-to-1 matches are offered
 *
 * Usage (from ~/Kotahi):
 *   node scripts/fix-duplicate-dois.js                      dry run: lists pairs, changes nothing
 *   node scripts/fix-duplicate-dois.js --apply --only 10.17913/100501.9190
 *   node scripts/fix-duplicate-dois.js --apply              fix every pair the dry run listed as "will fix"
 * --apply needs DATACITE_LOGIN and DATACITE_PASSWORD (the iPlaces repository login).
 * Add --suffix-only to ignore title matches. Requires Node 18+.
 */
/* eslint-disable no-console, no-await-in-loop, no-restricted-syntax */
const API = 'https://api.datacite.org'
const CLIENT = 'sjyq.omytlw'
const OLD = '10.17913'
const NEW = '10.60950'
const SKIP_PUBLISHERS = ['Tetiaroa Society'] // these move to baileystation in place (import-datacite-dois.js)

const args = process.argv.slice(2)
const apply = args.includes('--apply')
const suffixOnly = args.includes('--suffix-only')
const linksOnly = args.includes('--links-only')
const only = []
const i = args.indexOf('--only')
if (i >= 0) for (let j = i + 1; j < args.length && !args[j].startsWith('--'); j += 1) only.push(args[j].toLowerCase())

const norm = s => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim()
const suffixOf = doi => doi.toLowerCase().split('/').slice(1).join('/')
const titleOf = a => norm(((a.titles || []).find(t => !t.titleType) || (a.titles || [])[0] || {}).title)
const pubOf = a => (typeof a.publisher === 'object' && a.publisher ? a.publisher.name : a.publisher) || ''
const onIplaces = url => /^https:\/\/iplacesalliance\.org\//.test(url || '')

const listPrefix = async prefix => {
  const out = []
  let url = `${API}/dois?client-id=${CLIENT}&prefix=${prefix}&publisher=true&page[size]=500&page[number]=1&fields[dois]=doi,url,titles,publisher,publicationYear,relatedIdentifiers,state`
  while (url) {
    const r = await fetch(url, { headers: { Accept: 'application/vnd.api+json' } })
    if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`)
    const page = await r.json()
    out.push(...page.data.map(d => ({ ...d.attributes, doi: d.attributes.doi.toLowerCase() })))
    url = page.links && page.links.next
  }
  return out
}

const main = async () => {
  if (apply && !(process.env.DATACITE_LOGIN && process.env.DATACITE_PASSWORD))
    throw new Error('--apply needs DATACITE_LOGIN and DATACITE_PASSWORD')

  const [olds, news] = await Promise.all([listPrefix(OLD), listPrefix(NEW)])
  console.log(`${olds.length} DOIs under ${OLD}, ${news.length} under ${NEW}\n`)

  const newBySuffix = new Map(news.map(n => [suffixOf(n.doi), n]))
  const newByTitle = new Map()
  for (const n of news.filter(x => onIplaces(x.url))) {
    const t = titleOf(n)
    if (t) newByTitle.set(t, [...(newByTitle.get(t) || []), n])
  }
  const oldTitleCount = new Map()
  for (const o of olds) oldTitleCount.set(titleOf(o), (oldTitleCount.get(titleOf(o)) || 0) + 1)

  const pairs = []
  const review = []
  for (const o of olds) {
    if (onIplaces(o.url)) continue
    let n = newBySuffix.get(suffixOf(o.doi))
    let how = 'suffix'
    if (!n && !suffixOnly) {
      const cands = newByTitle.get(titleOf(o)) || []
      if (cands.length === 1 && oldTitleCount.get(titleOf(o)) === 1) [n] = cands
      else if (cands.length) review.push(`${o.doi}  "${titleOf(o)}"  matches ${cands.map(c => c.doi).join(', ')} (not 1-to-1, left alone)`)
      how = 'title'
    }
    if (!n) continue
    if (SKIP_PUBLISHERS.includes(pubOf(o))) {
      review.push(`${o.doi}  publisher ${pubOf(o)}  has a twin ${n.doi} (${n.url}); left alone, decide before the Bailey import`)
      continue
    }
    const already = (o.relatedIdentifiers || []).some(r => r.relationType === 'IsIdenticalTo' && String(r.relatedIdentifier).toLowerCase() === n.doi)
    pairs.push({ o, n, how, done: already && o.url === n.url })
  }

  for (const p of pairs) {
    const tag = p.done ? 'already fixed' : 'will fix'
    console.log(`${tag}  [${p.how}]  ${p.o.doi}  ->  ${p.n.url}   (twin ${p.n.doi})\n          "${titleOf(p.o)}" ${p.o.publicationYear} / "${titleOf(p.n)}" ${p.n.publicationYear}`)
  }
  if (review.length) console.log(`\nNeeds a look (not changed):\n${review.map(r => `  ${r}`).join('\n')}`)
  if (!pairs.length) console.log('No duplicate pairs found.')

  if (!apply) {
    console.log('\nDRY RUN: nothing changed at DataCite.')
    return
  }

  const auth = `Basic ${Buffer.from(`${process.env.DATACITE_LOGIN}:${process.env.DATACITE_PASSWORD}`).toString('base64')}`
  for (const p of pairs.filter(x => !x.done && (!only.length || only.includes(x.o.doi)))) {
    const isTwinLink = doi => r => r.relationType === 'IsIdenticalTo' && String(r.relatedIdentifier).toLowerCase() === doi
    let attributes
    if (linksOnly) {
      attributes = {
        url: p.n.url,
        relatedIdentifiers: [
          ...(p.o.relatedIdentifiers || []).filter(r => !isTwinLink(p.n.doi)(r)),
          { relatedIdentifier: p.n.doi, relatedIdentifierType: 'DOI', relationType: 'IsIdenticalTo' },
        ],
      }
    } else {
      const fr = await fetch(`${API}/dois/${p.n.doi}`, { headers: { Accept: 'application/vnd.api+json' } })
      if (!fr.ok) { console.log(`FAILED ${p.o.doi}: could not read ${p.n.doi} (HTTP ${fr.status})`); continue }
      const src = (await fr.json()).data.attributes
      const COPY = ['titles', 'creators', 'publisher', 'publicationYear', 'subjects', 'contributors', 'dates', 'language', 'types', 'alternateIdentifiers', 'sizes', 'formats', 'version', 'rightsList', 'descriptions', 'geoLocations', 'fundingReferences', 'relatedItems']
      attributes = { url: p.n.url }
      for (const k of COPY) if (src[k] !== undefined && src[k] !== null) attributes[k] = src[k]
      attributes.relatedIdentifiers = [
        ...(src.relatedIdentifiers || []).filter(r => !isTwinLink(p.o.doi)(r) && !isTwinLink(p.n.doi)(r)),
        { relatedIdentifier: p.n.doi, relatedIdentifierType: 'DOI', relationType: 'IsIdenticalTo' },
      ]
    }
    const r = await fetch(`${API}/dois/${p.o.doi}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/vnd.api+json', Accept: 'application/vnd.api+json', Authorization: auth },
      body: JSON.stringify({ data: { type: 'dois', attributes } }),
    })
    const body = await r.json().catch(() => ({}))
    if (!r.ok) console.log(`FAILED ${p.o.doi}: HTTP ${r.status} ${JSON.stringify(body.errors || body)}`)
    else console.log(`fixed ${p.o.doi}: url now ${body.data.attributes.url}${linksOnly ? '' : `, metadata copied from ${p.n.doi}`}`)
  }
}

main().catch(e => {
  console.error(`FAILED: ${e.message}`)
  process.exit(1)
})
