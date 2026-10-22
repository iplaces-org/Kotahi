// iplaces one-off: republish records by station + short id, the same code path
// as the editor's Publish button. Publishes each record twice (second pass
// picks up the DOI write-back, so Flax and DataCite both get the new data).
// Run inside the server container from /home/node/app:
//   node republish.js gumpstation 130 16 55
/* eslint-disable no-console, no-restricted-syntax, no-await-in-loop */
const sleep = ms => new Promise(r => setTimeout(r, ms))
const GAP_MS = 20000

const main = async () => {
  const [groupName, ...shortIds] = process.argv.slice(2)
  if (!groupName || !shortIds.length) throw new Error('usage: node republish.js <group> <shortId>...')

  const { config, db } = require('@coko/server')
  await config.init()
  db.init()

  const { publishManuscript } = require('./controllers/manuscript/manuscript.controllers')

  const group = await db('groups').where({ name: groupName }).first()
  if (!group) throw new Error(`no group ${groupName}`)

  const targets = []
  for (const sid of shortIds) {
    const latest = await db('manuscripts').where({ group_id: group.id, short_id: Number(sid) }).orderBy('created', 'desc').first()
    if (!latest) throw new Error(`${groupName} ${sid}: not found`)
    if (latest.status !== 'published') throw new Error(`${groupName} ${sid}: latest version is ${latest.status}, not published`)
    targets.push({ sid, id: latest.id })
  }

  for (const pass of [1, 2]) {
    for (const t of targets) {
      const res = await publishManuscript(t.id, group.id)
      const failed = (res.steps || []).filter(s => !s.succeeded)
      console.log(`pass ${pass} ${groupName} ${t.sid}: ${failed.length ? 'FAILED ' + failed.map(s => `${s.stepLabel}: ${s.errorMessage}`).join('; ') : 'ok (' + res.steps.map(s => s.stepLabel).join(', ') + ')'}`)
      await sleep(GAP_MS)
    }
  }
  console.log('REPUBLISH DONE')
}

main()
  .then(() => process.exit(0))
  .catch(e => {
    console.error('REPUBLISH FAILED', e.message || e)
    process.exit(1)
  })
