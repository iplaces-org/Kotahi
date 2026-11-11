const {
  getConfig,
  getIcon,
  getLogo,
  getOldConfig,
  translationOverrides,
  updateConfig,
} = require('../../../controllers/config/config.controllers')

// iplaces: see services/publishing/datacite/index.js checkDataciteConnection
const Config = require('../../../models/config/config.model')

const {
  checkDataciteConnection,
} = require('../../../services/publishing/datacite')

module.exports = {
  Query: {
    config: async (_, { id }) => {
      return getConfig(id)
    },
    oldConfig: () => {
      return getOldConfig()
    },
    dataciteConnectionCheck: async (_, __, ctx) => {
      const groupId = ctx.req.headers['group-id']
      const config = await Config.query().findOne({ groupId, active: true })
      return checkDataciteConnection(config?.formData?.publishing?.datacite)
    },
  },
  Mutation: {
    updateConfig: async (_, { id, input }) => {
      return updateConfig(id, input.formData, input.active)
    },
  },
  Config: {
    icon: async parent => getIcon(parent),
    logo: async parent => getLogo(parent),
    translationOverrides: async parent => translationOverrides(parent.groupId),
  },
}
