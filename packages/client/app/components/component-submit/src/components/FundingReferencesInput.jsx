/**
 * FundingReferencesInput — repeatable DataCite fundingReferences rows:
 * funder (ROR search or free text) + award number/title/URI.
 * Serializer semantics: REPLACE-with-fallback — when this array has rows it
 * replaces the legacy flat funding fields (Funding/funderid/awardnumber/
 * awardtitle/awarduri); when empty, the legacy fields still serialize.
 */

import PropTypes from 'prop-types'
import RepeatableFieldRows from './RepeatableFieldRows'
import { getFundingReferenceFields } from '../../../../shared/dataciteFieldDefinitions'

const FundingReferencesInput = ({ onChange, value }) => (
  <RepeatableFieldRows
    addLabel="Add funder"
    deleteTooltip="Delete this funder"
    fields={getFundingReferenceFields()}
    onChange={onChange}
    value={value}
  />
)

FundingReferencesInput.propTypes = {
  onChange: PropTypes.func.isRequired,
  value: PropTypes.array, // eslint-disable-line react/forbid-prop-types
}

FundingReferencesInput.defaultProps = {
  value: [],
}

export default FundingReferencesInput
