/**
 * AlternateIdentifiersInput — repeatable DataCite alternateIdentifiers rows:
 * identifiers other than the DOI that also refer to this same resource
 * (local accession numbers, ARKs, ISBNs…). Both sub-fields are free text;
 * the type is mandatory whenever the identifier is present.
 *
 * Each row = one DataCite 4.7 alternateIdentifier:
 *   { id, alternateIdentifier, alternateIdentifierType }
 *
 * Vocabularies and field definitions come from the shared schema module
 * (app/shared/dataciteFieldDefinitions.js) — the single source of truth,
 * vocab-verified against the 4.7 docs. No inline lists here.
 */

import styled from 'styled-components'
import { th, grid, uuid } from '@coko/client'
import PropTypes from 'prop-types'
import { PlusCircle } from 'react-feather'
import Select from 'react-select'
import { Button } from '../../../pubsweet'
import { DeleteControl, TextInput } from '../../../shared'
import { FlexRow } from '../../../../globals'
import { getAlternateIdentifierFields } from '../../../../shared/dataciteFieldDefinitions'

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

const StyledSelect = styled(Select)`
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

const emptyRow = () => ({
  id: uuid(),
  alternateIdentifier: '',
  alternateIdentifierType: '',
})

const AlternateIdentifiersInput = ({ onChange, value }) => {
  const cleanedVal = Array.isArray(value) ? value : []
  const fields = getAlternateIdentifierFields()

  if (value && !Array.isArray(value))
    // eslint-disable-next-line no-console
    console.error('Illegal AlternateIdentifiersInput value:', value)

  return (
    <>
      <StyledButton
        onClick={() => onChange([...cleanedVal, emptyRow()])}
        title="Add an alternate identifier"
        type="button"
      >
        <PlusCircle />
        Add alternate identifier
      </StyledButton>
      <Wrapper>
        {cleanedVal.map((row, index) => (
          <RowContainer key={row.id}>
            <Row>
              {fields.map(f => {
                const handleChange = v => {
                  const newVal = [...cleanedVal]
                  newVal[index] = {
                    ...newVal[index],
                    [f.name]: v?.target?.value ?? v?.value ?? '',
                  }
                  onChange(newVal)
                }

                return (
                  <div key={f.name}>
                    <FieldLabel>
                      <div>{f.label}</div>
                    </FieldLabel>
                    {f.type === 'select' ? (
                      <StyledSelect
                        classNamePrefix="react-select"
                        isClearable
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
              onClick={() => onChange(cleanedVal.filter((_, i) => i !== index))}
              tooltip="Delete this alternate identifier"
            />
          </RowContainer>
        ))}
      </Wrapper>
    </>
  )
}

AlternateIdentifiersInput.propTypes = {
  onChange: PropTypes.func.isRequired,
  value: PropTypes.arrayOf(
    PropTypes.shape({
      id: PropTypes.string,
      alternateIdentifier: PropTypes.string,
      alternateIdentifierType: PropTypes.string,
    }),
  ),
}

export default AlternateIdentifiersInput
