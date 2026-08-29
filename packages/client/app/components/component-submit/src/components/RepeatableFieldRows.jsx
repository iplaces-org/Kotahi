/**
 * RepeatableFieldRows — iPlaces generic repeatable-rows renderer for
 * DataCite-style form arrays. Renders add/remove-able rows whose fields come
 * from a declarative definitions array (see shared/dataciteFieldDefinitions).
 *
 * Field types: 'text' | 'select' | 'ror'
 *  - 'ror' renders the same async-creatable ROR search AuthorsInput uses:
 *    type to search the ROR registry, or type freely to keep plain text.
 *    Stored value: { label: displayName, value: rorUrlOrFreeText } | ''
 *    With isMulti: true on the field definition, stores an ARRAY of such
 *    objects (legacy single-object values display as a one-item array)
 *
 * Contract matches other form components: `value` is the array stored in the
 * submission JSON; `onChange(newArray)` writes it back.
 */

import styled from 'styled-components'
import { th, grid, uuid } from '@coko/client'
import PropTypes from 'prop-types'
import { PlusCircle } from 'react-feather'
import Select from 'react-select'
import AsyncCreatableSelect from 'react-select/async-creatable'
import { Button } from '../../../pubsweet'
import { DeleteControl, TextInput } from '../../../shared'
import { FlexRow } from '../../../../globals'
import useAuthorsFieldQueries from './hooks/useAuthorsInputQueries'

// #region styled (cloned from AuthorsInput)
const StyledButton = styled(Button)`
  cursor: pointer;
  display: flex;
  gap: ${grid(1)};
  margin-bottom: ${grid(2)};
`

const Wrapper = styled.div`
  > div:not(:last-child) {
    margin-bottom: ${grid(2)};
  }
`

const RowContainer = styled.div`
  border: 1px solid ${th('color.gray80')};
  border-radius: ${th('borderRadius')};
  display: flex;
  max-width: 1000px;
  padding: ${grid(2)};
`

const Row = styled.div`
  display: grid;
  gap: ${grid(2)} ${grid(4)};
  grid-template-columns: repeat(2, 1fr);
  padding: ${grid(1)};
  width: 100%;
`

const selectCss = `
  border: 1px solid #dedede;
  font-size: inherit;
  line-height: 31px;

  /* stylelint-disable-next-line selector-class-pattern */
  .react-select__control {
    border-radius: 4px;
  }
`

const StyledSelect = styled(Select)`
  border-radius: ${th('borderRadius')};
  font-size: ${th('fontSizeBaseSmall')};
  ${selectCss}

  /* stylelint-disable-next-line selector-class-pattern */
  .react-select__control {
    background-color: ${th('color.gray99')};
  }

  /* stylelint-disable-next-line selector-class-pattern */
  .react-select__control--is-focused {
    border-color: ${th('colorPrimary')};
    box-shadow: 0 0 0 0 ${th('colorPrimary')};
  }
`

const StyledAsyncSelect = styled(AsyncCreatableSelect)`
  border-radius: ${th('borderRadius')};
  font-size: ${th('fontSizeBaseSmall')};
  ${selectCss}

  /* stylelint-disable-next-line selector-class-pattern */
  .react-select__control {
    background-color: ${th('color.gray99')};
  }

  /* stylelint-disable-next-line selector-class-pattern */
  .react-select__control--is-focused {
    border-color: ${th('colorPrimary')};
    box-shadow: 0 0 0 0 ${th('colorPrimary')};
  }
`

const StyledDeleteControl = styled(DeleteControl)`
  background-color: ${th('colorBackground')};
  height: ${grid(3)};
  margin: 0;
  padding-left: ${grid(1)};
  width: ${grid(3)};

  &:hover {
    background-color: ${th('colorBackground')};
  }
`

const FieldLabel = styled(FlexRow)`
  color: ${props => props.theme.colorText};
  display: flex;
  font-size: ${th('fontSizeBaseSmall')};
  justify-content: space-between;
  padding-inline: ${grid(0.25)};
`
// #endregion styled

/** Build an empty row: id + every defined field name as '', plus overrides. */
export const makeEmptyRow = (fields, overrides = {}) => ({
  id: uuid(),
  ...Object.fromEntries(fields.map(f => [f.name, ''])),
  ...overrides,
})

const RepeatableFieldRows = ({
  addLabel,
  deleteTooltip,
  fields,
  newRowOverrides,
  onChange,
  value,
}) => {
  const cleanedVal = Array.isArray(value) ? value : []
  const { searchRor } = useAuthorsFieldQueries()

  const rorFilterOptions = response =>
    response.data.searchRor.map(ror => ({
      label: ror.name,
      value: ror.id,
    }))

  if (value && !Array.isArray(value))
    // eslint-disable-next-line no-console
    console.error('Illegal RepeatableFieldRows value:', value)

  return (
    <>
      <StyledButton
        onClick={() =>
          onChange([...cleanedVal, makeEmptyRow(fields, newRowOverrides)])
        }
        title={addLabel}
        type="button"
      >
        <PlusCircle />
        {addLabel}
      </StyledButton>
      <Wrapper>
        {cleanedVal.map((row, index) => (
          <RowContainer key={row.id}>
            <Row>
              {fields
                .filter(f => (f.showIf ? f.showIf(row) : true))
                .map(f => {
                  const setField = fieldValue => {
                    const newVal = [...cleanedVal]
                    newVal[index] = { ...newVal[index], [f.name]: fieldValue }
                    onChange(newVal)
                  }

                  const handleChange = v =>
                    setField(v?.target?.value ?? v?.value ?? '')

                  return (
                    <div key={f.name}>
                      <FieldLabel>
                        <div>{f.label}</div>
                      </FieldLabel>
                      {f.type === 'ror' ? (
                        <StyledAsyncSelect
                          classNamePrefix="react-select"
			  createOptionPosition="first"
                          isClearable
                          isMulti={f.isMulti === true}
                          loadOptions={searchRor(rorFilterOptions)}
                          menuPlacement="auto"
                          menuPortalTarget={document.querySelector('body')}
                          onChange={v =>
                            setField(v || (f.isMulti ? [] : ''))
                          }
                          placeholder={f.placeholder}
                          value={
                            f.isMulti
                              ? Array.isArray(row[f.name])
                                ? row[f.name]
                                : row[f.name]
                                ? [row[f.name]]
                                : []
                              : row[f.name] || null
                          }
                        />
                      ) : f.type === 'select' ? (
                        <StyledSelect
                          classNamePrefix="react-select"
                          isClearable={f.clearable !== false}
                          menuPlacement="auto"
                          menuPortalTarget={document.querySelector('body')}
                          onChange={handleChange}
                          options={f.options}
                          placeholder={f.placeholder}
                          value={
                            row[f.name]
                              ? { label: row[f.name], value: row[f.name] }
                              : null
                          }
                        />
                      ) : (
                        <TextInput
                          label={f.label}
                          onChange={handleChange}
                          placeholder={f.placeholder}
                          value={row[f.name]}
                        />
                      )}
                    </div>
                  )
                })}
            </Row>

            <StyledDeleteControl
              iconProps={{ color: '#555', size: '2.5' }}
              onClick={() =>
                onChange(cleanedVal.filter((_, i) => i !== index))
              }
              tooltip={deleteTooltip}
            />
          </RowContainer>
        ))}
      </Wrapper>
    </>
  )
}

RepeatableFieldRows.propTypes = {
  addLabel: PropTypes.string.isRequired,
  deleteTooltip: PropTypes.string,
  fields: PropTypes.arrayOf(
    PropTypes.shape({
      name: PropTypes.string.isRequired,
      label: PropTypes.string.isRequired,
      type: PropTypes.oneOf(['text', 'select', 'ror']).isRequired,
    }),
  ).isRequired,
  newRowOverrides: PropTypes.object, // eslint-disable-line react/forbid-prop-types
  onChange: PropTypes.func.isRequired,
  value: PropTypes.array, // eslint-disable-line react/forbid-prop-types
}

RepeatableFieldRows.defaultProps = {
  deleteTooltip: 'Delete this entry',
  newRowOverrides: {},
  value: [],
}

export default RepeatableFieldRows
