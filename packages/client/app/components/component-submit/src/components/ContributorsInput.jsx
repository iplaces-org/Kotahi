/**
 * ContributorsInput — repeatable DataCite contributors: typed people OR
 * organizations. The "Person or organization?" toggle switches which fields
 * each row shows. Organizations need only a name (ROR optional, free text
 * fine). The serializer (Patch 4) transforms these flat rows into DataCite's
 * nested contributor shape.
 *
 * Row shapes (flat):
 *   Personal:       { id, nameType, contributorType, givenName, familyName,
 *                     orcid, affiliationName, affiliationRor }
 *   Organizational: { id, nameType, contributorType, name, ror }
 */

import PropTypes from 'prop-types'
import RepeatableFieldRows from './RepeatableFieldRows'
import { getContributorFields } from '../../../../shared/dataciteFieldDefinitions'

const ContributorsInput = ({ onChange, value }) => (
  <RepeatableFieldRows
    addLabel="Add contributor"
    deleteTooltip="Delete this contributor"
    fields={getContributorFields()}
    newRowOverrides={{ nameType: 'Personal' }}
    onChange={onChange}
    value={value}
  />
)

ContributorsInput.propTypes = {
  onChange: PropTypes.func.isRequired,
  value: PropTypes.array, // eslint-disable-line react/forbid-prop-types
}

ContributorsInput.defaultProps = {
  value: [],
}

export default ContributorsInput
