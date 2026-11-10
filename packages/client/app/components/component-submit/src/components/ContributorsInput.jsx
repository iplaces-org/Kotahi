/**
 * ContributorsInput — repeatable DataCite contributors: typed people OR
 * organizations. The "Person or organization?" toggle switches which fields
 * each row shows. Organizations need only a name (ROR optional, free text
 * fine). The serializer (Patch 4) transforms these flat rows into DataCite's
 * nested contributor shape.
 *
 * iPlaces: like StationAuthorsInput, an "Add existing person" typeahead over
 * the station's published authors sits above the add button. Picking someone
 * appends a Personal row pre-filled with their name, ORCID and affiliations
 * (role left blank). "Add contributor" still adds an empty row.
 *
 * Row shapes (flat):
 *   Personal:       { id, nameType, contributorType, givenName, familyName,
 *                     orcid, affiliation }
 *   Organizational: { id, nameType, contributorType, organization }
 */

import PropTypes from 'prop-types'
import styled from 'styled-components'
import AsyncSelect from 'react-select/async'
import { th, grid } from '@coko/client'
import RepeatableFieldRows, { makeEmptyRow } from './RepeatableFieldRows'
import { getContributorFields } from '../../../../shared/dataciteFieldDefinitions'
import useStationPeople, { bareOrcid } from './hooks/useStationPeople'

const PickerWrapper = styled.div`
  margin-bottom: ${grid(1)};
  max-width: 480px;
`

const PickerLabel = styled.div`
  color: ${th('colorText')};
  font-size: ${th('fontSizeBaseSmall')};
  padding-inline: ${grid(0.25)};
`

const StyledPersonSelect = styled(AsyncSelect)`
  border: 1px solid #dedede;
  border-radius: ${th('borderRadius')};
  font-size: ${th('fontSizeBaseSmall')};
  line-height: 31px;

  /* stylelint-disable-next-line selector-class-pattern */
  .react-select__control {
    background-color: ${th('color.gray99')};
    border-radius: ${th('borderRadius')};
  }

  /* stylelint-disable-next-line selector-class-pattern */
  .react-select__control--is-focused {
    border-color: ${th('colorPrimary')};
    box-shadow: 0 0 0 0 ${th('colorPrimary')};
  }
`

const ContributorsInput = ({ onChange, value }) => {
  const fields = getContributorFields()
  const cleanedVal = Array.isArray(value) ? value : []
  // first URL segment = group name, same as StationAuthorsInput
  const groupName = window.location.pathname.split('/')[1]
  const { searchPeople } = useStationPeople(groupName)

  return (
    <>
      <PickerWrapper>
        <PickerLabel>Add existing person</PickerLabel>
        <StyledPersonSelect
          cacheOptions
          classNamePrefix="react-select"
          defaultOptions
          loadOptions={searchPeople}
          menuPortalTarget={document.querySelector('body')}
          onChange={opt => {
            if (!opt || !opt.person) return
            const p = opt.person
            // legacy single-object affiliation becomes a one-item array
            const ror = p.ror ? [].concat(p.ror) : []
            onChange([
              ...cleanedVal,
              makeEmptyRow(fields, {
                nameType: 'Personal',
                givenName: p.firstName || '',
                familyName: p.lastName || '',
                orcid: bareOrcid(p.orcid),
                affiliation: ror,
              }),
            ])
          }}
          placeholder="Search published authors…"
          value={null}
        />
      </PickerWrapper>
      <RepeatableFieldRows
        addLabel="Add contributor"
        deleteTooltip="Delete this contributor"
        fields={fields}
        newRowOverrides={{ nameType: 'Personal' }}
        onChange={onChange}
        value={value}
      />
    </>
  )
}

ContributorsInput.propTypes = {
  onChange: PropTypes.func.isRequired,
  value: PropTypes.array, // eslint-disable-line react/forbid-prop-types
}

ContributorsInput.defaultProps = {
  value: [],
}

export default ContributorsInput
