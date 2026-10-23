#!/usr/bin/env node
/* eslint-disable no-console */
// Upgrade check for packages/server/permissions.js (see PATCHES.md, Patch 26).
//
// Compares the GraphQL schema of an upstream Kotahi release with the rules in
// our permissions.js, in both directions:
//   - an operation with NO rule is open to anyone, no login needed
//     (graphql-shield's default is `allow`);
//   - a rule for an operation that is NOT in the schema stops the server from
//     starting (graphql-shield throws at boot, Fly shows HTTP 502).
// The schema is what api/graphql/index.js loads (its typeDefFilePaths list),
// not every .graphql file: some are commented out there.
//
// Usage (from the repo root, after `git fetch upstream --tags`):
//   node scripts/check-permission-rules.js <upstream-tag> [permissions.js]
// Exit code 0 = clean, 1 = something to fix.

const { execFileSync } = require('child_process')
const fs = require('fs')

const [ref, permPath = 'packages/server/permissions.js'] = process.argv.slice(2)

if (!ref) {
  console.error('usage: node scripts/check-permission-rules.js <upstream-tag> [permissions.js]')
  process.exit(2)
}

// Provided by @coko/server's own team model, not by Kotahi's .graphql files.
const COKO_FIELDS = { Query: ['team', 'teams'], Mutation: [], Subscription: [] }

const show = p =>
  execFileSync('git', ['show', `${ref}:packages/server/api/graphql/${p}`], {
    encoding: 'utf8',
  })

const index = show('index.js')
const listStart = index.indexOf('typeDefFilePaths = [')
const list = index.slice(listStart, index.indexOf(']', listStart))

const files = list
  .split('\n')
  .filter(line => !line.trim().startsWith('//'))
  .map(line => (line.match(/'([^']+\.graphql)'/) || [])[1])
  .filter(Boolean)

const schema = { Query: new Set(), Mutation: new Set(), Subscription: new Set() }

files.forEach(file => {
  const src = show(file).replace(/"""[\s\S]*?"""/g, '')
  const re = /(?:extend\s+)?type\s+(Query|Mutation|Subscription)\s*\{/g
  let m

  // eslint-disable-next-line no-cond-assign
  while ((m = re.exec(src))) {
    let depth = 1
    let j = m.index + m[0].length
    const start = j

    while (depth) {
      if (src[j] === '{') depth += 1
      if (src[j] === '}') depth -= 1
      j += 1
    }

    let body = src.slice(start, j - 1)
    while (body.includes('(')) body = body.replace(/\([^()]*\)/g, '')

    body.split('\n').forEach(line => {
      const field = line.split('#')[0].trim().match(/^(\w+)\s*:/)
      if (field) schema[m[1]].add(field[1])
    })
  }
})

const perms = fs.readFileSync(permPath, 'utf8')
let problems = 0

Object.keys(schema).forEach(type => {
  const block = perms.match(new RegExp(`${type}: \\{([\\s\\S]*?)\\n  \\},`))
  const ruled = new Set(
    [...(block ? block[1] : '').matchAll(/^ {4}(\w+):/gm)].map(r => r[1]),
  )

  COKO_FIELDS[type].forEach(f => schema[type].add(f))

  const open = [...schema[type]].filter(f => !ruled.has(f)).sort()
  const unknown = [...ruled].filter(f => !schema[type].has(f)).sort()

  if (open.length) {
    problems += open.length
    console.log(`${type}: NO RULE (open to anyone, add a rule): ${open.join(', ')}`)
  }

  if (unknown.length) {
    problems += unknown.length
    console.log(`${type}: NOT IN SCHEMA (server will not start, remove or rename): ${unknown.join(', ')}`)
  }
})

console.log(problems ? `\n${problems} problem(s).` : 'OK: every operation has a rule, and every rule matches the schema.')
process.exit(problems ? 1 : 0)
