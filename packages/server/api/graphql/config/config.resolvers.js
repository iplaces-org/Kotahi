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

const Manuscript = require('../../../models/manuscript/manuscript.model')

const {
  checkDataciteConnection,
  reserveDoi,
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
    // iplaces: see services/publishing/datacite/index.js reserveDoi
    reserveDataciteDoi: async (_, { id }, ctx) => {
      const manuscript = await Manuscript.query().findById(id)
      if (!manuscript) throw new Error('Record not found.')
      if (manuscript.groupId !== ctx.req.headers['group-id'])
        throw new Error('Record is not in this station.')
      if (manuscript.published)
        throw new Error('This record is already published with its DOI.')

      const { doi, isTest } = await reserveDoi(manuscript)

      await Manuscript.query()
        .findById(id)
        .patch({
          doi,
          submission: {
            ...manuscript.submission,
            $doi: doi,
            $doiIsTest: isTest,
            $doiReserved: true,
          },
        })

      return doi
    },
  },
  Config: {
    icon: async parent => getIcon(parent),
    logo: async parent => getLogo(parent),
    translationOverrides: async parent => translationOverrides(parent.groupId),
  },
}
