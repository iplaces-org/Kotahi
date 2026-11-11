const { DOI_PATH_PREFIX } = require('./constants')

const getDataciteURL = useSandbox => {
  return useSandbox
    ? 'https://api.test.datacite.org'
    : 'https://api.datacite.org'
}

/** iPlaces: the DataCite settings for the mode the station is in.
 * Unticked "Use test DOIs" (useSandbox false): the station's own real
 * repository (login, password, doiPrefix), entered by hand per station.
 * Ticked: api.test.datacite.org with the SHARED iPlaces test account, read
 * from the server environment (Fly secrets IPLACES_DATACITE_TEST_LOGIN,
 * IPLACES_DATACITE_TEST_PASSWORD, IPLACES_DATACITE_TEST_PREFIX), so ticking
 * the box is all a station needs. A station can still override any of them
 * with testLogin / testPassword / testDoiPrefix in its config (not shown in
 * the form). If neither is set, the real value is used, as before. */
const getActiveDatacite = (datacite = {}) => {
  const useSandbox = !!datacite.useSandbox
  const { env } = process

  const pickTest = (stationTest, shared, realValue) =>
    useSandbox ? stationTest || shared || realValue : realValue

  return {
    useSandbox,
    mode: useSandbox ? 'test' : 'real',
    url: getDataciteURL(useSandbox),
    login: pickTest(
      datacite.testLogin,
      env.IPLACES_DATACITE_TEST_LOGIN,
      datacite.login,
    ),
    password: pickTest(
      datacite.testPassword,
      env.IPLACES_DATACITE_TEST_PASSWORD,
      datacite.password,
    ),
    doiPrefix: pickTest(
      datacite.testDoiPrefix,
      env.IPLACES_DATACITE_TEST_PREFIX,
      datacite.doiPrefix,
    ),
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
