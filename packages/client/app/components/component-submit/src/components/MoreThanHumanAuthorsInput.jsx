/**
 * MoreThanHumanAuthorsInput — repeatable more-than-human authors: places or
 * beings (e.g. a river, an island, an individuated animal) that stand in an
 * authorship relation to the work, following the practice pioneered by
 * Poelina & the Martuwarra Fitzroy River Council (Martuwarra RiverOfLife,
 * 2020–). Distinct from the standard (human) Authors field and from
 * DataCite Contributors.
 *
 * The custodial affiliation is the community/body that speaks for the
 * entity and holds consent. It is OPTIONAL in the form: leaving it empty is
 * expected until the custodial community has confirmed how (and whether)
 * they wish to be named. Do not prefill it on their behalf.
 *
 * Row shape (flat; a future serializer patch maps rows into DataCite
 * creators — note: these do NOT carry a DataCite nameType; nameType stays
 * vocab-clean at the serializer boundary):
 *   { id, entityKind ('Place'|'Being'), name, identifier,
 *     custodialAffiliation: {label,value}|'' }
 */

import PropTypes from 'prop-types'
import RepeatableFieldRows from './RepeatableFieldRows'
import { getMoreThanHumanAuthorFields } from '../../../../shared/dataciteFieldDefinitions'

const MoreThanHumanAuthorsInput = ({ onChange, value }) => (
  <RepeatableFieldRows
    addLabel="Add more-than-human author"
    deleteTooltip="Delete this more-than-human author"
    fields={getMoreThanHumanAuthorFields()}
    newRowOverrides={{ entityKind: 'Place' }}
    onChange={onChange}
    value={value}
  />
)

MoreThanHumanAuthorsInput.propTypes = {
  onChange: PropTypes.func.isRequired,
  value: PropTypes.array, // eslint-disable-line react/forbid-prop-types
}

MoreThanHumanAuthorsInput.defaultProps = {
  value: [],
}

export default MoreThanHumanAuthorsInput
