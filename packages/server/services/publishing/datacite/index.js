const axios = require('axios')
const { logger } = require('@coko/server')
const Config = require('../../../models/config/config.model')

const { ERROR_MESSAGES } = require('./constants')

const {
  getContributor,
  buildCreators,
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
  getDates,
  getAllTitles,
  getAlternateIdentifiers,
  getSpdxRights,
  refreshLocalContext,
  getRelatedItems,
} = require('./fieldsTransformers')

const { getActiveDatacite, getDoi, getDoiWithoutError } = require('./utils')

const { isArray } = Array

/** Returns true if a DOI is not already in use.
 * It will also return true if the Datacite server is faulty or down, so that form submission is not prevented.
 */
const doiIsAvailable = async (checkDOI, activeConfig) => {
  try {
    // Try to find object listed at DOI
    await requestToDatacite('get', `dois/${checkDOI}`, null, activeConfig)

    // eslint-disable-next-line no-console
    console.log(
      `DOI '${checkDOI}' is already taken. Custom suffix is unavailable.`,
    )
    return false // DOI is already in use
  } catch (err) {
    if (err.response.status === 404) {
      // HTTP 404 "Not found" response. The DOI is not known by Datacite
      return true
    }

    return true
  }
}

const verifySubmission = (formData, submission) => {
  const {
    publishing: { datacite },
    groupIdentity: { title },
  } = formData

  const { publishedArticleLocationPrefix: locationPrefix } = datacite
  const { doiPrefix } = getActiveDatacite(datacite)
  const errors = []
  if (!doiPrefix) errors.push(ERROR_MESSAGES.noDoiPrefix)
  if (!title) errors.push(ERROR_MESSAGES.noJournalName)
  if (!locationPrefix) errors.push(ERROR_MESSAGES.noArticleLocationPrefix)
  if (!submission) errors.push(ERROR_MESSAGES.noSubmissionObject)

  const { $title, $authors /* resourcetype */ } = submission || {}
  const noAuthors = !isArray($authors) || !$authors.length

  if (!$title) errors.push(ERROR_MESSAGES.noSubmissionTitle)
  if (noAuthors) errors.push(ERROR_MESSAGES.noSubmissionAuthors)
  // if (!resourcetype) return ERROR_MESSAGES.noResourceType // disabled (we will set 'other' as default)

  return errors.length > 0 && errors
}

const getPathAndPayload = async (manuscript, activeConfig) => {
  const { id, shortId, meta, submission } = manuscript

  const {
    $localContext,
    geolocation,
    $abstract,
    $authors,
    $dois,
    relatedIdentifiers: formRelatedIdentifiers,
    $doi,
    $issueYear: issueYear,
    resourcetype: resourceTypeGeneral = 'Other',
    ifother: resourceType = '',
    $title: title,
  } = submission

  const { formData } = activeConfig
  const { datacite } = formData.publishing
  const { publishedArticleLocationPrefix } = datacite
  const { doiPrefix: prefix } = getActiveDatacite(datacite)

  let suffix = id

  if ($doi) {
    const [, extractedSuffix] = $doi.match(/10\.\d{4,9}\/(.+)$/i) || []

    if (extractedSuffix) {
      suffix = extractedSuffix
    }
  }

  const doi = getDoi(suffix, activeConfig)
  const publishDate = new Date()

  const doiAvailable = await doiIsAvailable(doi, activeConfig)
  const path = doiAvailable ? 'dois' : `dois/${doi}`
  const method = doiAvailable ? 'post' : 'put'

  const $freshLocalContext = await refreshLocalContext(
    $localContext,
    manuscript.groupId,
  )

  const payload = {
    type: 'dois',
    attributes: {
      doi,
      event: 'publish',
      prefix,
      suffix,
      url: `${publishedArticleLocationPrefix}${shortId}`,
      schemaVersion: 'http://datacite.org/schema/kernel-4',
      types: { resourceTypeGeneral, ...(resourceType ? { resourceType } : {}) },
      titles: getAllTitles(submission),
      alternateIdentifiers: getAlternateIdentifiers(submission),
      ...(submission.language && String(submission.language).trim()
        ? { language: String(submission.language).trim() }
        : {}),
      ...(submission.version && String(submission.version).trim()
        ? { version: String(submission.version).trim() }
        : {}),
      creators: buildCreators($authors, submission.moreThanHumanAuthors),
      geoLocations: geolocation ? [{ geoLocationPlace: geolocation }] : [],
      publicationYear: getPublicationYear(submission, publishDate),
      publisher: getPublisherWithOverride(formData, submission),
      contributors: [
        ...getContributors(formData),
        ...getFormContributors(submission.contributors),
      ],
      descriptions: getDescriptions($abstract),
      subjects: getSubjects(submission),
      rightsList: [
        ...getSpdxRights(submission),
        ...getRightsList($freshLocalContext),
      ],
      fundingReferences: getAllFundingReferences(submission),
      relatedIdentifiers: [
        ...getRelatedIdentifiers(meta, $dois),
        ...getFormRelatedIdentifiers(formRelatedIdentifiers),
      ],
      dates: getFormDates(submission, publishDate),
      relatedItems: getRelatedItems(submission, formData),
    },
  }

  return { payload, path, method }
}

const requestToDatacite = (method, path, payload, { formData }) => {
  const { url, login, password } = getActiveDatacite(
    formData.publishing.datacite,
  )

  const auth = Buffer.from(`${login}:${password}`).toString('base64')
  const authorization = `Basic ${auth}`

  const options = {
    method,
    url: `${url}/${path}`,
    headers: {
      accept: 'application/vnd.api+json',
      authorization,
    },
    data: {
      data: payload,
    },
  }

  return axios.request(options)
}

/** iplaces: per-record test DOIs. An editor can tick "Publish this record
 * with a test DOI" in the record's Publishing section, which sets
 * submission.$testDoi. That record is then sent to the DataCite sandbox (the
 * shared iPlaces test account) even when the station itself is on real DOIs.
 * Returns the config to use for this record; the station's own is unchanged. */
const configForRecord = (activeConfig, manuscript) => {
  const datacite = activeConfig?.formData?.publishing?.datacite
  if (!datacite || !manuscript?.submission?.$testDoi) return activeConfig

  return {
    ...activeConfig,
    formData: {
      ...activeConfig.formData,
      publishing: {
        ...activeConfig.formData.publishing,
        datacite: { ...datacite, useSandbox: true },
      },
    },
  }
}

const publishToDatacite = async manuscript => {
  const { submission, groupId } = manuscript
  const activeConfig = configForRecord(
    await Config.getCached(groupId),
    manuscript,
  )
  const { formData } = activeConfig

  const failureReason = verifySubmission(formData, submission)
  if (failureReason) throw new Error(failureReason[0]) // keep throwing first err

  const { payload, path, method } = await getPathAndPayload(
    manuscript,
    activeConfig,
  )

  logger.info(`SERVICES: publishToDatacite payload: ${JSON.stringify(payload)}`)

  const {
    data: { data },
  } = await requestToDatacite(method, path, payload, activeConfig)

  const { doi } = data.attributes

  return doi
}

const checkPayload = async (manuscript, activeConfig) => {
  const { id: suffix, shortId, meta, submission } = manuscript

  const {
    $localContext,
    geolocation,
    $abstract,
    $authors,
    $dois,
    relatedIdentifiers: formRelatedIdentifiers,
    $issueYear: issueYear,
    resourcetype: resourceTypeGeneral = 'Other',
    ifother: resourceType = '',
    $title: title,
  } = submission

  const { formData } = activeConfig
  const { datacite } = formData.publishing
  const { publishedArticleLocationPrefix } = datacite
  const { doiPrefix: prefix } = getActiveDatacite(datacite)

  const failureReason = []
  const submissionErrors = verifySubmission(formData, submission)
  if (submissionErrors) failureReason.concat(submissionErrors)

  const doi = getDoiWithoutError(suffix, activeConfig)
  const publishDate = new Date()

  const $freshLocalContext = await refreshLocalContext(
    $localContext,
    manuscript.groupId,
  )

  const payload = {
    type: 'dois',
    attributes: {
      doi,
      event: 'publish',
      prefix,
      suffix,
      url: `${publishedArticleLocationPrefix}${shortId}`,
      schemaVersion: 'http://datacite.org/schema/kernel-4',
      types: { resourceTypeGeneral, ...(resourceType ? { resourceType } : {}) },
      titles: getAllTitles(submission),
      alternateIdentifiers: getAlternateIdentifiers(submission),
      ...(submission.language && String(submission.language).trim()
        ? { language: String(submission.language).trim() }
        : {}),
      ...(submission.version && String(submission.version).trim()
        ? { version: String(submission.version).trim() }
        : {}),
      creators: buildCreators($authors, submission.moreThanHumanAuthors),
      geoLocations: geolocation ? [{ geoLocationPlace: geolocation }] : [],
      publicationYear: getPublicationYear(submission, publishDate),
      publisher: getPublisherWithOverride(formData, submission),
      contributors: [
        ...getContributors(formData),
        ...getFormContributors(submission.contributors),
      ],
      descriptions: getDescriptions($abstract),
      subjects: getSubjects(submission),
      rightsList: [
        ...getSpdxRights(submission),
        ...getRightsList($freshLocalContext),
      ],
      fundingReferences: getAllFundingReferences(submission),
      relatedIdentifiers: [
        ...getRelatedIdentifiers(meta, $dois),
        ...getFormRelatedIdentifiers(formRelatedIdentifiers),
      ],
      dates: getFormDates(submission, publishDate),
      relatedItems: getRelatedItems(submission, formData),
    },
  }

  return { payload }
}

/** iPlaces: checks the station's DataCite settings against the server its
 * mode points at, without creating anything. Used by the Configuration page
 * to show whether Save left the station able to mint DOIs.
 * 1. GET /clients/<login> (public): is this repository on this server, and is
 *    the prefix one of its prefixes? A test repository is not on the real
 *    server and the other way round, so this catches a mode/login mismatch.
 * 2. GET /dois/random?prefix=<prefix> with the login: needs a valid login,
 *    so a wrong password shows up here. It only suggests a suffix. */
const checkDataciteConnection = async datacite => {
  const { mode, url, login, password, doiPrefix } = getActiveDatacite(datacite)
  const server = url.replace('https://', '')
  const result = (ok, message) => ({ ok, mode, server, message })

  if (!login)
    return result(
      false,
      mode === 'test'
        ? 'No DataCite test account on the server (Fly secrets IPLACES_DATACITE_TEST_LOGIN / _PASSWORD / _PREFIX), so no test DOIs are minted.'
        : 'No DataCite login, so no DOIs are minted.',
    )
  if (!password) return result(false, 'No DataCite password.')
  if (!doiPrefix) return result(false, 'No DOI prefix.')

  const prefix = doiPrefix
    .replace(/^https?:\/\/doi\.org\//, '')
    .replace(/\/+$/, '')

  const other = mode === 'test' ? 'real' : 'test'
  const headers = { accept: 'application/vnd.api+json' }

  try {
    const { data } = await axios.get(
      `${url}/clients/${encodeURIComponent(login.toLowerCase())}`,
      { headers, timeout: 15000 },
    )

    const prefixes = (data?.data?.relationships?.prefixes?.data || []).map(
      p => p.id,
    )

    if (prefixes.length && !prefixes.includes(prefix))
      return result(
        false,
        `Repository ${login} is on ${server} but prefix ${prefix} is not one of its prefixes (${prefixes.join(', ')}).`,
      )
  } catch (err) {
    const status = err.response?.status
    if (status === 404)
      return result(
        false,
        `Repository ${login} is not on ${server}. If it is a ${other} DataCite repository, switch the station to ${other} DOIs or enter the ${mode} login.`,
      )
    return result(
      false,
      `Could not reach ${server} (${status || err.message}).`,
    )
  }

  try {
    const auth = Buffer.from(`${login}:${password}`).toString('base64')
    await axios.get(`${url}/dois/random`, {
      params: { prefix },
      headers: { ...headers, authorization: `Basic ${auth}` },
      timeout: 15000,
    })
  } catch (err) {
    const status = err.response?.status
    if (status === 401 || status === 403)
      return result(
        false,
        `${server} refused the password for ${login} (HTTP ${status}).`,
      )
    return result(
      false,
      `Could not check the login on ${server} (${status || err.message}).`,
    )
  }

  return result(
    true,
    mode === 'test'
      ? `Test DOIs: ${server} accepted ${login} with prefix ${prefix}${login === process.env.IPLACES_DATACITE_TEST_LOGIN ? ' (shared iPlaces test account)' : ''}. Test DOIs do not resolve at doi.org.`
      : `Real DOIs: ${server} accepted ${login} with prefix ${prefix}. Published records get real, permanent DOIs.`,
  )
}

module.exports = {
  checkDataciteConnection,
  configForRecord,
  requestToDatacite,
  publishToDatacite,
  getDoi,
  doiIsAvailable,
  verifySubmission,
  getPathAndPayload,
  checkPayload,
}
