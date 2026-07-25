import { StyledAuthor } from '../style'

/** All members of the manuscript's author team (not the submitter).
 *  Distinct from the 'author'/'submitter' column, which renders
 *  manuscript.submitter -- a single user. */
const AuthorTeam = ({ manuscript }) => {
  const authorTeam = (manuscript.teams || []).find(
    team => team.role === 'author',
  )

  const names = (authorTeam?.members || [])
    .map(member => member?.user?.username)
    .filter(Boolean)

  if (!names.length) return null

  return names.map((name, i) => (
    /* eslint-disable-next-line react/no-array-index-key */
    <StyledAuthor key={`${name}-${i}`}>{name}</StyledAuthor>
  ))
}

export default AuthorTeam
