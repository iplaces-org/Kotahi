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
 *      On baileystation every person (creators and Personal contributors) is
 *      a creator, the only contributor is Bailey Station (Tetiaroa Society
 *      ROR) and the publisher is "Bailey Station" (STATIONS below). Missing
 *      ORCIDs are filled from another iPlaces DOI with exactly the same name
 *      (Gump's 10.60950 records included); ALL-CAPS / lower-case names are
 *      tidied. Every run writes analysis.txt listing what was changed or
 *      needs a look.
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

// Per-station publisher and contributor (Erin 2026-11-12): on Bailey every
// imported record gets publisher "Bailey Station" and ONE organisational
// contributor, Bailey Station with the Tetiaroa Society ROR; every person is
// a creator. Other organisational contributors (Tetiaroa Society Ecostation,
// UC Berkeley, ...) are replaced and listed in analysis.txt.
const STATIONS = {
  baileystation: {
    publisher: { label: 'Bailey Station', value: 'https://ror.org/04p8xrf95' },
    contributor: { name: 'Bailey Station', ror: 'https://ror.org/04p8xrf95', type: 'Sponsor' },
  },
}
// Where to look for ORCIDs of people whose old DOI has none: every DOI in
// the iPlaces repository under these prefixes (Gump's published records are
// under 10.60950). Only an exact full-name match with ONE ORCID is used.
const ORCID_PREFIXES = ['10.17913', '10.60950']

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

// "BOSSIN" -> "Bossin", "eric" -> "Eric", "MATHIEU-DAUDE" -> "Mathieu-Daude".
// Only a name part that is ALL capitals or all lower case is changed.
const tidyCase = v => {
  const t = str(v)
  if (!/\p{L}/u.test(t) || (t !== t.toUpperCase() && t !== t.toLowerCase())) return t
  if (t.length <= 2 && t === t.toUpperCase()) return t // initials such as "JM"
  return t.toLowerCase().replace(/(^|[\s\-'’.])(\p{L})/gu, (m, sep, ch) => sep + ch.toUpperCase())
}
const nameKey = (first, last) =>
  `${first} ${last}`.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z]+/g, '') // "Jean Yves"/"Jean-Yves", "DeVore"/"De Vore" match
const looksLikeEmail = (...parts) => parts.some(x => /@|\.(fr|com|org|net|edu|pf)\b/i.test(str(x)))
// Known bad names in the old records -> the real name (Erin 2026-11-12)
const NAME_FIXES = {
  'gachecamille|hotmail.fr': { firstName: 'Camille', lastName: 'Gache' }, // 10.17913/f3/100501.32207
  'guillaume.molle|upf.pf': { firstName: 'Guillaume', lastName: 'Molle' }, // 10.17913/f3/100501.30664
  // Tetiaroa Society's own site spells it Marijn Van der Helm (Erin 2026-11-12)
  'martijn|van der helm': { firstName: 'Marijn', lastName: 'Van der Helm' }, // 36094
  'martin|van der helm': { firstName: 'Marijn', lastName: 'Van der Helm' }, // 33746
  // Erin 2026-11-12
  'araceli|samaniego': { firstName: 'Araceli', lastName: 'Samaniego Herrera', orcid: '0000-0001-7182-3790' }, // 36429
  'araceli|samaniego-herrera': { firstName: 'Araceli', lastName: 'Samaniego Herrera', orcid: '0000-0001-7182-3790' }, // 33958
  'jael|galichet': { firstName: 'Jaël', lastName: 'Galichet' }, // 45460
}
// Organisations or titles that the old system typed as people
// ("Te Mana O Te Moana" is a title, Erin 2026-11-12)
const ORG_AS_PERSON = /\b(te mana o te moana|society|association|institut|institute|university|universit[eé]|station|ecostation|foundation|fondation|ministry|minist[eè]re|group|team)\b/i

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

  // People -> $authors. Every person is a creator (Erin 2026-11-12): the
  // DataCite creators first, then every Personal contributor (ProjectLeader,
  // ProjectMember, ...). Kotahi's serializer needs a first AND last name for
  // every author, or Publish fails, so anything else is reported.
  const station = STATIONS[group] || null
  const people = [
    ...(a.creators || []).map(c => ({ c, from: 'creator' })),
    ...(a.contributors || []).map(c => ({ c, from: `contributor (${str(c.contributorType) || 'no role'})` })),
  ]
  const $authors = []
  const orgContributors = []
  let fromContributors = 0
  for (const { c, from } of people) {
    const isCreator = from === 'creator'
    let firstName = str(c.givenName)
    let lastName = str(c.familyName)
    const typedOrg = str(c.nameType) === 'Organizational'
    if (!firstName && !lastName && !typedOrg) ({ firstName, lastName } = splitName(c.name))
    const fullName = str(c.name) || `${lastName}, ${firstName}`
    if (/^group,?$/i.test(fullName)) continue // placeholder creator in the old Tetiaroa records
    if (typedOrg || (!isCreator && !c.givenName && !c.familyName && str(c.nameType) !== 'Personal') || ORG_AS_PERSON.test(fullName)) {
      if (!typedOrg) warnings.push(`"${fullName}" (${from}) is an organisation or title typed as a person; not made a creator`)
      else if (isCreator) warnings.push(`organisation creator "${fullName}" left out`)
      else orgContributors.push(c)
      continue
    }
    const fix = NAME_FIXES[`${lc(firstName)}|${lc(lastName)}`]
    if (fix) {
      warnings.push(`name fixed: "${fullName}" -> "${fix.lastName}, ${fix.firstName}"`)
      ;({ firstName, lastName } = fix)
    }
    if (looksLikeEmail(firstName, lastName)) {
      warnings.push(`NAME LOOKS LIKE AN EMAIL: "${fullName}" (${from}) left out; add this person by hand`)
      continue
    }
    if (!firstName || !lastName) {
      warnings.push(`${from} "${fullName}" left out (no first + last name); Publish needs both names`)
      continue
    }
    const tidyFirst = tidyCase(firstName)
    const tidyLast = tidyCase(lastName)
    if (tidyFirst !== firstName || tidyLast !== lastName) warnings.push(`name case fixed: "${lastName}, ${firstName}" -> "${tidyLast}, ${tidyFirst}"`)
    let orcid = orcidOf(c) || (fix && fix.orcid) || ''
    if (!orcid && defaults.orcidIndex) {
      const hit = defaults.orcidIndex.get(nameKey(tidyFirst, tidyLast))
      if (hit && hit.orcids.size === 1) {
        ;[orcid] = [...hit.orcids]
        warnings.push(`ORCID ${orcid} added for ${tidyFirst} ${tidyLast} (same name on ${[...hit.dois].slice(0, 2).join(', ')})`)
      } else if (hit && hit.orcids.size > 1) warnings.push(`${tidyFirst} ${tidyLast}: several ORCIDs elsewhere (${[...hit.orcids].join(', ')}), none added`)
    }
    if (!isCreator) fromContributors += 1
    $authors.push({
      id: uuid(),
      firstName: tidyFirst,
      middleName: '',
      lastName: tidyLast,
      email: '',
      orcid,
      ror: (c.affiliation || []).map(toAffiliation).filter(Boolean),
    })
  }
  // Same person twice (e.g. f3mw27, or creator and ProjectLeader): keep the
  // first, but take an ORCID or affiliation a later copy has.
  const byName = new Map()
  for (const x of $authors) {
    const k = nameKey(x.firstName, x.lastName)
    const first = byName.get(k)
    if (!first) byName.set(k, x)
    else {
      if (!first.orcid && x.orcid) first.orcid = x.orcid
      if (!first.ror.length && x.ror.length) first.ror = x.ror
    }
  }
  const authorCount = $authors.length
  $authors.splice(0, $authors.length, ...byName.values())
  if ($authors.length < authorCount) warnings.push(`${authorCount - $authors.length} repeated person/people dropped`)
  if (fromContributors) warnings.push(`${fromContributors} person/people moved from contributors to creators`)
  if (!$authors.length) warnings.push('NO AUTHORS: Publish will refuse this record until one is added')

  // Organisational contributors. A station with a set contributor (Bailey)
  // gets only that one; otherwise the DataCite ones are kept.
  let contributors
  if (station && station.contributor) {
    const sc = station.contributor
    contributors = [{ id: uuid(), contributorType: sc.type, nameType: 'Organizational', organization: { label: sc.name, value: sc.ror } }]
    const replaced = [...new Set(orgContributors.map(c => `${str(c.name)} (${str(c.contributorType)})`))]
    if (replaced.length) warnings.push(`contributors replaced by ${sc.name}: ${replaced.join('; ')}`)
  } else {
    contributors = dedupe(
      orgContributors.map(c => {
        const affil = (c.affiliation || []).map(toAffiliation).filter(Boolean)[0]
        const value = rorOfOrg(c) || (affil && affil.label === str(c.name) ? affil.value : '') || str(c.name)
        return { id: uuid(), contributorType: str(c.contributorType) || 'Other', nameType: 'Organizational', organization: { label: str(c.name), value } }
      }),
      r => `${r.contributorType}|${lc(r.organization.label)}`,
    )
  }

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

  if (station && station.publisher && publisherName !== station.publisher.label)
    warnings.push(`publisher "${publisherName}" -> "${station.publisher.label}"`)

  const submission = {
    $title: str(main.title),
    $abstract,
    $authors,
    $doi: str(a.doi).toLowerCase(),
    resourcetype: str(a.types && a.types.resourceTypeGeneral) || 'Other',
    ...(a.types && str(a.types.resourceType) && a.types.resourceType !== a.types.resourceTypeGeneral
      ? { ifother: str(a.types.resourceType) }
      : {}),
    // Bailey: "Bailey Station" (STATIONS). --station-publisher: leave it empty
    // so the station's configured name is sent. Otherwise keep DataCite's.
    ...(station && station.publisher
      ? { publisher: station.publisher }
      : defaults.stationPublisher ? {} : { publisher: { label: publisherName, value: publisherRor || publisherName } }),
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

// name -> ORCIDs seen on any DOI under these prefixes in the repository
const buildOrcidIndex = async o => {
  const index = new Map()
  for (const prefix of ORCID_PREFIXES) {
    let url = `https://api.datacite.org/dois?client-id=${encodeURIComponent(o.client)}&prefix=${prefix}&page[size]=500&page[number]=1&fields[dois]=doi,creators,contributors`
    while (url) {
      const page = await getJson(url)
      for (const d of page.data) {
        for (const c of [...(d.attributes.creators || []), ...(d.attributes.contributors || [])]) {
          const orcid = orcidOf(c)
          if (!orcid || str(c.nameType) === 'Organizational') continue
          let first = str(c.givenName)
          let last = str(c.familyName)
          if (!first && !last) ({ firstName: first, lastName: last } = splitName(c.name))
          const k = nameKey(first, last)
          if (!k) continue
          const e = index.get(k) || { orcids: new Set(), dois: new Set() }
          e.orcids.add(orcid)
          e.dois.add(str(d.attributes.doi).toLowerCase())
          index.set(k, e)
        }
      }
      url = page.links && page.links.next
    }
  }
  return index
}

// Summary of everything odd across the imported records (analysis.txt)
const writeAnalysis = (outDir, mapped) => {
  const kinds = [
    ['Names that look like an email (left out, add by hand)', /^NAME LOOKS LIKE AN EMAIL/],
    ['Records with no person as creator', /^NO AUTHORS/],
    ['Organisations or titles typed as people (not creators)', /typed as a person/],
    ['Organisation creators left out', /^organisation creator/],
    ['People left out (no first + last name)', /left out \(no first/],
    ['ORCIDs added from another DOI with the same name', /^ORCID .* added/],
    ['Same name, several ORCIDs (none added)', /several ORCIDs/],
    ['Names fixed by hand rule', /^name fixed/],
    ['Name capitals fixed', /^name case fixed/],
    ['People moved from contributors to creators', /moved from contributors/],
    ['Repeated people dropped', /repeated person/],
    ['Contributors replaced by the station', /^contributors replaced/],
    ['Publisher changed', /^publisher /],
    ['Funders split', /^funder .* split/],
    ['Licence kept from DataCite', /^kept the licence/],
    ['Place replaced', /^place /],
    ['Other', /./],
  ]
  const buckets = new Map(kinds.map(([t]) => [t, []]))
  for (const { doi, warnings } of mapped)
    for (const w of warnings) buckets.get(kinds.find(([, re]) => re.test(w))[0]).push(`${doi}  ${w}`)

  // People without an ORCID, and possible same person with different first names
  const people = new Map()
  for (const { doi, submission } of mapped)
    for (const x of submission.$authors) {
      const k = nameKey(x.firstName, x.lastName)
      const e = people.get(k) || { name: `${x.firstName} ${x.lastName}`, orcid: x.orcid, dois: [] }
      if (!e.orcid && x.orcid) e.orcid = x.orcid
      e.dois.push(doi)
      people.set(k, e)
    }
  const noOrcid = [...people.values()].filter(e => !e.orcid).sort((p1, p2) => p2.dois.length - p1.dois.length)
  const bySurname = new Map()
  for (const e of people.values()) {
    const [first, last] = e.name.split(/ (?=[^ ]+$)/)
    const k = `${nameKey('', last)}|${nameKey(first, '')[0]}`
    bySurname.set(k, [...(bySurname.get(k) || []), e])
  }
  const variants = [...bySurname.values()].filter(v => v.length > 1)
  const titles = new Map()
  for (const { doi, submission } of mapped) titles.set(lc(submission.$title), [...(titles.get(lc(submission.$title)) || []), doi])
  const dupTitles = [...titles.entries()].filter(([, v]) => v.length > 1)

  const out = [`${mapped.length} records, ${people.size} different people, ${noOrcid.length} of them without an ORCID\n`]
  const summary = []
  for (const [t, lines] of buckets) {
    if (!lines.length) continue
    summary.push(`${String(lines.length).padStart(4)}  ${t}`)
    out.push(`== ${t} (${lines.length})`, ...lines, '')
  }
  out.push(`== Possibly the same person, different first names (${variants.length})`,
    ...variants.map(v => v.map(e => `${e.name}${e.orcid ? ` [${e.orcid}]` : ''} (${e.dois.length})`).join('  /  ')), '')
  out.push(`== Duplicate titles (${dupTitles.length})`, ...dupTitles.map(([t, v]) => `"${t}"  ${v.join(', ')}`), '')
  out.push(`== People without an ORCID (${noOrcid.length}), most records first`, ...noOrcid.map(e => `${e.name}  (${e.dois.length}: ${e.dois.slice(0, 3).join(', ')}${e.dois.length > 3 ? ', ...' : ''})`), '')
  summary.push(`${String(variants.length).padStart(4)}  Possibly the same person, different first names`)
  summary.push(`${String(dupTitles.length).padStart(4)}  Duplicate titles`)
  summary.push(`${String(noOrcid.length).padStart(4)}  People without an ORCID (of ${people.size})`)
  fs.writeFileSync(path.join(outDir, 'analysis.txt'), `${out.join('\n')}\n`)
  return summary
}

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

  o.orcidIndex = await buildOrcidIndex(o)
  console.log(`ORCID lookup: ${o.orcidIndex.size} named people with an ORCID under ${ORCID_PREFIXES.join(' and ')}`)
  const mapped = []

  const rows = [['doi', 'title', 'year', 'type', 'authors', 'current_url', 'state', 'result', 'warnings']]
  let created = 0
  let skipped = 0
  for (const d of wanted) {
    const at = d.attributes
    const doi = str(at.doi).toLowerCase()
    const { submission, warnings } = mapRecord(at, o.group, o)
    mapped.push({ doi, submission, warnings })
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
  console.log(`\nWhat the import changes or flags (details in ${path.join(outDir, 'analysis.txt')}):`)
  for (const line of writeAnalysis(outDir, mapped)) console.log(line)
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

module.exports = { mapRecord, splitName, parseArgs, writeAnalysis, tidyCase }
