const cheerio = require('cheerio')
const htmlToJats = require('../../jatsexport/htmlToJats')
const { objIf, safeParse } = require('../../../utils/objectUtils')

const { CITATION_SELECTOR, CITATION_DATA_STRUCTURE } = require('./constants')

const calculateDataciteCitations = text => {
  const $ = cheerio.load(text)
  const citations = $(CITATION_SELECTOR)
  const citationDois = []
  citations.each((_, citation) => {
    const { doi } = safeParse($(citation).attr(CITATION_DATA_STRUCTURE))

    if (doi) {
      citationDois.push({
        relatedIdentifierType: 'DOI',
        relationType: 'IsCitedBy',
        relatedIdentifier: doi,
      })
    }
  })

  return citationDois
}

const getPublisher = formData => {
  const { rorUrl, title } = formData.groupIdentity

  const publisher = {
    name: title,
    ...objIf(rorUrl, {
      publisherIdentifier: rorUrl,
      schemeUri: 'https://ror.org',
      publisherIdentifierScheme: 'ROR',
    }),
  }

  return publisher
}

const getContributor = author => {
  const { ror: affiliation, orcid, firstName, lastName } = author
  if (!firstName || !lastName)
    throw new Error(`Incomplete author record ${JSON.stringify(author)}`)

  const affiliations = (
    Array.isArray(affiliation) ? [...affiliation] : [affiliation]
  ).filter(a => a?.value?.includes('ror.org'))

  const contributor = {
    nameType: 'Personal',
    givenName: firstName,
    familyName: lastName,
    ...objIf(orcid, {
      nameIdentifiers: [
        {
          nameIdentifierScheme: 'ORCID',
          schemeUri: 'https://orcid.org',
          nameIdentifier: orcid,
        },
      ],
    }),
    affiliation: affiliations.length
      ? affiliations.map(a => ({
          affiliationIdentifier: a.value,
          affiliationIdentifierScheme: 'ROR',
          schemeUri: 'https://ror.org',
          name: a.label,
        }))
      : [],
  }

  return contributor
}

const getContributors = formData => {
  const { title: name, rorUrl } = formData.groupIdentity

  const contributor = {
    contributorType: 'Sponsor',
    name,
    nameType: 'Organizational',
    affiliation: [
      {
        name,
        ...objIf(rorUrl, {
          affiliationIdentifierScheme: 'ROR',
          schemeUri: 'https://ror.org',
          affiliationIdentifier: rorUrl,
        }),
      },
    ],
  }

  return [contributor]
}

const getRightsList = localContext => {
  if (!localContext) return []

  const notices =
    localContext.notice?.map(n => ({
      rightsUri: localContext.url,
      rightsIdentifier: n.noticeType,
      rightsIdentifierScheme: 'Local Contexts',
      schemeUri: 'https://localcontexts.org/',
      rights: n.defaultText,
    })) || []

  const labels =
    localContext.label?.map(l => ({
      rightsUri: localContext.url,
      rightsIdentifier: l.identifier,
      rightsIdentifierScheme: 'Local Contexts',
      schemeUri: 'https://localcontexts.org/',
      rights: l.labelText,
    })) || []

  return notices.concat(labels)
}

const getFundingReferences = submission => {
  const { funderIdentifierType, Funding, funderid, awardnumber, awardtitle, awarduri } =
    submission

  return Funding
    ? [
        {
          funderName: Funding,
          funderIdentifierType,
          funderIdentifier: funderid,
          awardNumber: awardnumber || null,
          awardTitle: awardtitle || null,
          awardUri: awarduri || null,
        },
      ]
    : []
}

const getDescriptions = $abstract => {
  return $abstract
    ? [
        {
          descriptionType: 'Abstract',
          description: htmlToJats($abstract),
        },
      ]
    : []
}

const getRelatedIdentifiers = (meta, $dois) => {
  const citationDois = meta.source
    ? calculateDataciteCitations(meta.source)
    : []

  const relatedDois = getRelatedDois($dois)
  return [...citationDois, ...relatedDois]
}

const getRelatedDois = dois => {
  const doiUrl = 'https://doi.org/'
  return dois
    ? dois
        .filter(({ doi }) => doi !== '')
        .map(({ doi }) => ({
          relatedIdentifierType: 'DOI',
          relationType: 'HasPart',
          relatedIdentifier: doi.startsWith(doiUrl)
            ? doi.substring(doiUrl.length)
            : doi,
        }))
    : []
}


/* iplaces Patch 3: pass through submission.relatedIdentifiers (form-authored
   DataCite rows from RelatedIdentifiersInput). Rules: a row must have all of
   identifier, relatedIdentifierType and relationType to be emitted; internal
   row id is stripped; a pasted https://doi.org/ prefix is stripped for DOI
   rows; empty optional sub-properties are omitted. */
const getFormRelatedIdentifiers = formRows => {
  const doiUrl = 'https://doi.org/'
  if (!Array.isArray(formRows)) return []

  return formRows
    .filter(
      r =>
        r &&
        typeof r.relatedIdentifier === 'string' &&
        r.relatedIdentifier.trim() !== '' &&
        r.relatedIdentifierType &&
        r.relationType,
    )
    .map(r => {
      let identifier = r.relatedIdentifier.trim()

      if (r.relatedIdentifierType === 'DOI' && identifier.startsWith(doiUrl))
        identifier = identifier.substring(doiUrl.length)

      return {
        relatedIdentifier: identifier,
        relatedIdentifierType: r.relatedIdentifierType,
        relationType: r.relationType,
        ...(r.relationTypeInformation
          ? { relationTypeInformation: r.relationTypeInformation }
          : {}),
        ...(r.resourceTypeGeneral
          ? { resourceTypeGeneral: r.resourceTypeGeneral }
          : {}),
      }
    })
}


/* iplaces Patch 4a: transform flat form-authored contributor rows
   (ContributorsInput) into DataCite contributor objects. Handles both
   nameTypes. ror-type field values are {label: name, value: rorUrlOrText};
   a value containing ror.org is treated as a ROR id, anything else as free
   text (name only). Rows without a contributorType or without a usable name
   are skipped. */
const getFormContributors = formRows => {
  if (!Array.isArray(formRows)) return []

  /* iplaces Patch 6: affiliation may be an ARRAY of {label, value}
     selections (multi-affiliation contributors) or a legacy single
     object from rows saved before isMulti. */
  const rorAffiliation = sel => {
    const list = Array.isArray(sel) ? sel : sel ? [sel] : []

    return list
      .filter(a => a && a.label)
      .map(a => ({
        name: a.label,
        ...(typeof a.value === 'string' && a.value.includes('ror.org')
          ? {
              affiliationIdentifier: a.value,
              affiliationIdentifierScheme: 'ROR',
              schemeUri: 'https://ror.org',
            }
          : {}),
      }))
  }

  return formRows
    .filter(r => r && r.contributorType)
    .map(r => {
      if (r.nameType === 'Organizational') {
        const org = r.organization

        if (!org || !org.label) return null
        return {
          contributorType: r.contributorType,
          nameType: 'Organizational',
          name: org.label,
          ...(typeof org.value === 'string' && org.value.includes('ror.org')
            ? {
                nameIdentifiers: [
                  {
                    nameIdentifier: org.value,
                    nameIdentifierScheme: 'ROR',
                    schemeUri: 'https://ror.org',
                  },
                ],
              }
            : {}),
        }
      }

      if (!r.givenName && !r.familyName) return null
      return {
        contributorType: r.contributorType,
        nameType: 'Personal',
        ...(r.givenName ? { givenName: r.givenName } : {}),
        ...(r.familyName ? { familyName: r.familyName } : {}),
        ...(r.orcid
          ? {
              nameIdentifiers: [
                {
                  nameIdentifier: r.orcid,
                  nameIdentifierScheme: 'ORCID',
                  schemeUri: 'https://orcid.org',
                },
              ],
            }
          : {}),
        affiliation: rorAffiliation(r.affiliation),
      }
    })
    .filter(Boolean)
}

/* iplaces Patch 4b (rev. Patch 5): per-record publisher override.
   Accepts either shape of submission.publisher:
   - {label, value} from PublisherInput (ROR search) -> name = label;
     value containing ror.org -> publisherIdentifier (ROR)
   - plain string (legacy TextField) -> name; optional submission.publisherRor
     string adds the ROR identifier
   Empty/absent -> group-config publisher (legacy behavior). */
const getPublisherWithOverride = (formData, submission) => {
  const raw = submission && submission.publisher

  const asRor = ror =>
    ror && String(ror).includes('ror.org')
      ? {
          publisherIdentifier: String(ror).trim(),
          schemeUri: 'https://ror.org',
          publisherIdentifierScheme: 'ROR',
        }
      : {}

  if (raw && typeof raw === 'object' && raw.label) {
    return {
      name: String(raw.label).trim(),
      ...asRor(raw.ror || raw.value),
    }
  }

  if (raw && typeof raw === 'string' && raw.trim() !== '') {
    return {
      name: raw.trim(),
      ...asRor(submission.publisherRor),
    }
  }

  return getPublisher(formData)
}

/* iplaces Patch 4c: publicationYear no longer hardcoded to the current
   year. Priority: submission.publicationYear (4-digit), else the year of
   submission.datePublished, else the current year (legacy behavior). */
const getPublicationYear = (submission, publishDate) => {
  const explicit = submission && submission.publicationYear

  if (explicit && /^\d{4}$/.test(String(explicit).trim()))
    return parseInt(String(explicit).trim(), 10)

  const datePublished = submission && submission.datePublished
  const parsed = datePublished ? new Date(datePublished) : null

  if (parsed && !Number.isNaN(parsed.getTime()))
    return parsed.getUTCFullYear()

  return publishDate.getUTCFullYear()
}


/* iplaces Patch 7a: funding references. Form rows (FundingReferencesInput)
   REPLACE the legacy flat fields when present; when the array is empty or
   absent, the legacy single-funder derivation still applies (old
   manuscripts unchanged). funder is a ror-type {label, value}: label ->
   funderName; value containing ror.org -> funderIdentifier (ROR). */
const getAllFundingReferences = submission => {
  const rows = Array.isArray(submission.fundingReferences)
    ? submission.fundingReferences
    : []

  const cleaned = rows
    .filter(r => r && r.funder && r.funder.label)
    .map(r => ({
      funderName: String(r.funder.label).trim(),
      ...(typeof r.funder.value === 'string' &&
      r.funder.value.includes('ror.org')
        ? {
            funderIdentifier: r.funder.value,
            funderIdentifierType: 'ROR',
            schemeUri: 'https://ror.org',
          }
        : {}),
      ...(r.awardNumber ? { awardNumber: String(r.awardNumber).trim() } : {}),
      ...(r.awardTitle ? { awardTitle: String(r.awardTitle).trim() } : {}),
      ...(r.awardUri ? { awardUri: String(r.awardUri).trim() } : {}),
    }))

  return cleaned.length ? cleaned : getFundingReferences(submission)
}

/* iplaces Patch 7b: dates from the existing form date fields, with a light
   ISO-shape guard (YYYY, YYYY-MM or YYYY-MM-DD only) so free-text dates
   can't produce invalid DataCite. Fixes the dateless-Issued wart: Issued
   is emitted only when a valid datePublished or $issueYear exists. */
const isoish = v => {
  const s = v ? String(v).trim() : ''
  return /^\d{4}(-\d{2}(-\d{2})?)?$/.test(s) ? s : null
}

const getFormDates = (submission, publishDate) => {
  const dates = []
  const submitted = isoish(submission.dateReceived)
  const accepted = isoish(submission.dateAccepted)
  const issued = isoish(submission.datePublished) || isoish(submission.$issueYear)

  if (submitted) dates.push({ dateType: 'Submitted', date: submitted })
  dates.push({
    dateType: 'Accepted',
    date: accepted || publishDate.toISOString(),
  })
  if (issued) dates.push({ dateType: 'Issued', date: issued })

  return dates
}

/* iplaces Patch 7c: subjects from the existing topics checkboxes plus an
   optional comma-separated submission.keywords TextField. */
const getSubjects = submission => {
  const topics = Array.isArray(submission.topics) ? submission.topics : []

  const keywords =
    typeof submission.keywords === 'string'
      ? submission.keywords.split(',')
      : []

  return [...topics, ...keywords]
    .map(s => (s ? String(s).trim() : ''))
    .filter(s => s !== '')
    .map(subject => ({ subject }))
}

const getDates = (issueYear, publishDate) => {
  return [
    { dateType: 'Issued', date: issueYear },
    { dateType: 'Accepted', date: publishDate.toISOString() },
  ]
}

// eslint-disable-next-line no-unused-vars
const getRelatedItems = (submission, formData) => {
  const {
    groupIdentity: { journalName, journalAbbreviatedName },
  } = formData

  const relatedItems = []

  if (submission.$volumeNumber || submission.$issueNumber) {
    relatedItems.push({
      relatedItemType: 'Collection',
      relationType: 'IsPublishedIn',
      volume: submission.$volumeNumber,
      issue: submission.$issueNumber,
    })
  }

  if (journalName || journalAbbreviatedName) {
    const titles = []

    if (journalName) {
      titles.push({
        title: journalName,
      })
    }

    if (journalAbbreviatedName) {
      titles.push({
        title: journalAbbreviatedName,
        titleType: 'Subtitle',
      })
    }

    relatedItems.push({
      relatedItemType: 'Journal',
      relationType: 'IsPublishedIn',
      titles,
    })
  }

  return relatedItems
}


/* -------- Patch 8: titles --------
   getAllTitles emits the full DataCite titles array: the main title
   (submission.$title, no titleType — DataCite treats an untyped title as
   the main title) followed by additional titles from submission.titles
   rows { title, titleType, lang }. Rows without title text are skipped;
   titleType passes through only if it is a valid 4.7 value; lang is a
   BCP-47 tag (e.g. fr, ty, en-US) passed through trimmed. */
const VALID_TITLE_TYPES = [
  'AlternativeTitle',
  'Subtitle',
  'TranslatedTitle',
  'Other',
]

const getAllTitles = submission => {
  const titles = []
  const mainTitle = submission?.$title ? String(submission.$title).trim() : ''
  if (mainTitle) titles.push({ title: mainTitle })

  const rows = Array.isArray(submission?.titles) ? submission.titles : []

  rows.forEach(r => {
    if (!r || typeof r !== 'object') return
    const title = r.title ? String(r.title).trim() : ''
    if (!title) return
    const entry = { title }
    if (r.titleType && VALID_TITLE_TYPES.includes(r.titleType))
      entry.titleType = r.titleType
    if (r.lang && String(r.lang).trim()) entry.lang = String(r.lang).trim()
    titles.push(entry)
  })

  return titles
}


/* -------- Patch 9: alternateIdentifiers --------
   getAlternateIdentifiers emits submission.alternateIdentifiers rows
   { alternateIdentifier, alternateIdentifierType }. Both sub-fields are
   free text in DataCite 4.7 (no controlled vocabulary), but the type is
   mandatory whenever the identifier is present, so rows missing either
   are skipped. */
const getAlternateIdentifiers = submission => {
  const rows = Array.isArray(submission?.alternateIdentifiers)
    ? submission.alternateIdentifiers
    : []

  return rows.reduce((acc, r) => {
    if (!r || typeof r !== 'object') return acc
    const alternateIdentifier = r.alternateIdentifier
      ? String(r.alternateIdentifier).trim()
      : ''

    const alternateIdentifierType = r.alternateIdentifierType
      ? String(r.alternateIdentifierType).trim()
      : ''

    if (!alternateIdentifier || !alternateIdentifierType) return acc
    acc.push({ alternateIdentifier, alternateIdentifierType })
    return acc
  }, [])
}


/* -------- Patch 10: rights / SPDX --------
   getSpdxRights expands submission.license (a single SPDX identifier
   chosen from a form Select) into a full DataCite rights object using
   the lookup below. Lookup is case-insensitive; rightsIdentifier is
   emitted lowercase per DataCite's documented convention. An unknown
   non-empty value is emitted as free-text rights; empty emits nothing.
   Local Contexts labels/notices are handled separately by getRightsList
   and merged in index.js. */
const SPDX_LICENSES = {
  'CC-BY-4.0': {
    rights: 'Creative Commons Attribution 4.0 International',
    rightsUri: 'https://creativecommons.org/licenses/by/4.0/legalcode',
  },
  'CC-BY-SA-4.0': {
    rights: 'Creative Commons Attribution Share Alike 4.0 International',
    rightsUri: 'https://creativecommons.org/licenses/by-sa/4.0/legalcode',
  },
  'CC-BY-NC-4.0': {
    rights: 'Creative Commons Attribution Non Commercial 4.0 International',
    rightsUri: 'https://creativecommons.org/licenses/by-nc/4.0/legalcode',
  },
  'CC-BY-NC-SA-4.0': {
    rights:
      'Creative Commons Attribution Non Commercial Share Alike 4.0 International',
    rightsUri: 'https://creativecommons.org/licenses/by-nc-sa/4.0/legalcode',
  },
  'CC-BY-ND-4.0': {
    rights: 'Creative Commons Attribution No Derivatives 4.0 International',
    rightsUri: 'https://creativecommons.org/licenses/by-nd/4.0/legalcode',
  },
  'CC-BY-NC-ND-4.0': {
    rights:
      'Creative Commons Attribution Non Commercial No Derivatives 4.0 International',
    rightsUri: 'https://creativecommons.org/licenses/by-nc-nd/4.0/legalcode',
  },
  'CC0-1.0': {
    rights: 'Creative Commons Zero v1.0 Universal',
    rightsUri: 'https://creativecommons.org/publicdomain/zero/1.0/legalcode',
  },
  MIT: {
    rights: 'MIT License',
    rightsUri: 'https://opensource.org/license/mit/',
  },
  'Apache-2.0': {
    rights: 'Apache License 2.0',
    rightsUri: 'https://www.apache.org/licenses/LICENSE-2.0',
  },
}

const SPDX_KEYS_LOWER = Object.keys(SPDX_LICENSES).reduce((acc, k) => {
  acc[k.toLowerCase()] = k
  return acc
}, {})

const getSpdxRights = submission => {
  const raw = submission?.license ? String(submission.license).trim() : ''
  if (!raw) return []

  if (raw === 'All rights reserved')
    return [{ rights: 'All rights reserved' }]

  const key = SPDX_KEYS_LOWER[raw.toLowerCase()]
  if (!key) return [{ rights: raw }]

  return [
    {
      ...SPDX_LICENSES[key],
      rightsIdentifier: key.toLowerCase(),
      rightsIdentifierScheme: 'SPDX',
      schemeUri: 'https://spdx.org/licenses/',
    },
  ]
}


/* -------- Patch 11: refreshLocalContext --------
   Re-fetches Local Contexts Hub data at publish time so that Labels a
   community has applied since the form was last saved flow into the DOI
   metadata. Reuses Kotahi's own localContext controller (same endpoint,
   auth, and mapping as the form widget). On ANY failure — missing project
   id, Hub unreachable, missing API key — returns the stored object
   unchanged, so publishing never breaks. The stored url is preserved on
   the fresh object because the controller result carries no url and
   getRightsList emits it as each label's rightsUri. */
const LC_UUID_RE =
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i

const refreshLocalContext = async (stored, groupId) => {
  if (!stored || typeof stored !== 'object') return stored

  const projectId =
    stored.id || (String(stored.url || '').match(LC_UUID_RE) || [])[0]

  if (!projectId || !groupId) return stored

  try {
    // eslint-disable-next-line global-require
    const {
      localContext: fetchLocalContext,
    } = require('../../../controllers/localContext/localContext.controller')

    const { localContext: fresh, errorMessage } = await fetchLocalContext({
      projectId,
      groupId,
    })

    if (errorMessage || !fresh || !Array.isArray(fresh.notice)) return stored
    return { ...fresh, url: stored.url }
  } catch (e) {
    return stored
  }
}

module.exports = {
  getDates,
  getContributor,
  getPublisher,
  getContributors,
  getDescriptions,
  getRightsList,
  getFundingReferences,
  getRelatedIdentifiers,
  getFormRelatedIdentifiers,
  getFormContributors,
  getPublisherWithOverride,
  getPublicationYear,
  getAllFundingReferences,
  getFormDates,
  getSubjects,
  getAllTitles,
  getAlternateIdentifiers,
  getSpdxRights,
  refreshLocalContext,
}
