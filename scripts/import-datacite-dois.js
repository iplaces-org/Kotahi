#!/usr/bin/env node
/* iplaces: import existing DataCite DOIs as draft records in one station.
 *
 * Written for the Tetiaroa Society DOIs (prefix 10.17913, publisher
 * "Tetiaroa Society", in the iPlaces DataCite repository SJYQ.OMYTLW) going
 * into the baileystation group, but works for any prefix/publisher/group.
 *
 * What it does:
 *   1. Lists the DOIs at DataCite (public REST API, no login).
 *   2. Maps each one onto the iPlaces form fields, keeping the same DOI in
 *      submission.$doi so that Publish later UPDATES that DOI in place
 *      (new landing URL + metadata from iPlaces) instead of minting a new one.
 *   3. --write: creates each record as an unsubmitted draft in the group
 *      (createSubmission + updateManuscript, like the New submission page). Nothing is published and DataCite is NOT touched.
 *
 * DataCite is only changed later, when a record is published (Publish
 * button, or server-fix/scripts/republish.sh <group> --first <shortId>...).
 * For that the group's DataCite settings must use the repository that owns
 * the DOIs and the DOI's own prefix (10.17913), because Kotahi builds the
 * DOI as <configured prefix>/<suffix of $doi>.
 *
 * Usage (from ~/Kotahi):
 *   node scripts/import-datacite-dois.js                 dry run: writes import-out/<time>/ report, creates nothing
 *   node scripts/import-datacite-dois.js --write         create the drafts (needs KOTAHI_TOKEN)
 *   node scripts/import-datacite-dois.js --write --only 10.17913/f3g6g ...   just these DOIs
 *
 * Options:
 *   --group NAME        target group (default baileystation)
 *   --prefix P          DOI prefix (default 10.17913)
 *   --client ID         DataCite repository id (default sjyq.omytlw)
 *   --publisher NAME    keep only DOIs with this publisher (default "Tetiaroa Society")
 *   --skip DOI,DOI      leave these out (default 10.17913/f3/9999.9999, a placeholder)
 *   --only DOI ...      import only these DOIs (space or comma separated)
 *   --topics, --place, --data-policy, --license   station defaults (see DEFAULTS)
 *   --station-publisher  send the station as publisher instead of DataCite's
 *   --refresh           with --write: re-send the mapping to drafts this script
 *                       already created (fixes them after a script change);
 *                       published records are left alone
 *   --server URL        Kotahi server (default https://iplaces-test-server.fly.dev)
 *
 * Safe to re-run: DOIs already imported (import-out/imported-<group>.json)
 * are skipped. Requires Node 18+.
 */
/* eslint-disable no-console, no-await-in-loop, no-restricted-syntax */
const crypto = require('crypto')
const fs = require('fs')
const path = require('path')

const DEFAULTS = {
  group: 'baileystation',
  prefix: '10.17913',
  client: 'sjyq.omytlw',
  publisher: 'Tetiaroa Society',
  // 9999.9999 is a placeholder. The three Moorea projects belong at Gump, not
  // Bailey (Erin 2026-11-12); import them with --group gumpstation --only ...
  skip: ['10.17913/f3/9999.9999', '10.17913/f30592', '10.17913/f33w2k', '10.17913/f3/100501.40152'],
  server: 'https://iplaces-test-server.fly.dev',
  // Station defaults for every imported record (Erin 2026-11-12, Tetiaroa):
  topics: ['Research'],
  place: 'Tetiʻaroa', // with the ʻeta (U+02BB)
  dataPolicy: 'yes', // submission.datacode, Field Station Data Policy Agreement
  license: 'CC-BY-4.0', // used when DataCite has no licence; an existing licence is kept
}

const parseArgs = argv => {
  const o = { ...DEFAULTS, write: false, only: [] }
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    const next = () => argv[++i] // eslint-disable-line no-plusplus
    if (a === '--write') o.write = true
    else if (a === '--group') o.group = next()
    else if (a === '--prefix') o.prefix = next()
    else if (a === '--client') o.client = next()
    else if (a === '--publisher') o.publisher = next()
    else if (a === '--server') o.server = next().replace(/\/$/, '')
    else if (a === '--topics') o.topics = next().split(',').map(t => t.trim()).filter(Boolean)
    else if (a === '--place') o.place = next()
    else if (a === '--data-policy') o.dataPolicy = next()
    else if (a === '--license') o.license = next()
    else if (a === '--station-publisher') o.stationPublisher = true
    else if (a === '--refresh') o.refresh = true
    else if (a === '--skip') o.skip = next().split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
    else if (a === '--only') {
      while (argv[i + 1] && !argv[i + 1].startsWith('--')) o.only.push(...next().split(','))
    } else throw new Error(`unknown option ${a}`)
  }
  o.only = o.only.map(s => s.trim().toLowerCase()).filter(Boolean)
  o.skip = o.skip.map(s => s.toLowerCase())
  return o
}

/* ---------------- helpers ---------------- */
const uuid = () => crypto.randomUUID()
const str = v => (v == null ? '' : String(v)).trim()
const escapeHtml = s =>
  str(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
// DataCite descriptions are plain text; keep paragraph breaks.
const toParagraphs = text =>
  str(text)
    .split(/\n\s*\n/)
    .map(p => p.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .map(p => `<p class="paragraph">${escapeHtml(p)}</p>`)
    .join('')
const bareOrcid = s => str(s).replace(/^https?:\/\/orcid\.org\//i, '')
const rorUrl = s => {
  const v = str(s)
  if (!v) return ''
  if (/ror\.org\//i.test(v)) return v.replace(/^http:/i, 'https:')
  if (/^0[a-z0-9]{8}$/i.test(v)) return `https://ror.org/${v}`
  return ''
}

const splitName = name => {
  const n = str(name)
  if (!n) return { firstName: '', lastName: '' }
  if (n.includes(',')) {
    const [last, ...first] = n.split(',')
    return { firstName: first.join(',').trim(), lastName: last.trim() }
  }
  const parts = n.split(/\s+/)
  if (parts.length === 1) return { firstName: '', lastName: parts[0] }
  return { firstName: parts.slice(0, -1).join(' '), lastName: parts[parts.length - 1] }
}

// DataCite affiliation (string or {name, affiliationIdentifier}) -> form {label, value}
const toAffiliation = a => {
  if (!a) return null
  if (typeof a === 'string') return { label: a.trim(), value: a.trim() }
  const label = str(a.name)
  if (!label) return null
  const ror = /ror/i.test(str(a.affiliationIdentifierScheme)) ? rorUrl(a.affiliationIdentifier) : rorUrl(a.affiliationIdentifier)
  return { label, value: ror || label }
}

const orcidOf = person =>
  bareOrcid(
    ((person.nameIdentifiers || []).find(n => /orcid/i.test(str(n.nameIdentifierScheme))) || {})
      .nameIdentifier,
  )

const rorOfOrg = org => {
  const id = (org.nameIdentifiers || []).find(n => /ror/i.test(str(n.nameIdentifierScheme)))
  return id ? rorUrl(id.nameIdentifier) : ''
}

// DataCite lower-cases SPDX ids; the form's Rights options use the SPDX case.
const SPDX_CASE = Object.fromEntries(
  ['CC-BY-4.0', 'CC-BY-SA-4.0', 'CC-BY-NC-4.0', 'CC-BY-NC-SA-4.0', 'CC-BY-ND-4.0', 'CC-BY-NC-ND-4.0', 'CC0-1.0'].map(x => [x.toLowerCase(), x]),
)

// Some old Tetiaroa DOIs list the same person several times (e.g. f3mw27
// has each Institut Louis Malardé member 2-4 times). Keep the first of each.
const dedupe = (rows, keyOf) => {
  const seen = new Set()
  return rows.filter(r => {
    const k = keyOf(r)
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
}
const lc = v => str(v).toLowerCase()

/* ---------------- DataCite -> submission ---------------- */
const mapRecord = (attrs, group, defaults = DEFAULTS) => {
  const warnings = []
  const a = attrs

  // creators -> $authors (people). Kotahi's serializer needs a first AND last
  // name for every author, or Publish fails, so anything else is reported.
  const $authors = []
  for (const c of a.creators || []) {
    const organizational = str(c.nameType) === 'Organizational'
    let firstName = str(c.givenName)
    let lastName = str(c.familyName)
    if (!firstName && !lastName && !organizational) ({ firstName, lastName } = splitName(c.name))
    if (organizational || !firstName || !lastName) {
      if (/^group,?$/i.test(str(c.name))) continue // placeholder creator in the old Tetiaroa records
      warnings.push(`creator "${str(c.name)}" left out (${organizational ? 'organisation' : 'no first + last name'}); Publish needs both names`)
      continue
    }
    $authors.push({
      id: uuid(),
      firstName,
      middleName: '',
      lastName,
      email: '',
      orcid: orcidOf(c),
      ror: (c.affiliation || []).map(toAffiliation).filter(Boolean),
    })
  }
  const authorCount = $authors.length
  $authors.splice(0, $authors.length, ...dedupe($authors, x => `${lc(x.firstName)}|${lc(x.lastName)}`))
  if ($authors.length < authorCount) warnings.push(`${authorCount - $authors.length} repeated creator(s) dropped`)
  if (!$authors.length) warnings.push('NO AUTHORS: Publish will refuse this record until one is added')

  // contributors -> ContributorsInput rows
  const contributors = (a.contributors || [])
    .map(c => {
      const contributorType = str(c.contributorType) || 'Other'
      if (str(c.nameType) === 'Organizational' || (!c.givenName && !c.familyName && c.nameType !== 'Personal')) {
        const affil = (c.affiliation || []).map(toAffiliation).filter(Boolean)[0]
        const value = rorOfOrg(c) || (affil && affil.label === str(c.name) ? affil.value : '') || str(c.name)
        return { id: uuid(), contributorType, nameType: 'Organizational', organization: { label: str(c.name), value } }
      }
      let givenName = str(c.givenName)
      let familyName = str(c.familyName)
      if (!givenName && !familyName) ({ firstName: givenName, lastName: familyName } = splitName(c.name))
      return {
        id: uuid(),
        contributorType,
        nameType: 'Personal',
        givenName,
        familyName,
        orcid: orcidOf(c),
        affiliation: (c.affiliation || []).map(toAffiliation).filter(Boolean),
      }
    })
    .filter(r => (r.organization ? r.organization.label : r.givenName || r.familyName))
  const contributorCount = contributors.length
  contributors.splice(0, contributors.length, ...dedupe(contributors, r =>
    `${r.contributorType}|${r.organization ? lc(r.organization.label) : `${lc(r.givenName)}|${lc(r.familyName)}`}`))
  if (contributors.length < contributorCount) warnings.push(`${contributorCount - contributors.length} repeated contributor(s) dropped`)

  // descriptions -> $abstract (all of them, in order)
  const descs = (a.descriptions || []).filter(d => str(d.description))
  const $abstract = descs.map(d => toParagraphs(d.description)).join('')
  if (descs.some(d => str(d.descriptionType) && !/abstract/i.test(d.descriptionType)))
    warnings.push(`description type ${[...new Set(descs.map(d => d.descriptionType))].join('/')} will be sent as Abstract`)

  // dates
  const dates = a.dates || []
  const issued = dates.find(d => /issued/i.test(str(d.dateType)))
  const isoish = v => (/^\d{4}(-\d{2}(-\d{2})?)?$/.test(str(v)) ? str(v) : '')
  const datePublished = isoish(issued && issued.date) || str(a.publicationYear)
  const coverage = dates.find(d => /coverage/i.test(str(d.dateType)))
  const dropped = dates.filter(d => !/issued|coverage/i.test(str(d.dateType)))
  if (dropped.length) warnings.push(`dates not carried over: ${dropped.map(d => `${d.dateType} ${d.date}`).join(', ')}`)

  // geolocation (place names only; iPlaces sends geoLocationPlace)
  const places = (a.geoLocations || []).map(g => str(g.geoLocationPlace)).filter(Boolean)
  if ((a.geoLocations || []).some(g => g.geoLocationPoint || g.geoLocationBox || g.geoLocationPolygon))
    warnings.push('geoLocation points/boxes not carried over (iPlaces sends place names only)')
  if (defaults.place && places.length && places.join('; ') !== defaults.place)
    warnings.push(`place "${places.join('; ')}" replaced by "${defaults.place}"`)

  // related identifiers
  const relatedIdentifiers = dedupe(
    (a.relatedIdentifiers || []).filter(r => str(r.relatedIdentifier) && r.relatedIdentifierType && r.relationType),
    r => `${lc(r.relatedIdentifier)}|${r.relationType}`,
  )
    .map(r => ({
      id: uuid(),
      relatedIdentifier: str(r.relatedIdentifier),
      relatedIdentifierType: r.relatedIdentifierType,
      relationType: r.relationType,
      ...(r.resourceTypeGeneral ? { resourceTypeGeneral: r.resourceTypeGeneral } : {}),
      ...(r.relationTypeInformation ? { relationTypeInformation: r.relationTypeInformation } : {}),
    }))

  // funding
  // "X and Y" in one funderName is two funders (Erin 2026-11-12). The ROR id
  // goes to the part that names its organisation (Tetiaroa Society), else to
  // the first part.
  const fundingReferences = []
  for (const f of (a.fundingReferences || []).filter(x => str(x.funderName))) {
    const ror = rorUrl(f.funderIdentifier)
    const parts = str(f.funderName).split(/\s+(?:and|&)\s+/i).map(x => x.trim()).filter(Boolean)
    if (parts.length > 1) warnings.push(`funder "${str(f.funderName)}" split into ${parts.map(x => `"${x}"`).join(' + ')}`)
    const rorOwner = ror && ror.endsWith('04p8xrf95') ? parts.findIndex(x => /tetiaroa society/i.test(x)) : -1
    parts.forEach((name, k) => {
      const hasRor = ror && (rorOwner >= 0 ? k === rorOwner : k === 0)
      fundingReferences.push({
        id: uuid(),
        funder: { label: name, value: hasRor ? ror : name },
        // award details stay with the first funder
        awardNumber: k === 0 ? str(f.awardNumber) : '',
        awardTitle: k === 0 ? str(f.awardTitle) : '',
        awardUri: k === 0 ? str(f.awardUri) : '',
      })
    })
  }
  if ((a.fundingReferences || []).some(f => str(f.funderIdentifier) && !rorUrl(f.funderIdentifier)))
    warnings.push('a non-ROR funder identifier (e.g. Crossref Funder ID) is not carried over')

  // titles
  const titles = a.titles || []
  const main = titles.find(t => !t.titleType) || titles[0] || {}
  const extraTitles = titles
    .filter(t => t !== main && str(t.title))
    .map(t => ({ id: uuid(), title: str(t.title), titleType: t.titleType || 'AlternativeTitle', lang: str(t.lang) }))

  // rights: only SPDX identifiers map onto the licence field; never invent one.
  // A Local Contexts Hub project link becomes the record's Local Contexts
  // project, which Publish re-fetches from the Hub (Patch 11/12), so its
  // Notices and Labels carry over; the stored notice is the fallback.
  const LC_RE = /localcontextshub\.org\/projects\/([0-9a-f-]{36})/i
  const lcRows = (a.rightsList || []).filter(r => LC_RE.test(str(r.rightsUri)))
  let $localContext = null
  if (lcRows.length) {
    const [, projectId] = str(lcRows[0].rightsUri).match(LC_RE)
    $localContext = {
      id: projectId,
      url: `https://localcontextshub.org/projects/${projectId}`,
      notice: lcRows.map(r => {
        const text = str(r.rights)
        const m = text.match(/^Local Contexts (.+?) Notice(?:\s+https?:\/\/\S+?)?:\s*(.*)$/s)
        const kind = m ? m[1].replace(/\s*\(.*\)$/, '').toLowerCase() : 'notice'
        return { noticeType: kind === 'biocultural' || kind === 'bc' ? 'biocultural' : kind, defaultText: m ? m[2] : text }
      }),
      label: [],
    }
  }
  const spdx = (a.rightsList || [])
    .filter(r => !LC_RE.test(str(r.rightsUri)))
    .map(r => str(r.rightsIdentifier))
    .filter(id => id && !/local contexts/i.test(id))
    .map(id => SPDX_CASE[id.toLowerCase()] || id)
  if ((a.rightsList || []).some(r => !LC_RE.test(str(r.rightsUri)) && !str(r.rightsIdentifier)))
    warnings.push('a rights statement without an SPDX id is not carried over')
  if (spdx.length && defaults.license && !spdx.some(x => x.toLowerCase() === defaults.license.toLowerCase()))
    warnings.push(`kept the licence DataCite already has (${spdx.join(', ')}), not ${defaults.license}`)

  const subjects = (a.subjects || []).map(s => str(s.subject)).filter(Boolean)
  const altIds = (a.alternateIdentifiers || [])
    .filter(x => str(x.alternateIdentifier))
    .map(x => ({ id: uuid(), alternateIdentifier: str(x.alternateIdentifier), alternateIdentifierType: str(x.alternateIdentifierType) }))

  const publisherName = typeof a.publisher === 'object' && a.publisher ? str(a.publisher.name) : str(a.publisher)
  const publisherRor = typeof a.publisher === 'object' && a.publisher ? rorUrl(a.publisher.publisherIdentifier) : ''

  const submission = {
    $title: str(main.title),
    $abstract,
    $authors,
    $doi: str(a.doi).toLowerCase(),
    resourcetype: str(a.types && a.types.resourceTypeGeneral) || 'Other',
    ...(a.types && str(a.types.resourceType) && a.types.resourceType !== a.types.resourceTypeGeneral
      ? { ifother: str(a.types.resourceType) }
      : {}),
    // --station-publisher: leave publisher empty so the station's own name is sent
    ...(defaults.stationPublisher ? {} : { publisher: { label: publisherName, value: publisherRor || publisherName } }),
    publicationYear: str(a.publicationYear),
    datePublished,
    ...(coverage ? { coverageDate: str(coverage.date) } : {}),
    geolocation: defaults.place || places.join('; '),
    topics: defaults.topics || [],
    ...(defaults.dataPolicy ? { datacode: defaults.dataPolicy } : {}),
    ...(subjects.length ? { keywords: subjects.join(', ') } : {}),
    ...(contributors.length ? { contributors } : {}),
    ...(relatedIdentifiers.length ? { relatedIdentifiers } : {}),
    ...(fundingReferences.length ? { fundingReferences: dedupe(fundingReferences, f => lc(f.funder.label)) } : {}),
    ...(extraTitles.length ? { titles: extraTitles } : {}),
    ...(altIds.length ? { alternateIdentifiers: altIds } : {}),
    ...(spdx.length || defaults.license ? { license: spdx.length ? spdx : [defaults.license] } : {}),
    ...($localContext ? { $localContext } : {}),
    ...(str(a.language) ? { language: str(a.language) } : {}),
    ...(str(a.version) ? { version: str(a.version) } : {}),
    $importedFrom: {
      source: 'DataCite',
      doi: str(a.doi).toLowerCase(),
      previousUrl: str(a.url),
      registered: str(a.registered),
      group,
    },
  }

  if (!submission.$title) warnings.push('NO TITLE')
  return { submission, warnings }
}

/* ---------------- network ---------------- */
const getJson = async (url, opts = {}) => {
  const r = await fetch(url, { ...opts, headers: { Accept: 'application/vnd.api+json', ...(opts.headers || {}) } })
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`)
  return r.json()
}

const listDois = async o => {
  const out = []
  let url =
    `https://api.datacite.org/dois?client-id=${encodeURIComponent(o.client)}` +
    `&prefix=${encodeURIComponent(o.prefix)}&affiliation=true&publisher=true` +
    `&page[size]=100&page[number]=1`
  while (url) {
    const page = await getJson(url)
    out.push(...page.data)
    url = page.links && page.links.next
  }
  return out
}

const gql = async (o, token, query, variables) => {
  const headers = { 'Content-Type': 'application/json' }
  if (token) headers.Authorization = `Bearer ${token}`
  if (o.groupId) headers['group-id'] = o.groupId
  const r = await fetch(`${o.server}/graphql`, { method: 'POST', headers, body: JSON.stringify({ query, variables }) })
  const json = await r.json()
  if (json.errors) throw new Error(`GraphQL: ${json.errors.map(e => e.message).join('; ')}`)
  return json.data
}

// Kotahi 2026.11.03: createManuscript is gone. A record is created the way
// the New submission page does it (createSubmission, no file), then filled
// with updateManuscript, as the editor form does.
const CREATE = `mutation ($groupId: ID!) { createSubmission(groupId: $groupId) { id } }`
const UPDATE = `mutation ($id: ID!, $input: String) { updateManuscript(id: $id, input: $input) { id } }`
const SHORT_ID = `query ($id: ID!) { manuscript(id: $id) { id shortId } }`

/* ---------------- main ---------------- */
const main = async () => {
  const o = parseArgs(process.argv.slice(2))
  const token = process.env.KOTAHI_TOKEN
  if (o.write && !token) throw new Error('--write needs KOTAHI_TOKEN (see cms-sync: copy(localStorage.getItem("token")) in the browser console)')

  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const outDir = path.join('import-out', stamp)
  fs.mkdirSync(path.join(outDir, 'records'), { recursive: true })
  const statePath = path.join('import-out', `imported-${o.group}.json`)
  const state = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, 'utf8')) : {}

  const { groups } = await gql(o, null, '{ groups { id name } }')
  const group = groups.find(g => g && g.name === o.group)
  if (!group) throw new Error(`no group "${o.group}" on ${o.server}`)
  o.groupId = group.id

  console.log(`DataCite: repository ${o.client}, prefix ${o.prefix}, publisher "${o.publisher}"`)
  const all = await listDois(o)
  const wanted = all.filter(d => {
    const at = d.attributes
    const pub = typeof at.publisher === 'object' && at.publisher ? at.publisher.name : at.publisher
    const doi = str(at.doi).toLowerCase()
    if (o.only.length) return o.only.includes(doi)
    return str(pub) === o.publisher && !o.skip.includes(doi)
  })
  const otherPublishers = {}
  for (const d of all) {
    const at = d.attributes
    const pub = str(typeof at.publisher === 'object' && at.publisher ? at.publisher.name : at.publisher)
    if (pub !== o.publisher) otherPublishers[pub] = (otherPublishers[pub] || 0) + 1
  }
  console.log(`${all.length} DOIs under ${o.prefix}; ${wanted.length} to import into ${o.group}` +
    (Object.keys(otherPublishers).length ? ` (left out, other publishers: ${Object.entries(otherPublishers).map(([k, v]) => `${k} ${v}`).join(', ')})` : ''))

  const rows = [['doi', 'title', 'year', 'type', 'authors', 'current_url', 'state', 'result', 'warnings']]
  let created = 0
  let skipped = 0
  for (const d of wanted) {
    const at = d.attributes
    const doi = str(at.doi).toLowerCase()
    const { submission, warnings } = mapRecord(at, o.group, o)
    fs.writeFileSync(path.join(outDir, 'records', `${doi.replace(/[^a-z0-9.]+/g, '_')}.json`), JSON.stringify({ datacite: at, submission, warnings }, null, 2))

    let result = 'dry run'
    if (state[doi] && o.write && o.refresh) {
      const cur = (await gql(o, token, `query ($id: ID!) { manuscript(id: $id) { id status } }`, { id: state[doi].id })).manuscript
      if (!cur) result = `short id ${state[doi].shortId} not found, not refreshed`
      else if (cur.status === 'published') result = `short id ${state[doi].shortId} is published, not refreshed`
      else {
        await gql(o, token, UPDATE, { id: state[doi].id, input: JSON.stringify({ submission }) })
        result = `refreshed short id ${state[doi].shortId}`
      }
      skipped += 1
    } else if (state[doi]) {
      result = `already imported (short id ${state[doi].shortId})`
      skipped += 1
    } else if (o.write) {
      const { id } = (await gql(o, token, CREATE, { groupId: group.id })).createSubmission
      await gql(o, token, UPDATE, { id, input: JSON.stringify({ submission }) })
      const m = (await gql(o, token, SHORT_ID, { id })).manuscript
      state[doi] = { id: m.id, shortId: m.shortId, title: submission.$title, at: new Date().toISOString() }
      fs.writeFileSync(statePath, JSON.stringify(state, null, 2))
      result = `created short id ${m.shortId}`
      created += 1
    }
    console.log(`${doi}  ${result}${warnings.length ? `  (${warnings.length} warning${warnings.length > 1 ? 's' : ''})` : ''}`)
    rows.push([doi, submission.$title, submission.publicationYear, submission.resourcetype, submission.$authors.length, at.url, at.state, result, warnings.join(' | ')])
  }

  const csv = rows.map(r => r.map(v => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`).join(',')).join('\n')
  fs.writeFileSync(path.join(outDir, 'report.csv'), `${csv}\n`)
  const shortIds = Object.values(state).map(s => s.shortId).sort((x, y) => x - y)
  console.log(`\nreport: ${path.join(outDir, 'report.csv')}  (mapped records in ${path.join(outDir, 'records')})`)
  if (o.write) {
    console.log(`created ${created}, already there ${skipped}. Imported short ids in ${o.group}: ${shortIds.join(' ')}`)
    console.log('Nothing is published and DataCite is unchanged.')
    if (shortIds.length) {
      console.log('\nTo publish the first one later (changes its real DOI):')
      console.log(`bash server-fix/scripts/republish.sh ${o.group} --first ${shortIds[0]}`)
      for (let k = 1; k < shortIds.length; k += 10)
        console.log(`then: bash server-fix/scripts/republish.sh ${o.group} --first ${shortIds.slice(k, k + 10).join(' ')}`)
    }
  } else console.log('DRY RUN: nothing created. Re-run with --write to create the drafts.')
}

if (require.main === module) {
  main().catch(e => {
    console.error(`IMPORT FAILED: ${e.message}`)
    process.exit(1)
  })
}

module.exports = { mapRecord, splitName, parseArgs }
