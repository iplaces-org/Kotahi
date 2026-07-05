/**
 * PublisherInput — single-value DataCite publisher override with ROR search.
 * Same async-creatable behavior as the contributor organization field: type
 * to search the ROR registry, or type freely to keep plain text. Leave empty
 * to use the station (group config) as publisher.
 *
 * Stored value: { label: displayName, value: rorUrlOrFreeText } | ''
 * The serializer (Patch 5) maps label -> publisher.name and, when value
 * contains ror.org, value -> publisherIdentifier (ROR).
 */

import styled from 'styled-components'
import { th } from '@coko/client'
import PropTypes from 'prop-types'
import AsyncCreatableSelect from 'react-select/async-creatable'
import useAuthorsFieldQueries from './hooks/useAuthorsInputQueries'

const StyledAsyncSelect = styled(AsyncCreatableSelect)`
  border: 1px solid #dedede;
  border-radius: ${th('borderRadius')};
  font-size: ${th('fontSizeBaseSmall')};
  line-height: 31px;
  max-width: 500px;

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

const PublisherInput = ({ onChange, value }) => {
  const { searchRor } = useAuthorsFieldQueries()

  const rorFilterOptions = response =>
    response.data.searchRor.map(ror => ({
      label: ror.name,
      value: ror.id,
    }))

  return (
    <StyledAsyncSelect
      classNamePrefix="react-select"
      createOptionPosition="first"
      isClearable
      loadOptions={searchRor(rorFilterOptions)}
      menuPlacement="auto"
      menuPortalTarget={document.querySelector('body')}
      onChange={v => onChange(v || '')}
      placeholder="Search ROR or type a publisher name… (empty = the station)"
      value={value && value.label ? value : null}
    />
  )
}

PublisherInput.propTypes = {
  onChange: PropTypes.func.isRequired,
  value: PropTypes.oneOfType([PropTypes.object, PropTypes.string]), // eslint-disable-line react/forbid-prop-types
}

PublisherInput.defaultProps = {
  value: '',
}

export default PublisherInput
