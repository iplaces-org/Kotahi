// iplaces Patch 18: link users to manuscripts by ORCID.
// A user whose ORCID appears in a manuscript's submission.$authors is added to
// that manuscript's author team (full author rights), so it shows under
// "My Submissions". Runs at ORCID login (all manuscripts listing the ORCID, any
// group) and after a save that touches $authors (authors who already have a
// login). Add-only: removing someone from $authors does not remove them.
// Every caller treats failures as non-fatal.

const { raw } = require('objection')
const { logger } = require('@coko/server')

const ORCID_PATTERN = /^\d{4}-\d{4}-\d{4}-\d{3}[\dX]$/

// https://orcid.org/0000-..., http://www.orcid.org/..., or bare -> bare, upper-case X
const normalizeOrcid = value =>
  String(value || '')
    .trim()
    .replace(/^https?:\/\/(www\.)?orcid\.org\//i, '')
    .trim()
    .toUpperCase()

const isValidOrcid = bare => ORCID_PATTERN.test(bare)

// Same normalisation, in SQL, for an author entry's orcid
const SQL_AUTHOR_ORCID = `upper(trim(regexp_replace(trim(a->>'orcid'), '^https?://(www\\.)?orcid\\.org/', '', 'i')))`

const ensureAuthorOnManuscript = async (manuscriptId, userId) => {
  // lazy requires: models/controllers require services, avoid a load-order cycle
  const { Manuscript, Team, TeamMember } = require('../models')

  const {
    addUserToManuscriptChatChannel,
  } = require('../controllers/channel.controllers')

  let team = await Manuscript.relatedQuery('teams')
    .for(manuscriptId)
    .where('role', 'author')
    .first()

  if (!team) {
    team = await Team.query().insert({
      objectId: manuscriptId,
      objectType: 'manuscript',
      role: 'author',
      displayName: 'Author',
    })
  }

  const alreadyMember =
    (await TeamMember.query()
      .where({ teamId: team.id, userId })
      .resultSize()) > 0

  if (alreadyMember) return false

  await TeamMember.query().insert({ teamId: team.id, userId })

  try {
    await addUserToManuscriptChatChannel({ manuscriptId, userId })
  } catch (e) {
    logger.warn(
      `Patch 18: chat channel add skipped for ${userId} on ${manuscriptId}: ${e.message}`,
    )
  }

  return true
}

/** At ORCID login: add the user to the author team of every manuscript (any
 * group, any version) whose $authors lists this ORCID. Returns count added. */
const linkUserToManuscriptsByOrcid = async (userId, orcid) => {
  const bare = normalizeOrcid(orcid)
  if (!userId || !isValidOrcid(bare)) return 0

  const { Manuscript } = require('../models')

  const { rows } = await Manuscript.knex().raw(
    `SELECT DISTINCT m.id
       FROM manuscripts m,
            jsonb_array_elements(
              CASE WHEN jsonb_typeof(m.submission->'$authors') = 'array'
                   THEN m.submission->'$authors' ELSE '[]'::jsonb END
            ) a
      WHERE ${SQL_AUTHOR_ORCID} = ?`,
    [bare],
  )

  let added = 0

  // eslint-disable-next-line no-restricted-syntax
  for (const { id } of rows) {
    // eslint-disable-next-line no-await-in-loop
    if (await ensureAuthorOnManuscript(id, userId)) added += 1
  }

  if (added)
    logger.info(
      `Patch 18: login link added user ${userId} (ORCID ${bare}) to ${added} manuscript(s)`,
    )

  return added
}

/** After a save: add each listed author whose ORCID belongs to an existing
 * user to this manuscript's author team. Returns count added. */
const linkAuthorsOfManuscript = async manuscript => {
  const authors = manuscript?.submission?.$authors
  if (!manuscript?.id || !Array.isArray(authors)) return 0

  const orcids = [
    ...new Set(
      authors.map(a => normalizeOrcid(a && a.orcid)).filter(isValidOrcid),
    ),
  ]

  if (!orcids.length) return 0

  const { Identity } = require('../models')

  const identities = await Identity.query()
    .select('userId')
    .where('type', 'orcid')
    .whereIn(raw('upper(trim(identifier))'), orcids)

  let added = 0

  // eslint-disable-next-line no-restricted-syntax
  for (const userId of [...new Set(identities.map(i => i.userId))]) {
    // eslint-disable-next-line no-await-in-loop
    if (await ensureAuthorOnManuscript(manuscript.id, userId)) added += 1
  }

  if (added)
    logger.info(
      `Patch 18: save link added ${added} ORCID author(s) to manuscript ${manuscript.id}`,
    )

  return added
}

module.exports = {
  normalizeOrcid,
  linkUserToManuscriptsByOrcid,
  linkAuthorsOfManuscript,
}
