// iplaces: mint a Kotahi login token for cms-sync, inside the server container.
// cms-sync.js copies this file to /home/node/app over `fly ssh`, runs it, reads
// the TOKEN= line into memory and deletes the file. Nothing is written to disk,
// nothing in the database changes. The token is the same kind Kotahi gives at
// login (same signing key, same lifetime), for a global admin, so it can read
// and write every station's CMS files and ask Flax to rebuild.
//   node .cms-sync-mint.js              oldest global admin
//   node .cms-sync-mint.js --as <name>  that user (must be a global admin)
/* eslint-disable no-console */
const main = async () => {
  const asIdx = process.argv.indexOf('--as')
  const wanted = asIdx > -1 ? process.argv[asIdx + 1] : null

  const { config, db, createJWT } = require('@coko/server')
  await config.init()
  db.init()

  const admins = await db('team_members as m')
    .join('teams as t', 't.id', 'm.team_id')
    .join('users as u', 'u.id', 'm.user_id')
    .where({ 't.role': 'admin', 't.global': true })
    .select('u.id', 'u.username', 'u.created')
    .orderBy('u.created', 'asc')

  if (!admins.length) throw new Error('no global admin user found')
  const user = wanted ? admins.find(a => a.username === wanted) : admins[0]
  if (!user) throw new Error(`"${wanted}" is not a global admin (admins: ${admins.map(a => a.username).join(', ')})`)

  console.log(`USER=${user.username}`)
  console.log(`TOKEN=${createJWT({ id: user.id, username: user.username })}`)
}

main()
  .then(() => process.exit(0))
  .catch(err => {
    console.log(`MINT_FAILED=${err.message}`)
    process.exit(1)
  })
