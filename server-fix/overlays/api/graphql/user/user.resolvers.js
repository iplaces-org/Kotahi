const {
  channelUsersForMention,
  deleteUser,
  getCurrentUser,
  getUser,
  getUsers,
  isUserOnline,
  paginatedUsers,
  profilePicture,
  searchUsers,
  sendEmail,
  setGlobalRole,
  setGroupRole,
  updateEmail,
  updateLanguage,
  updateRecentTab,
  updateUser,
  updateUsername,
  userIdentities,
} = require('../../../controllers/user.controllers')

const Team = require('../../../models/team/team.model')
const { cachedGet } = require('../../../services/queryCache.service')

// iplaces Patch 27: a user's email (User.email and the email on their
// identities) is returned only to that user, to admins, and to the current
// station's editors, group managers and group admins when the user belongs to
// that station. Everyone else gets null. Was: every logged-in user could read
// any user's email, e.g. through searchUsers or user(id). Done here rather
// than in permissions.js because a shield rule would fail the whole query
// (the chat @-mention search and team lists would break); null keeps them
// working. The answers are kept on ctx so each request looks them up once.
const EDITOR_ROLES = ['seniorEditor', 'handlingEditor', 'editor']

const memo = (ctx, key, fn) => {
  if (!ctx.iplacesEmailAccess) ctx.iplacesEmailAccess = new Map()
  if (!ctx.iplacesEmailAccess.has(key)) ctx.iplacesEmailAccess.set(key, fn())
  return ctx.iplacesEmailAccess.get(key)
}

const viewerIsStationStaff = (ctx, groupId) =>
  memo(ctx, `staff:${groupId}`, async () => {
    if (
      (await cachedGet(`userIsGM:${ctx.userId}:${groupId}`)) ||
      (await cachedGet(`userIsGroupAdmin:${ctx.userId}:${groupId}`))
    )
      return true

    const editorTeam = await Team.query()
      .join('team_members', 'team_members.teamId', 'teams.id')
      .join('manuscripts', 'manuscripts.id', 'teams.objectId')
      .whereIn('teams.role', EDITOR_ROLES)
      .where({
        'team_members.userId': ctx.userId,
        'manuscripts.groupId': groupId,
      })
      .select('teams.id')
      .first()

    return !!editorTeam
  })

const stationUserIds = (ctx, groupId) =>
  memo(ctx, `members:${groupId}`, async () => {
    const members = await Team.relatedQuery('members')
      .for(Team.query().where({ objectId: groupId, role: 'user' }))
      .select('userId')

    return new Set(members.map(m => m.userId))
  })

const canSeeEmailOf = async (user, ctx) => {
  if (!user?.id || !ctx?.userId) return false
  if (user.id === ctx.userId) return true
  if (await memo(ctx, 'admin', () => cachedGet(`userIsAdmin:${ctx.userId}`)))
    return true

  // Subscriptions have no request headers, so no station: self/admin only.
  const groupId = ctx.req?.headers?.['group-id']
  if (!groupId || groupId === 'undefined') return false

  return (
    (await viewerIsStationStaff(ctx, groupId)) &&
    (await stationUserIds(ctx, groupId)).has(user.id)
  )
}

const withoutEmail = identity => identity && { ...identity, email: null }

module.exports = {
  Query: {
    async channelUsersForMention(_, { channelId }, ctx) {
      return channelUsersForMention(channelId, ctx.req.headers['group-id'])
    },

    async currentUser(_, __, ctx) {
      return getCurrentUser(ctx.userId, ctx.req.headers['group-id'])
    },

    async paginatedUsers(_, { sort, offset, limit }, ctx) {
      return paginatedUsers(
        ctx.userId,
        ctx.req.headers['group-id'],
        sort,
        offset,
        limit,
      )
    },

    async searchUsers(_, { teamId, query }) {
      return searchUsers(teamId, query)
    },

    async user(_, { id }, ctx) {
      return getUser(id, ctx.req.headers['group-id'])
    },

    async users(_, __, ctx) {
      return getUsers(ctx.req.headers['group-id'])
    },
  },

  Mutation: {
    async deleteUser(_, { id }, ctx) {
      return deleteUser(id, ctx.req.headers['group-id'])
    },

    async sendEmail(_, { input }, ctx) {
      return sendEmail(input, ctx)
    },

    async setGlobalRole(_, { userId, role, shouldEnable }, ctx) {
      return setGlobalRole(
        userId,
        ctx.req.headers['group-id'],
        role,
        shouldEnable,
      )
    },

    async setGroupRole(_, { userId, role, shouldEnable }, ctx) {
      return setGroupRole(
        userId,
        ctx.req.headers['group-id'],
        role,
        shouldEnable,
      )
    },

    async updateEmail(_, { id, email }) {
      return updateEmail(id, email)
    },

    async updateLanguage(_, { id, preferredLanguage }) {
      return updateLanguage(id, preferredLanguage)
    },

    async updateRecentTab(_, { tab }, ctx) {
      return updateRecentTab(ctx.userId, tab)
    },

    async updateUser(_, { id, input }) {
      return updateUser(id, input)
    },

    async updateUsername(_, { id, username }) {
      return updateUsername(id, username)
    },
  },

  User: {
    async defaultIdentity(user, _, ctx) {
      // TODO: Cypress test 002 fails with this optimisation. Needs further investigation
      if (user.defaultIdentity && user.defaultIdentity.id && user.email) {
        const { id, name, aff, type, identifier } = user.defaultIdentity
        const email = (await canSeeEmailOf(user, ctx)) ? user.email : null // iplaces Patch 27
        return { id, name, aff, email, type, identifier }
      }

      if (!ctx?.loaders) return null
      const identity = await ctx.loaders.User.defaultIdentitiesLoader.load(
        user.id,
      )
      return (await canSeeEmailOf(user, ctx))
        ? identity
        : withoutEmail(identity) // iplaces Patch 27
    },

    // iplaces Patch 27
    async email(user, _, ctx) {
      return (await canSeeEmailOf(user, ctx)) ? user.email : null
    },

    async identities(parent, _, ctx) {
      const identities = await userIdentities(parent)
      if (await canSeeEmailOf(parent, ctx)) return identities // iplaces Patch 27
      return identities.map(withoutEmail)
    },

    async isOnline(parent) {
      return isUserOnline(parent)
    },

    async profilePicture(parent) {
      return profilePicture(parent)
    },
  },
}
