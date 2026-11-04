// iplaces (Patch 32): the name shown in activity-log lines such as
// "Editor Decision sent by iPlaces Gump Station to ...", in place of "Kotahi".
// Uses the station's Group name (Settings > Configuration > Group Identity),
// prefixed with "iPlaces" when the name doesn't already start with it.
// Falls back to plain "iPlaces". Never throws: a log line must not break a send.
const { Config } = require('../models')

const stationSenderName = async groupId => {
  try {
    if (!groupId) return 'iPlaces'
    const activeConfig = await Config.getCached(groupId)
    const name = activeConfig?.formData?.groupIdentity?.brandName?.trim()
    if (!name) return 'iPlaces'
    return /^iplaces\b/i.test(name) ? name : `iPlaces ${name}`
  } catch (error) {
    return 'iPlaces'
  }
}

module.exports = stationSenderName
