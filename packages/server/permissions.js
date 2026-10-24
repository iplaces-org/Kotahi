const { authorization } = require('@coko/server')

const { cachedGet } = require('./services/queryCache.service')

const Channel = require('./models/channel/channel.model')
const Config = require('./models/config/config.model')
const Invitation = require('./models/invitation/invitation.model')
const Message = require('./models/message/message.model')
const Manuscript = require('./models/manuscript/manuscript.model')
const Review = require('./models/review/review.model')
const Team = require('./models/team/team.model')
const TeamMember = require('./models/teamMember/teamMember.model')
const User = require('./models/user/user.model')

// Shield's `race` rule is misnamed, as it doesn't race the different rules but applies them sequentially until one succeeds. `or`, on the other hand, applies all rules in parallel.
const { rule, and, or, allow, deny, race: lazyOr } = authorization

const userIsEditor = rule({
  cache: 'strict',
})(async (parent, args, ctx) => {
  if (!ctx.userId) return false
  const manuscriptId = parent?.manuscriptId ?? args?.id
  if (!manuscriptId) throw new Error('No manuscriptId for userIsEditor!')
  return cachedGet(`userIsEditor:${ctx.userId}:${manuscriptId}`)
})

// TODO Is this actually needed anywhere? Can it be replaced with userIsEditor?
const userIsEditorOfAnyManuscript = rule({
  cache: 'contextual',
})(async (parent, args, ctx) => {
  if (!ctx.userId) return false
  return cachedGet(`userIsEditorOfAnyManuscript:${ctx.userId}`)
})

const userIsGm = rule({
  cache: 'contextual',
})(async (parent, args, ctx) => {
  const groupId = ctx.req.headers['group-id']
  // An 'undefined' groupId header can occasionally be obtained, especially
  // in development. If we don't deal with it gracefully, it will cause
  // a crash and prevent its replacement with a correct value.
  if (!ctx.userId || !groupId || groupId === 'undefined') return false
  return cachedGet(`userIsGM:${ctx.userId}:${groupId}`)
})

const userIsAdmin = rule({
  cache: 'contextual',
})(async (parent, args, ctx) => {
  if (!ctx.userId) return false
  return cachedGet(`userIsAdmin:${ctx.userId}`)
})

const userIsGroupAdmin = rule({
  cache: 'contextual',
})(async (parent, args, ctx) => {
  const groupId = ctx.req.headers['group-id']
  if (!ctx.userId || !groupId || groupId === 'undefined') return false
  return cachedGet(`userIsGroupAdmin:${ctx.userId}:${groupId}`)
})

// IPLACES-PATCH-15: submitBlocked denylist. Membership in a group's
// 'submitBlocked' team revokes the default right to create/submit
// manuscripts. The team is normally absent or empty; when absent, the
// query finds no row and everyone passes. Grant/revoke via the same
// team machinery as stationMember.
const userIsNotSubmitBlocked = rule({
  cache: 'contextual',
})(async (parent, args, ctx) => {
  const groupId = ctx.req.headers['group-id']
  if (!ctx.userId || !groupId || groupId === 'undefined') return true
  const blocked = await Team.relatedQuery('members')
    .for(Team.query().where({ objectId: groupId, role: 'submitBlocked' }))
    .findOne({ userId: ctx.userId })
  return !blocked
})

const userOwnsMessage = rule({ cache: 'contextual' })(async (
  parent,
  args,
  ctx,
) => {
  if (!ctx.userId) return false

  const message = await Message.query().findById(args.messageId)

  return message?.userId === ctx.userId
})

const getLatestVersionOfManuscript = async (ctx, manuscriptVersionId) => {
  const latestVersion = await Manuscript.query()
    .where({ parentId: manuscriptVersionId })
    .orWhere({ id: manuscriptVersionId })
    .orderBy('created', 'desc')
    .limit(1)

  return latestVersion[0]
}

const userIsMemberOfTeamWithRoleQuery = async (user, manuscriptId, role) => {
  if (!user) return false

  const query = user
    .$relatedQuery('teams')
    .where({ role })
    .andWhere({ objectId: manuscriptId, objectType: 'manuscript' })

  const rows = await query.resultSize()
  return !!rows
}

const isPublicFileFromPublishedManuscript = rule({ cache: 'strict' })(
  async parent => {
    if (parent.tags && parent.tags.includes('confidential')) return false
    const manuscript = await cachedGet(`msOfFile:${parent.id}`)
    return !!manuscript?.published
  },
)

const isCMSFile = rule({ cache: 'strict' })(async parent => {
  return parent.tags && parent.tags.includes('cms')
})

const isPublishingCollection = rule({ cache: 'strict' })(async parent => {
  return parent.tags && parent.tags.includes('publishingCollection')
})

const isLogoFile = rule({ cache: 'strict' })(async parent => {
  return parent.tags && parent.tags.includes('brandLogo')
})

const isFaviconFile = rule({ cache: 'strict' })(async parent => {
  return parent.tags && parent.tags.includes('favicon')
})

const isExportTemplatingFile = rule({ cache: 'strict' })(async parent => {
  return parent.tags && parent.tags.includes('templateGroupAsset')
})

// Files owned by the group itself (eg. export template assets, listed on the
// production page for authors doing proofing too)
const isFileOfCurrentGroup = rule({ cache: 'strict' })(async (
  parent,
  args,
  ctx,
) => {
  const groupId = ctx.req?.headers['group-id']
  if (!ctx.userId || !groupId || groupId === 'undefined') return false
  return !!parent.objectId && parent.objectId === groupId
})

const isPublicReviewFromPublishedManuscript = rule({ cache: 'strict' })(
  async parent => {
    if (parent.isHiddenFromAuthor || !parent.manuscriptId) return false

    // TODO Check that all confidential fields have been stripped out. Otherwise return false.

    const manuscript = await Manuscript.query().findById(parent.manuscriptId)

    return !!(manuscript && manuscript.published)
  },
)

// Authors, reviewers and editors of the manuscript (any version) can see its reviews.
// Which reviews, and which of their fields, each of them gets is decided by
// stripConfidentialDataFromReviews when the reviews are fetched.
const userHasRoleInManuscriptOfReview = rule({ cache: 'strict' })(async (
  review,
  args,
  ctx,
) => {
  if (!ctx.userId || !review.manuscriptId) return false
  return cachedGet(`userHasRoleInMsFamily:${ctx.userId}:${review.manuscriptId}`)
})

const isAuthenticated = rule({ cache: 'contextual' })(async (
  parent,
  args,
  ctx,
) => {
  return !!ctx.userId
})

// Who can send a message to a channel?
// Configured like so now:
// if the channel is for 'all', then all associated with the manuscript can create messages
// if the channel is for 'editorial', only editors and admins can chat there
const userIsAllowedToChat = rule({ cache: 'strict' })(async (
  parent,
  args,
  ctx,
) => {
  if (!ctx.userId) return false

  const isUserGM = await cachedGet(
    `userIsGM:${ctx.userId}:${ctx.req.headers['group-id']}`,
  )

  if (isUserGM) return true

  const isUserGroupAdmin = await cachedGet(
    `userIsGroupAdmin:${ctx.userId}:${ctx.req.headers['group-id']}`,
  )

  if (isUserGroupAdmin) return true

  const isUserAdmin = await cachedGet(`userIsAdmin:${ctx.userId}`)
  if (isUserAdmin) return true

  const user = await User.query().findById(ctx.userId)

  const channel = await Channel.query().findById(args.channelId)

  /**
   * Chat channels are always associated with the parent manuscript
   * but we allow different teams to work on different versions.
   * Therefore, authorization is based on the latest version of the manuscript.
   */

  const manuscript = await getLatestVersionOfManuscript(
    ctx,
    channel.manuscriptId,
  )

  const isAuthor = await userIsMemberOfTeamWithRoleQuery(
    user,
    manuscript.id,
    'author',
  )

  const isReviewer = await userIsMemberOfTeamWithRoleQuery(
    user,
    manuscript.id,
    'reviewer',
  )

  const isEditor = await cachedGet(
    `userIsEditor:${ctx.userId}:${manuscript.id}`,
  )

  if (channel.type === 'all') {
    return isAuthor || isReviewer || isEditor
  }

  if (channel.type === 'editorial') {
    return isReviewer || isEditor
  }

  return false
})

const userIsReviewAuthorAndReviewIsNotCompleted = rule({
  cache: 'strict',
})(async (parent, args, ctx) => {
  if (!ctx.userId) return false
  let manuscriptId

  // updateReviewerTeamMemberStatus
  if (args.manuscriptId) manuscriptId = args.manuscriptId

  // updateReview
  if (!manuscriptId && args.id) {
    const review = await Review.query().findById(args.id)
    if (review) manuscriptId = review.manuscriptId
  }

  // updateReview DecisionForm fallback
  if (!manuscriptId && args.input && args.input.manuscriptId) {
    manuscriptId = args.input.manuscriptId
  }

  const manuscript = await Manuscript.query().findById(manuscriptId)

  const teams = await Team.query()
    .where({
      objectId: manuscript.id,
      objectType: 'manuscript',
    })
    .andWhere(builder => {
      builder.whereIn('role', ['reviewer', 'collaborativeReviewer'])
    })

  if (!teams) return false

  const member = await TeamMember.query()
    .whereIn(
      'teamId',
      teams.map(t => t.id),
    )
    .andWhere(builder => {
      builder.where({ userId: ctx.userId })
    })
    .first()

  if (member && member.status !== 'completed') return true
  return false
})

const userIsEditorOfTheManuscriptOfTheReview = rule({
  cache: 'strict',
})(async (parent, args, ctx) => {
  if (!ctx.userId) return false
  let manuscriptId

  // updateReviewerTeamMemberStatus
  if (args.manuscriptId) manuscriptId = args.manuscriptId

  // updateReview
  if (!manuscriptId && args.id) {
    const review = await Review.query().findById(args.id)
    if (review) manuscriptId = review.manuscriptId
  }

  // updateReview DecisionForm fallback
  if (!manuscriptId && args.input?.manuscriptId) {
    manuscriptId = args.input.manuscriptId
  }

  return cachedGet(`userIsEditor:${ctx.userId}:${manuscriptId}`)
})

const userIsReviewerOrInvitedReviewerOfTheManuscript = rule({
  cache: 'strict',
})(async (parent, args, ctx) => {
  if (!ctx.userId || !args.id) return false

  const parentId = (
    await Manuscript.query().findById(args.id).select('parentId')
  )?.parentId

  const reviewerStatuses = await Manuscript.query()
    .where(builder =>
      builder.where('manuscripts.id', parentId).orWhere({ parentId }),
    )
    .joinRelated('teams')
    .join('team_members', 'team_members.teamId', 'teams.id') // joinRelated doesn't automate the 'teams.members' relation well, so we do it manually
    .whereIn('teams.role', ['reviewer', 'collaborativeReviewer'])
    .where('team_members.userId', ctx.userId)
    .select('team_members.status')

  return !!reviewerStatuses.length
})

const userIsInvitedReviewer = rule({ cache: 'strict' })(async (
  parent,
  args,
  ctx,
) => {
  if (!ctx.userId) return false

  const team = await Team.query().findById(args.teamId)

  const member = await team
    .$relatedQuery('members')
    .where({ userId: ctx.userId, status: 'invited' })
    .first()

  return !!member
})

const userHasAcceptedInvitation = rule({ cache: 'strict' })(async (
  parent,
  args,
  ctx,
) => {
  if (!ctx.userId) return false

  const teamMember = await TeamMember.query()
    .where({ userId: ctx.userId, teamId: args.teamId })
    .whereIn('status', ['accepted', 'inProgress', 'completed'])
    .first()

  return !!teamMember
})

const userIsAuthorOfManuscript = rule({ cache: 'strict' })(async (
  parent,
  args,
  ctx,
) => {
  if (!ctx.userId || !args.id) return false

  const authorRecord = await Team.relatedQuery('members')
    .for(Team.query().where({ objectId: args.id, role: 'author' }))
    .findOne({ userId: ctx.userId })

  return !!authorRecord
})

// const userIsAuthorOfFilesAssociatedManuscript = rule({
//   cache: 'no_cache',
// })(async (parent, args, ctx, info) => {
//   if (!ctx.userId) return false
//   let manuscriptId

//   if (args.meta && args.meta.manuscriptId) {
//     // Meta is supplied for createFile
//     // eslint-disable-next-line prefer-destructuring
//     manuscriptId = args.meta.manuscriptId
//   } else if (args.id) {
//     // id is supplied for deletion
//     const file = await File.query().findById(args.id)
//     const manuscript = await cachedGet(`msOfFile:${file.id}`, ctx)
//     manuscriptId = manuscript && manuscript.id
//   }

//   if (!manuscriptId) return false

//   const team = await Team
//     .query()
//     .where({
//       objectId: manuscriptId,
//       objectType: 'manuscript',
//       role: 'author',
//     })
//     .first()

//   if (!team) return false
//   const members = await team.$relatedQuery('members').where('userId', ctx.userId)
//   if (members && members[0]) return true
//   return false
// })

// Authors, reviewers and editors of the manuscript (any version) can see its files,
// including files attached to its reviews.
const userHasRoleInManuscriptOfFile = rule({ cache: 'strict' })(async (
  file,
  args,
  ctx,
) => {
  if (!ctx.userId) return false

  if (file.storedObjects && !file.id) return true // only on uploading manuscript docx this will be validated

  if (!file.id) return false
  const manuscript = await cachedGet(`msOfFile:${file.id}`)
  if (!manuscript) return false

  return cachedGet(`userHasRoleInMsFamily:${ctx.userId}:${manuscript.id}`)
})

// iplaces Patch 20: assignUserAsAuthor only for the logged-in user, with an
// open AUTHOR invitation to that same manuscript (not answered, and not
// addressed to someone else). Was isAuthenticated: any logged-in user could
// add anyone to any manuscript's author team.
const userHasOpenAuthorInvitation = rule({ cache: 'strict' })(async (
  parent,
  args,
  ctx,
) => {
  if (!ctx.userId || args.userId !== ctx.userId || !args.invitationId)
    return false

  const invitation = await Invitation.query().findById(args.invitationId)

  return (
    !!invitation &&
    invitation.invitedPersonType === 'AUTHOR' &&
    invitation.manuscriptId === args.manuscriptId &&
    invitation.status === 'UNANSWERED' &&
    !invitation.responseDate &&
    (!invitation.userId || invitation.userId === ctx.userId)
  )
})

// iplaces Patch 21: authors may not change a version whose status is
// 'published'. Editors, group managers and admins still can (and unpublishing
// is theirs too). Authors who need a change ask an editor, or start a new
// version where the station allows it.
const manuscriptIsNotPublished = rule({ cache: 'strict' })(async (
  parent,
  args,
) => {
  if (!args.id) return false

  const manuscript = await Manuscript.query().select('status').findById(args.id)

  return !!manuscript && manuscript.status !== 'published'
})

// iplaces Patch 24: updateInvitationStatus was `allow`, so anyone holding an
// invitation id could mark it ACCEPTED for any userId. Declining stays open
// (the decline link in the invitation email works without a login), but
// accepting needs the logged-in invitee, on an invitation that is still
// unanswered and not addressed to someone else.
const userCanRespondToInvitation = rule({ cache: 'strict' })(async (
  parent,
  args,
  ctx,
) => {
  if (!args.id) return false
  const invitation = await Invitation.query().findById(args.id)
  if (!invitation || invitation.status !== 'UNANSWERED') return false

  if (args.status === 'REJECTED') return !args.userId

  return (
    args.status === 'ACCEPTED' &&
    !!ctx.userId &&
    args.userId === ctx.userId &&
    (!invitation.userId || invitation.userId === ctx.userId)
  )
})

// iplaces Patch 24: addEmailToBlacklist was `allow` (anyone could stop a
// station from emailing any address). Now only for an address whose
// invitation to a record in that group was declined with "do not contact".
const emailDeclinedWithDoNotContact = rule({ cache: 'strict' })(async (
  parent,
  args,
) => {
  if (!args.email || !args.groupId) return false

  const declined = await Invitation.query()
    .join('manuscripts', 'manuscripts.id', 'invitations.manuscriptId')
    .where({
      'invitations.toEmail': args.email,
      'invitations.declinedReason': 'DO_NOT_CONTACT',
      'manuscripts.groupId': args.groupId,
    })
    .first()

  return !!declined
})

// iplaces Patch 24: addReviewer was isAuthenticated, so any logged-in user
// could put anyone on any record's reviewer team (and reviewers can read the
// whole record). Now editors and managers, or the invitee accepting their
// own open REVIEWER / COLLABORATIVE_REVIEWER invitation to that record.
const userHasOpenReviewerInvitation = rule({ cache: 'strict' })(async (
  parent,
  args,
  ctx,
) => {
  if (!ctx.userId || args.userId !== ctx.userId || !args.invitationId)
    return false

  const invitation = await Invitation.query().findById(args.invitationId)

  return (
    !!invitation &&
    invitation.invitedPersonType ===
      (args.isCollaborative ? 'COLLABORATIVE_REVIEWER' : 'REVIEWER') &&
    invitation.manuscriptId === args.manuscriptId &&
    invitation.status === 'UNANSWERED' &&
    !invitation.responseDate &&
    (!invitation.userId || invitation.userId === ctx.userId)
  )
})

// iplaces Patch 25: deleteFile(s), updateFile and updateTagsFile were
// isAuthenticated for any file id. Now:
// - a record's file (or a file on one of its reviews): its editors, the
//   station's group managers and group admins, its authors while the version
//   is not published (as Patch 21), and for a review file the reviewer;
// - any other file (logos, CMS and export-template assets): group managers
//   and group admins of the current group;
// - admins: everything.
const userCanChangeFile = async (ctx, fileId) => {
  if (!ctx.userId || !fileId) return false
  if (await cachedGet(`userIsAdmin:${ctx.userId}`)) return true

  const { File } = require('@coko/server')
  const file = await File.query().findById(fileId)
  if (!file) return false

  const manuscript = file.objectId
    ? await cachedGet(`msOfFile:${file.id}`)
    : null

  if (!manuscript) {
    const groupId = ctx.req?.headers['group-id']
    if (!groupId || groupId === 'undefined') return false

    return (
      (await cachedGet(`userIsGroupAdmin:${ctx.userId}:${groupId}`)) ||
      cachedGet(`userIsGM:${ctx.userId}:${groupId}`)
    )
  }

  if (
    (await cachedGet(`userIsEditor:${ctx.userId}:${manuscript.id}`)) ||
    (await cachedGet(`userIsGM:${ctx.userId}:${manuscript.groupId}`)) ||
    (await cachedGet(`userIsGroupAdmin:${ctx.userId}:${manuscript.groupId}`))
  )
    return true

  if (file.objectId !== manuscript.id) {
    // A review's file: the review's own author, or a member of the record's
    // reviewer teams (collaborative reviews have no single owner).
    const review = await Review.query().findById(file.objectId)
    if (review?.userId === ctx.userId) return true
    const user = await User.query().findById(ctx.userId)

    return (
      (await userIsMemberOfTeamWithRoleQuery(
        user,
        manuscript.id,
        'reviewer',
      )) ||
      userIsMemberOfTeamWithRoleQuery(
        user,
        manuscript.id,
        'collaborativeReviewer',
      )
    )
  }

  if (manuscript.status === 'published') return false
  const user = await User.query().findById(ctx.userId)
  return userIsMemberOfTeamWithRoleQuery(user, manuscript.id, 'author')
}

const userCanChangeFileById = rule({ cache: 'strict' })(
  async (parent, args, ctx) =>
    userCanChangeFile(ctx, args.id ?? args.input?.id),
)

const userCanChangeAllFiles = rule({ cache: 'strict' })(async (
  parent,
  args,
  ctx,
) => {
  if (!args.ids?.length) return false

  const allowed = await Promise.all(
    args.ids.map(id => userCanChangeFile(ctx, id)),
  )

  return allowed.every(Boolean)
})

// iplaces Patch 28: createFile and uploadFiles were isAuthenticated, so any
// logged-in user could attach a file to any record, review, config or CMS
// layout. Now the same people as Patch 25 can change files:
// - on a record: its editors, the station's group managers and group admins,
//   and its authors while the version is not published;
// - on a review: those editors and managers, the review's own author, and the
//   record's reviewers (not on a decision);
// - on anything else (logo, favicon, CMS layout, or no object): group
//   managers and group admins of the current group;
// - admins: everything.
// createFile's meta.manuscriptId must be the review's record (any version)
// when a reviewId is given, as it also names the storage folder.
const userCanAddFileTo = async (ctx, objectId, manuscriptIdOfReview) => {
  if (!ctx.userId) return false
  if (await cachedGet(`userIsAdmin:${ctx.userId}`)) return true

  const review = objectId ? await Review.query().findById(objectId) : null

  const manuscript =
    objectId &&
    (await Manuscript.query().findById(review ? review.manuscriptId : objectId))

  if (!manuscript) {
    if (review) return false
    const groupId = ctx.req?.headers['group-id']
    if (!groupId || groupId === 'undefined') return false

    if (objectId) {
      const CmsLayout = require('./models/cmsLayout/cmsLayout.model')

      const owner =
        (await Config.query().select('groupId').findById(objectId)) ||
        (await CmsLayout.query().select('groupId').findById(objectId))

      if (owner && owner.groupId !== groupId) return false
    }

    return (
      (await cachedGet(`userIsGroupAdmin:${ctx.userId}:${groupId}`)) ||
      cachedGet(`userIsGM:${ctx.userId}:${groupId}`)
    )
  }

  if (review && manuscriptIdOfReview !== undefined) {
    const named = await Manuscript.query()
      .select('id', 'parentId')
      .findById(manuscriptIdOfReview)

    if (
      !named ||
      (named.parentId || named.id) !== (manuscript.parentId || manuscript.id)
    )
      return false
  }

  if (
    (await cachedGet(`userIsEditor:${ctx.userId}:${manuscript.id}`)) ||
    (await cachedGet(`userIsGM:${ctx.userId}:${manuscript.groupId}`)) ||
    (await cachedGet(`userIsGroupAdmin:${ctx.userId}:${manuscript.groupId}`))
  )
    return true

  const user = await User.query().findById(ctx.userId)

  if (review) {
    if (review.isDecision) return false
    if (review.userId === ctx.userId) return true

    return (
      (await userIsMemberOfTeamWithRoleQuery(
        user,
        manuscript.id,
        'reviewer',
      )) ||
      userIsMemberOfTeamWithRoleQuery(
        user,
        manuscript.id,
        'collaborativeReviewer',
      )
    )
  }

  if (manuscript.status === 'published') return false
  return userIsMemberOfTeamWithRoleQuery(user, manuscript.id, 'author')
}

// cache 'no_cache': a 'strict' cache hashes the args, and the Upload promise
// in them makes that fail, which denies every upload.
const userCanCreateFile = rule({ cache: 'no_cache' })(
  async (parent, args, ctx) =>
    userCanAddFileTo(
      ctx,
      args.meta?.reviewId || args.meta?.manuscriptId,
      args.meta?.reviewId ? args.meta.manuscriptId : undefined,
    ),
)

const userCanUploadFiles = rule({ cache: 'no_cache' })(
  async (parent, args, ctx) => userCanAddFileTo(ctx, args.entityId),
)

const userIsCurrentUser = rule({ cache: 'strict' })(async (
  parent,
  args,
  ctx,
) => {
  if (!ctx.userId || !args.id) return false
  return ctx.userId === args.id
})

const isForManuscriptsPublishedSinceDateQuery = rule()(async (
  parent,
  args,
  ctx,
  info,
) => {
  let { path } = info

  while (path) {
    if (path.key === 'manuscriptsPublishedSinceDate') return true
    path = path.prev
  }

  return false
})

/**
 * Only the following users may publish:
 * - a group admin, OR
 * - an editor AND the control panel config allows, OR
 * - a group manager AND the control panel config allows
 */
const userCanPublishManuscript = rule({ cache: 'strict' })(async (
  parent,
  args,
  ctx,
) => {
  const groupId = ctx.req.headers['group-id']
  if (!ctx.userId || !groupId || groupId === 'undefined') return false
  const manuscriptId = parent?.manuscriptId ?? args?.id
  if (!manuscriptId)
    throw new Error('No manuscriptId for userCanPublishManuscript!')

  const activeConfig = await Config.query().findOne({
    groupId,
    active: true,
  })

  const isGroupAdmin = await cachedGet(
    `userIsGroupAdmin:${ctx.userId}:${groupId}`,
  )

  const isEditor = await cachedGet(`userIsEditor:${ctx.userId}:${manuscriptId}`)

  const isGm = await cachedGet(`userIsGM:${ctx.userId}:${groupId}`)

  return (
    isGroupAdmin ||
    (isEditor && activeConfig?.formData.controlPanel.editorsCanPublish) ||
    (isGm && activeConfig?.formData.controlPanel.groupManagersCanPublish)
  )
})

const permissions = {
  Query: {
    authorsActivity: or(userIsGroupAdmin, userIsAdmin),
    builtCss: isAuthenticated,
    config: isAuthenticated,
    convertToJats: or(
      userIsEditorOfAnyManuscript,
      userIsGm,
      userIsGroupAdmin,
      userIsAdmin,
    ),
    convertToPdf: or(
      userIsEditorOfAnyManuscript,
      userIsGm,
      userIsGroupAdmin,
      userIsAdmin,
    ),
    currentUser: isAuthenticated,
    docmap: allow,
    editorsActivity: or(userIsGroupAdmin, userIsAdmin),
    file: deny, // Never used
    files: deny, // Never used
    form: isAuthenticated,
    formForPurposeAndCategory: allow,
    forms: allow,
    formsByCategory: or(userIsGroupAdmin, userIsAdmin),
    getBlacklistInformation: or(
      userIsEditorOfAnyManuscript,
      userIsGm,
      userIsGroupAdmin,
      userIsAdmin,
    ),
    getEntityFiles: isAuthenticated,
    getInvitationsForManuscript: or(
      userIsEditorOfAnyManuscript,
      userIsGm,
      userIsGroupAdmin,
      userIsAdmin,
    ),
    getFilesByTagOrId: allow,
    getSpecificFiles: isAuthenticated,
    globalTeams: deny, // Never used
    group: allow,
    groups: allow,
    invitationManuscriptId: isAuthenticated,
    invitationStatus: allow,
    manuscript: or(
      userIsGm,
      userIsGroupAdmin,
      userIsAdmin,
      // iplaces Patch 23: no longer open to any logged-in user once
      // published (Patch 19 kept that, and it showed author emails to users
      // with no role on the record). The public article view uses
      // publishedManuscript, which strips emails.
      userIsEditor,
      userIsAuthorOfManuscript,
      userIsReviewerOrInvitedReviewerOfTheManuscript,
    ),
    manuscripts: userIsAdmin, // iplaces Patch 23: every record of every group, unused by the client
    manuscriptsActivity: or(userIsGroupAdmin, userIsAdmin),
    manuscriptsPublishedSinceDate: allow,
    manuscriptsUserHasCurrentRoleIn: isAuthenticated,
    message: deny, // Never used
    messages: isAuthenticated,
    orcidValidate: isAuthenticated,
    paginatedManuscripts: or(userIsGm, userIsGroupAdmin, userIsAdmin),
    paginatedUsers: or(userIsGroupAdmin, userIsAdmin),
    publishedArtifacts: allow,
    publishedManuscript: allow,
    publishedManuscripts: allow,
    publishingCollection: allow,
    reviewersActivity: or(userIsGroupAdmin, userIsAdmin),
    searchRor: allow,
    searchUsers: isAuthenticated,
    summaryActivity: or(userIsGroupAdmin, userIsAdmin),
    systemWideDiscussionChannel: or(userIsGm, userIsGroupAdmin, userIsAdmin),
    tasks: or(userIsGm, userIsGroupAdmin, userIsAdmin),
    team: deny, // Never used
    teams: isAuthenticated,
    threadedDiscussions: isAuthenticated,
    unreviewedPreprints: allow, // This has its own token-based authentication.
    user: isAuthenticated,
    userHasTaskAlerts: isAuthenticated,
    users: or(
      userIsEditorOfAnyManuscript,
      userIsGm,
      userIsGroupAdmin,
      userIsAdmin,
    ),
    validateDOI: isAuthenticated,
    validateSuffix: isAuthenticated,
    versionsOfManuscriptCurrentUserIsReviewerOf: allow,
    events: or(userIsGm, userIsGroupAdmin, userIsAdmin),
    // iplaces Patch 26: operations with no rule fall back to graphql-shield's default, `allow`,
    // so these were open without a login. Read-only site/CMS queries stay
    // public (Flax and logged-out pages may read them); everything else needs a
    // login, and admin-type queries the matching role.
    articleTemplate: isAuthenticated,
    buildCitations: isAuthenticated,
    buildCitationsCSL: isAuthenticated,
    channelUsersForMention: isAuthenticated,
    cmsLayout: allow,
    cmsPage: allow,
    cmsPages: allow,
    coarNotificationsForManuscript: or(
      userIsEditorOfAnyManuscript,
      userIsGm,
      userIsGroupAdmin,
      userIsAdmin,
    ),
    docxToHtml: isAuthenticated,
    doisToRegister: isAuthenticated,
    emailTemplates: isAuthenticated,
    flaxHealthCheck: allow,
    getActiveCmsFilesTree: allow,
    getCmsFileContent: allow,
    getCmsFilesTree: allow,
    getEmailInvitedReviewers: or(
      userIsEditorOfAnyManuscript,
      userIsGm,
      userIsGroupAdmin,
      userIsAdmin,
    ),
    getFoldersList: allow,
    getManuscriptsData: or(
      userIsEditorOfAnyManuscript,
      userIsGm,
      userIsGroupAdmin,
      userIsAdmin,
    ),
    getVariables: isAuthenticated,
    groupByName: allow,
    notificationOption: isAuthenticated,
    oldConfig: allow,
    openAi: isAuthenticated,
    paginatedCoarNotificationsForGroupOrNone: or(
      userIsGm,
      userIsGroupAdmin,
      userIsAdmin,
    ),
    searchLocalContext: isAuthenticated,
    unreadMessagesCount: isAuthenticated,
    updateChannelLastViewed: isAuthenticated,
  },
  Mutation: {
    // iplaces Patch 24 (was allow)
    addEmailToBlacklist: or(
      emailDeclinedWithDoNotContact,
      userIsEditorOfAnyManuscript,
      userIsGm,
      userIsGroupAdmin,
      userIsAdmin,
    ),
    // iplaces Patch 24 (was isAuthenticated)
    addReviewer: or(
      userHasOpenReviewerInvitation,
      userIsEditorOfAnyManuscript,
      userIsGm,
      userIsGroupAdmin,
      userIsAdmin,
    ),
    archiveManuscript: or(userIsGm, userIsGroupAdmin, userIsAdmin),
    archiveManuscripts: or(userIsGm, userIsGroupAdmin, userIsAdmin),
    assignTeamEditor: deny, // Never used
    assignUserAsAuthor: userHasOpenAuthorInvitation, // iplaces Patch 20
    completeComment: isAuthenticated,
    completeComments: isAuthenticated,
    // createDocxToHTMLJob seems to be exposed from xsweet???
    createFile: userCanCreateFile, // iplaces Patch 28 (was isAuthenticated)
    createForm: or(userIsGroupAdmin, userIsAdmin),
    createCollection: or(userIsGm, userIsGroupAdmin, userIsAdmin),
    createManuscript: and(isAuthenticated, userIsNotSubmitBlocked),
    createMessage: userIsAllowedToChat,
    createNewTaskAlerts: or(userIsGm, userIsGroupAdmin, userIsAdmin), // Only used when test code is enabled
    createNewVersion: and(
      or(
        userIsAuthorOfManuscript,
        userIsEditor,
        userIsGm,
        userIsGroupAdmin,
        userIsAdmin,
      ),
      userIsNotSubmitBlocked,
    ),
    createTeam: or(
      userIsEditorOfAnyManuscript,
      userIsGm,
      userIsGroupAdmin,
      userIsAdmin,
    ), // TODO scrap this mutation in favour of an 'assignEditor' mutation
    deleteCollection: or(userIsGm, userIsGroupAdmin, userIsAdmin),
    deleteFile: userCanChangeFileById, // iplaces Patch 25 (was isAuthenticated)
    deleteFiles: userCanChangeAllFiles, // iplaces Patch 25
    deleteForm: or(userIsGroupAdmin, userIsAdmin),
    deleteFormElement: or(userIsGroupAdmin, userIsAdmin),
    deleteManuscript: deny, // Never used
    deleteManuscripts: deny, // Never used
    deletePendingComment: isAuthenticated,
    deleteUser: or(userIsGroupAdmin, userIsAdmin),
    deleteMessage: or(
      userOwnsMessage,
      and(userIsGm, userIsGroupAdmin, userIsAdmin),
    ),
    importManuscripts: or(userIsGm, userIsGroupAdmin, userIsAdmin),
    makeDecision: or(
      userIsEditorOfAnyManuscript,
      userIsGm,
      userIsGroupAdmin,
      userIsAdmin,
    ),
    publishManuscript: userCanPublishManuscript,
    refreshAdaStatus: or(userIsAdmin, userIsEditor, userIsGm, userIsGroupAdmin),
    removeAuthor: or(
      userIsEditorOfAnyManuscript,
      userIsGm,
      userIsGroupAdmin,
      userIsAdmin,
    ),
    removeReviewer: or(
      userIsEditorOfAnyManuscript,
      userIsGm,
      userIsGroupAdmin,
      userIsAdmin,
    ),
    removeTaskAlertsForCurrentUser: isAuthenticated,
    reviewerResponse: or(userIsInvitedReviewer, userHasAcceptedInvitation),
    sendEmail: or(
      userIsEditorOfAnyManuscript,
      userIsGm,
      userIsGroupAdmin,
      userIsAdmin,
    ),
    setGlobalRole: userIsAdmin,
    setGroupRole: or(userIsGroupAdmin, userIsAdmin),
    setShouldPublishField: or(
      userIsEditorOfAnyManuscript,
      userIsGm,
      userIsGroupAdmin,
      userIsAdmin,
    ),
    submitManuscript: and(
      or(
        and(userIsAuthorOfManuscript, manuscriptIsNotPublished), // iplaces Patch 21
        userIsEditor,
        userIsGm,
        userIsGroupAdmin,
        userIsAdmin,
      ),
      userIsNotSubmitBlocked,
    ),
    submitAuthorProofingFeedback: userIsAuthorOfManuscript,
    unarchiveManuscripts: or(userIsGm, userIsGroupAdmin, userIsAdmin),
    updateAda: or(userIsAdmin, userIsEditor, userIsGm, userIsGroupAdmin),
    updateCollection: or(userIsGm, userIsGroupAdmin, userIsAdmin),
    updateEmail: or(userIsCurrentUser, userIsGm, userIsGroupAdmin, userIsAdmin),
    updateConfig: or(userIsGroupAdmin, userIsAdmin),
    updateUsername: or(
      userIsCurrentUser,
      userIsGm,
      userIsGroupAdmin,
      userIsAdmin,
    ),
    updateFile: userCanChangeFileById, // iplaces Patch 25 (was isAuthenticated)
    updateForm: or(userIsGroupAdmin, userIsAdmin),
    updateFormElement: or(userIsGroupAdmin, userIsAdmin),
    updateInvitationResponse: allow,
    updateInvitationStatus: or(userCanRespondToInvitation, userIsAdmin), // iplaces Patch 24 (was allow)
    updateManuscript: or(
      and(userIsAuthorOfManuscript, manuscriptIsNotPublished), // iplaces Patch 21
      userIsEditor,
      userIsGm,
      userIsGroupAdmin,
      userIsAdmin,
    ),
    updatePendingComment: isAuthenticated,
    updateReview: or(
      userIsReviewAuthorAndReviewIsNotCompleted,
      userIsEditorOfTheManuscriptOfTheReview,
      userIsEditorOfAnyManuscript, // Probably not needed, but just in case
      userIsGm,
      userIsGroupAdmin,
      userIsAdmin,
    ),
    updateTask: or(
      userIsEditorOfAnyManuscript,
      userIsGm,
      userIsGroupAdmin,
      userIsAdmin,
    ),
    updateTasks: or(
      userIsEditorOfAnyManuscript,
      userIsGm,
      userIsGroupAdmin,
      userIsAdmin,
    ),
    updateTaskNotification: or(
      userIsEditorOfAnyManuscript,
      userIsGm,
      userIsGroupAdmin,
      userIsAdmin,
    ),
    updateTeam: or(
      userIsEditorOfAnyManuscript,
      userIsGm,
      userIsGroupAdmin,
      userIsAdmin,
    ),
    updateTeamMember: or(
      userIsEditorOfAnyManuscript,
      userIsGm,
      userIsGroupAdmin,
      userIsAdmin,
    ),
    updateReviewerTeamMemberStatus: or(
      userIsReviewAuthorAndReviewIsNotCompleted,
      userIsEditorOfTheManuscriptOfTheReview,
    ),
    lockUnlockCollaborativeReview: or(
      userIsGm,
      userIsGroupAdmin,
      userIsAdmin,
      userIsReviewAuthorAndReviewIsNotCompleted,
      userIsEditorOfTheManuscriptOfTheReview,
    ),
    updateUser: or(userIsGm, userIsGroupAdmin, userIsAdmin),
    uploadFile: isAuthenticated,
    uploadFiles: userCanUploadFiles, // iplaces Patch 28 (was isAuthenticated)
    updateTaskStatus: isAuthenticated,
    updateCMSPage: or(userIsGroupAdmin, userIsAdmin),
    createCMSPage: or(userIsGroupAdmin, userIsAdmin),
    deleteCMSPage: or(userIsGroupAdmin, userIsAdmin),
    updateCMSLayout: or(userIsGroupAdmin, userIsAdmin),
    rebuildFlaxSite: or(userIsGroupAdmin, userIsAdmin),
    updateMessage: or(userOwnsMessage, userIsGm, userIsGroupAdmin, userIsAdmin),
    createNotification: or(userIsGm, userIsGroupAdmin, userIsAdmin),
    updateNotification: or(userIsGm, userIsGroupAdmin, userIsAdmin),
    deleteNotification: or(userIsGm, userIsGroupAdmin, userIsAdmin),
    setNotificationActive: or(userIsGm, userIsGroupAdmin, userIsAdmin),
    setEventActive: or(userIsGm, userIsGroupAdmin, userIsAdmin),
    // iplaces Patch 26: mutations with no rule fell back to `allow` (no login
    // needed), including CMS file delete/rename/update, email templates and
    // API token creation. Each now has the role its page is built for.
    addResourceToFolder: or(userIsGroupAdmin, userIsAdmin),
    assignAuthorForProofingManuscript: or(
      userIsEditorOfAnyManuscript,
      userIsGm,
      userIsGroupAdmin,
      userIsAdmin,
    ),
    channelViewed: isAuthenticated,
    createEmailTemplate: or(userIsGm, userIsGroupAdmin, userIsAdmin),
    createTaskEmailNotificationLog: or(
      userIsEditorOfAnyManuscript,
      userIsGm,
      userIsGroupAdmin,
      userIsAdmin,
    ),
    deleteEmailTemplate: or(userIsGm, userIsGroupAdmin, userIsAdmin),
    deleteResource: or(userIsGroupAdmin, userIsAdmin),
    deleteTaskNotification: or(
      userIsEditorOfAnyManuscript,
      userIsGm,
      userIsGroupAdmin,
      userIsAdmin,
    ),
    generateNewToken: or(userIsGroupAdmin, userIsAdmin),
    removeInvitation: or(
      userIsEditorOfAnyManuscript,
      userIsGm,
      userIsGroupAdmin,
      userIsAdmin,
    ),
    renameResource: or(userIsGroupAdmin, userIsAdmin),
    reportUserIsActive: isAuthenticated,
    resendCoarNotifyPayload: or(userIsGm, userIsGroupAdmin, userIsAdmin),
    updateCollaborativeTeamMembers: or(
      userIsEditorOfAnyManuscript,
      userIsGm,
      userIsGroupAdmin,
      userIsAdmin,
    ),
    updateEmailTemplate: or(userIsGm, userIsGroupAdmin, userIsAdmin),
    updateFlaxRootFolder: or(userIsGroupAdmin, userIsAdmin),
    updateLanguage: or(userIsCurrentUser, userIsGroupAdmin, userIsAdmin),
    updateNotificationOption: isAuthenticated,
    updateRecentTab: isAuthenticated,
    updateResource: or(userIsGroupAdmin, userIsAdmin),
    updateSharedStatusForInvitedReviewer: or(
      userIsEditorOfAnyManuscript,
      userIsGm,
      userIsGroupAdmin,
      userIsAdmin,
    ),
    updateTagsFile: userCanChangeFileById,
    updateTemplate: or(
      userIsEditorOfAnyManuscript,
      userIsGm,
      userIsGroupAdmin,
      userIsAdmin,
    ),
  },
  Subscription: {
    fileUpdated: isAuthenticated,
    filesDeleted: isAuthenticated,
    filesUploaded: isAuthenticated,
    reviewFormUpdated: isAuthenticated,
    manuscriptsImportStatus: isAuthenticated,
    /**
     * This was not being triggered at all before the v3 upgrade.
     * It doesn't work because userIsAllowedToChat dependends on req, and req
     * is not in the context for subscriptions.
     */
    // messageCreated: userIsAllowedToChat,
    messageCreated: isAuthenticated,
    // iplaces Patch 26: were unlisted, so open without a login.
    messageDeleted: isAuthenticated,
    messageUpdated: isAuthenticated,
  },
  CurrentRole: isAuthenticated,
  Team: isAuthenticated,
  TeamMember: isAuthenticated,
  User: isAuthenticated,
  Group: allow,
  Config: allow,
  PaginatedManuscripts: allow,
  Manuscript: allow,
  File: lazyOr(
    isForManuscriptsPublishedSinceDateQuery,
    isExportTemplatingFile,
    isCMSFile,
    isPublishingCollection,
    isLogoFile,
    isFaviconFile,
    isPublicFileFromPublishedManuscript,
    isFileOfCurrentGroup,
    userHasRoleInManuscriptOfFile,
    userIsEditorOfAnyManuscript,
    userIsGm,
    userIsGroupAdmin,
    userIsAdmin,
  ),
  FileNotInDb: allow,
  Form: allow,
  FormStructure: allow,
  FormElement: allow,
  FormElementOption: allow,
  FormElementValidation: allow,
  Review: or(
    isPublicReviewFromPublishedManuscript,
    userHasRoleInManuscriptOfReview,
    userIsEditorOfAnyManuscript,
    userIsGm,
    userIsGroupAdmin,
    userIsAdmin,
  ),
  Channel: isAuthenticated,
  Message: isAuthenticated,
  MessagesRelay: isAuthenticated,
  PageInfo: isAuthenticated,
  ManuscriptMeta: allow,
  Note: isAuthenticated,
  Identity: isAuthenticated,
  PublishedManuscript: allow,
}

module.exports = permissions
