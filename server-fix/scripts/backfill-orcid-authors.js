// iplaces Patch 18 one-off backfill: for every user with an ORCID login, join
// the author team of each manuscript whose $authors lists that ORCID. Same code
// path as the login hook, so it is idempotent (re-running adds nothing).
// Run inside the server container from /home/node/app:
//   node backfill-orcid-authors.js
/* eslint-disable no-console, no-restricted-syntax, no-await-in-loop */
const { Identity } = require('./models')

const {
  linkUserToManuscriptsByOrcid,
} = require('./services/orcidAuthorLink.service')

const main = async () => {
  const identities = await Identity.query().where('type', 'orcid')
  let total = 0

  for (const identity of identities) {
    const added = await linkUserToManuscriptsByOrcid(
      identity.userId,
      identity.identifier,
    )

    if (added) console.log(`${identity.identifier}: +${added}`)
    total += added
  }

  console.log(`BACKFILL DONE: ${identities.length} ORCID users, ${total} memberships added`)
}

main()
  .then(() => process.exit(0))
  .catch(e => {
    console.error('BACKFILL FAILED', e)
    process.exit(1)
  })
