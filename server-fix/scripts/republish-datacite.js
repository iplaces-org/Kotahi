// iplaces one-off: re-send existing records' metadata to DataCite WITHOUT the
// Flax site rebuild. Loads only the DataCite service (not the whole server),
// so it is light enough to run next to the live server on a 1 GB machine.
// Use after a data fix (licence, authors...) when the DOI already exists; the
// station pages get the same data at the next cms-sync push / publish.
// Run inside the server container from /home/node/app:
//   node republish-datacite.js gumpstation 130 16 55
/* eslint-disable no-console, no-restricted-syntax, no-await-in-loop */
const fs = require('fs')
const sleep = ms => new Promise(r => setTimeout(r, ms))

const main = async () => {
  const [groupName, ...shortIds] = process.argv.slice(2).filter(a => !a.startsWith('--'))
  if (!groupName || !shortIds.length) throw new Error('usage: node republish-datacite.js <group> <shortId>...')

  const { config, db } = require('@coko/server')
  await config.init()
  db.init()

  const svc = fs.existsSync('./dist/services/publishing/datacite/index.js')
    ? './dist/services/publishing/datacite'
    : './services/publishing/datacite'
  const { publishToDatacite } = require(svc)

  const group = await db('groups').where({ name: groupName }).first()
  if (!group) throw new Error(`no group ${groupName}`)

  for (const sid of shortIds) {
    const row = await db('manuscripts').where({ group_id: group.id, short_id: Number(sid) }).orderBy('created', 'desc').first()
    if (!row) { console.log(`pass 1 ${groupName} ${sid}: FAILED not found`); continue }
    if (row.status !== 'published') { console.log(`pass 1 ${groupName} ${sid}: FAILED latest version is ${row.status}`); continue }
    const manuscript = { ...row, groupId: row.groupId || row.group_id, shortId: row.shortId || row.short_id }
    if (!manuscript.submission || !manuscript.submission.$doi) { console.log(`pass 1 ${groupName} ${sid}: FAILED no DOI yet; use republish.js`); continue }
    try {
      const doi = await publishToDatacite(manuscript)
      console.log(`pass 1 ${groupName} ${sid}: ok (Datacite ${doi})`)
    } catch (e) {
      console.log(`pass 1 ${groupName} ${sid}: FAILED Datacite: ${e.message}`)
    }
    await sleep(1500)
  }
  console.log('REPUBLISH DONE')
}

main()
  .then(() => process.exit(0))
  .catch(e => { console.log(`REPUBLISH FAILED ${e.message}`); process.exit(1) })
