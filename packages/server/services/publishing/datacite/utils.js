const { DOI_PATH_PREFIX } = require('./constants')

const getDataciteURL = useSandbox => {
  return useSandbox
    ? 'https://api.test.datacite.org'
    : 'https://api.datacite.org'
}

/** iPlaces: the DataCite settings for the mode the station is in.
 * Each station keeps two sets side by side: real (login, password, doiPrefix)
 * and test (testLogin, testPassword, testDoiPrefix). The "Use test DOIs" switch
 * (useSandbox) picks which set is used and which DataCite server is called, so
 * switching between test and real is one tick and nothing has to be retyped.
 * A blank test field falls back to the real one, so a station whose DataCite
 * test repository has the same login (or password, or prefix) can leave it blank.
 * Stations configured before the test fields existed behave exactly as before. */
const getActiveDatacite = (datacite = {}) => {
  const useSandbox = !!datacite.useSandbox
  const pickTest = (testValue, realValue) =>
    useSandbox && testValue ? testValue : realValue

  return {
    useSandbox,
    mode: useSandbox ? 'test' : 'real',
    url: getDataciteURL(useSandbox),
    login: pickTest(datacite.testLogin, datacite.login),
    password: pickTest(datacite.testPassword, datacite.password),
    doiPrefix: pickTest(datacite.testDoiPrefix, datacite.doiPrefix),
  }
}

/** Get DOI in form 10.12345/<suffix>
 * If the configured prefix includes 'https://doi.org/' and/or a trailing slash, these are dealt with gracefully. */
const getDoi = (suffix, activeConfig) => {
  const configuredPrefix = getActiveDatacite(
    activeConfig.formData.publishing.datacite,
  ).doiPrefix

  let prefix = configuredPrefix
  if (!prefix) throw new Error('No DOI prefix configured.')

  if (prefix.startsWith(DOI_PATH_PREFIX)) {
    prefix = prefix.slice(DOI_PATH_PREFIX.length)
  }

  prefix = prefix.replace(/\/+$/, '')

  if (!/^10\.\d{4,9}$/.test(prefix))
    throw new Error(`Unrecognised DOI prefix "${configuredPrefix}"`)
  return `${prefix}/${suffix}`
}

const getDoiWithoutError = (suffix, activeConfig) => {
  try {
    return getDoi(suffix, activeConfig)
    /* eslint-disable-next-line */
  } catch (error) {
    return ''
  }
}

module.exports = {
  getActiveDatacite,
  getDoi,
  getDataciteURL,
  getDoiWithoutError,
}
