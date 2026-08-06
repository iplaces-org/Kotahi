/* Tier-0 "existing authors" data source.
 * Mines $authors from every published manuscript in the group via the
 * public manuscriptsPublishedSinceDate query, through the app's own
 * Apollo client (same endpoint, no extra config, no CORS concern).
 * Dedupe: bare ORCID, fallback normalized first|last name.
 * Newest record wins; older records backfill blanks only.
 * Swap point for station_people microservice: replace loadStationPeople.
 */
import { gql } from '@apollo/client'
import { useApolloClient } from '@apollo/client/react'

const PAGE = 50

const PUBLISHED_FOR_AUTHORS = gql`
  query StationPeople($groupName: String!, $offset: Int!, $limit: Int!) {
    manuscriptsPublishedSinceDate(
      startDate: 0
      limit: $limit
      offset: $offset
      groupName: $groupName
    ) {
      shortId
      publishedDate
      submission
    }
  }
`

export const bareOrcid = v =>
  (v || '').replace(/^https?:\/\/orcid\.org\//i, '').trim()

const personKey = a => {
  const o = bareOrcid(a.orcid)
  if (o) return `orcid:${o}`
  return `name:${(a.firstName || '').trim().toLowerCase()}|${(a.lastName || '')
    .trim()
    .toLowerCase()}`
}

// session cache, keyed by group
const cache = new Map()

export const loadStationPeople = async (client, groupName) => {
  if (cache.has(groupName)) return cache.get(groupName)

  const all = []
  for (let offset = 0; ; offset += PAGE) {
    // eslint-disable-next-line no-await-in-loop
    const { data } = await client.query({
      query: PUBLISHED_FOR_AUTHORS,
      variables: { groupName, offset, limit: PAGE },
      fetchPolicy: 'no-cache',
    })

    const page = data?.manuscriptsPublishedSinceDate || []
    all.push(...page)
    if (page.length < PAGE) break
  }

  all.sort((a, b) =>
    String(b.publishedDate || '').localeCompare(String(a.publishedDate || '')),
  )

  const seen = new Map()

  all.forEach(m => {
    let sub

    try {
      sub = JSON.parse(m.submission || '{}')
    } catch (e) {
      return
    }

    ;(sub.$authors || []).forEach(a => {
      if (!a || (!a.lastName && !a.firstName)) return
      const key = personKey(a)
      const existing = seen.get(key)

      if (!existing) {
        seen.set(key, { ...a, orcid: bareOrcid(a.orcid) })
      } else {
        if (!existing.orcid && a.orcid) existing.orcid = bareOrcid(a.orcid)
        if ((!existing.ror || !existing.ror.length) && a.ror && a.ror.length)
          existing.ror = a.ror
        if (!existing.email && a.email) existing.email = a.email
        if (!existing.middleName && a.middleName)
          existing.middleName = a.middleName
      }
    })
  })

  const people = [...seen.values()].sort((x, y) =>
    (x.lastName || '').localeCompare(y.lastName || ''),
  )

  cache.set(groupName, people)
  return people
}

const useStationPeople = groupName => {
  const client = useApolloClient()

  // async-select loader: filters the cached people list as you type
  const searchPeople = (inputValue, callback) => {
    loadStationPeople(client, groupName)
      .then(people => {
        const q = (inputValue || '').trim().toLowerCase()

        const hits = (q
          ? people.filter(
              p =>
                (p.lastName || '').toLowerCase().includes(q) ||
                (p.firstName || '').toLowerCase().includes(q) ||
                (p.orcid || '').includes(q),
            )
          : people
        ).slice(0, 20)

        callback(
          hits.map(p => ({
            label: `${p.lastName}, ${p.firstName}${
              p.orcid ? ` — ${p.orcid}` : ''
            }`,
            value: personKey(p),
            person: p,
          })),
        )
      })
      .catch(e => {
        console.error('stationPeople:', e)
        callback([])
      })
  }

  return { searchPeople }
}

export default useStationPeople