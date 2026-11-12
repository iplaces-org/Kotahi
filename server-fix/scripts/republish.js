// iplaces one-off: republish records by station + short id, the same code path
// as the editor's Publish button. One pass per record (records that already
// have a DOI need only one publish; Patch 31 saves the DOI before the Flax
// rebuild). Add --twice for a record whose DOI is being minted for the first time.
// Add --first to also publish records that have never been published (for
// example drafts made by scripts/import-datacite-dois.js); without it the
// script refuses them, so a typo'd short id can't publish a stray draft.
// Run inside the server container from /home/node/app:
//   node republish.js gumpstation 130 16 55
/* eslint-disable no-console, no-restricted-syntax, no-await-in-loop */
const sleep = ms => new Promise(r => setTimeout(r, ms))
const GAP_MS = 3000

const main = async () => {
  const args = process.argv.slice(2)
  const passes = args.includes('--twice') ? [1, 2] : [1]
  const allowFirst = args.includes('--first')
  const [groupName, ...shortIds] = args.filter(a => !a.startsWith('--'))
  if (!groupName || !shortIds.length) throw new Error('usage: node republish.js <group> <shortId>...')

  const { config, db } = require('@coko/server')
  await config.init()
  db.init()

  // Since 2026.11.03 the plain tree has TypeScript-only models; the running
  // server uses the compiled copy in dist/, so load the controller from there.
  const fs = require('fs')
  const ctrl = fs.existsSync('./dist/controllers/manuscript/manuscript.controllers.js')
    ? './dist/controllers/manuscript/manuscript.controllers'
    : './controllers/manuscript/manuscript.controllers'
  const { publishManuscript } = require(ctrl)

  const group = await db('groups').where({ name: groupName }).first()
  if (!group) throw new Error(`no group ${groupName}`)

  const targets = []
  for (const sid of shortIds) {
    const latest = await db('manuscripts').where({ group_id: group.id, short_id: Number(sid) }).orderBy('created', 'desc').first()
    if (!latest) throw new Error(`${groupName} ${sid}: not found`)
    if (latest.status !== 'published' && !allowFirst) throw new Error(`${groupName} ${sid}: latest version is ${latest.status}, not published (add --first to publish it for the first time)`)
    targets.push({ sid, id: latest.id })
  }

  for (const pass of passes) {
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
