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

  const rorAffiliation = sel =>
    sel && sel.label
      ? [
          {
            name: sel.label,
            ...(typeof sel.value === 'string' && sel.value.includes('ror.org')
              ? {
                  affiliationIdentifier: sel.value,
                  affiliationIdentifierScheme: 'ROR',
                  schemeUri: 'https://ror.org',
                }
              : {}),
          },
        ]
      : []

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
}
