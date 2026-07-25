import styled from 'styled-components'

/** All members of the manuscript's author team (not the submitter).
 *  Distinct from the 'author'/'submitter' column, which renders
 *  manuscript.submitter -- a single user. */
const AuthorList = styled.div`
  line-height: 1.35;
  overflow-wrap: anywhere;
  white-space: normal;
`

const AuthorTeam = ({ manuscript }) => {
  const authorTeam = (manuscript.teams || []).find(
    team => team.role === 'author',
  )

  const names = (authorTeam?.members || [])
    .map(member => member?.user?.username)
    .filter(Boolean)

  if (!names.length) return null

  return <AuthorList>{names.join(', ')}</AuthorList>
}

export default AuthorTeam
