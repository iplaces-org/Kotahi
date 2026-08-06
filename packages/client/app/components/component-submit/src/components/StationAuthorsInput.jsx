/* eslint-disable react-hooks/exhaustive-deps */

import Creatable from 'react-select/async-creatable'
import AsyncSelect from 'react-select/async'

import { useEffect, useState } from 'react'
import styled from 'styled-components'
import { th, grid, uuid } from '@coko/client'
import PropTypes from 'prop-types'
import { useTranslation } from 'react-i18next'
import { PlusCircle } from 'react-feather'
import { isEmpty } from 'lodash'
import { Button } from '../../../pubsweet'
import { DeleteControl, TextInput } from '../../../shared'
import {
  getAuthorFields,
  validateAuthor,
  validateAuthors,
} from '../../../../shared/authorsFieldDefinitions'

import theme, { color } from '../../../../theme'
import { FlexRow } from '../../../../globals'
import useAuthorsFieldQueries from './hooks/useAuthorsInputQueries'
import useStationPeople, { bareOrcid } from './hooks/useStationPeople'

// #region styled
const StyledButton = styled(Button)`
  cursor: pointer;
  display: flex;
  gap: ${grid(1)};
  margin-bottom: ${grid(2)};

  &[disabled] {
    cursor: not-allowed;
  }
`

const Wrapper = styled.div`
  > div:not(:last-child) {
    margin-bottom: ${grid(2)};
  }
`

const AuthorContainer = styled.div`
  border: 1px solid ${color.gray80};
  border-radius: ${theme.borderRadius};
  display: flex;
  ${({ fullWidth }) => (fullWidth ? 'width: 100%' : 'max-width: 1000px')};
  padding: ${grid(2)};
`

const Author = styled.div`
  display: grid;
  gap: ${grid(2)} ${grid(4)};
  grid-template-columns: repeat(2, 1fr);
  padding: ${grid(1)};
  width: 100%;
`

const StyledSelect = styled(Creatable)`
  border: 1px solid #dedede;
  border-radius: ${th('borderRadius')};
  font-size: ${th('fontSizeBaseSmall')};
  line-height: 31px; /* hack, need to fix across components */

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
  color: ${props =>
    props.$valid ? props.theme.colorText : props.theme.colorError};
  display: flex;
  font-size: ${th('fontSizeBaseSmall')};
  justify-content: space-between;
  padding-inline: ${grid(0.25)};
`
// #endregion styled

const localizeFields = (fields, t) =>
  fields.map(field => ({
    ...field,
    label: t(`authorsInput.${field.name}.label`),
    placeholder: t(`authorsInput.${field.name}.placeholder`),
  }))

/**
 * Station fork of AuthorsInput: adds a typeahead over authors already
 * present in the station's published records (tier-0 of the recent-authors
 * plan). Picking a person appends a pre-filled row; manual entry unchanged.
 */
const StationAuthorsInput = ({
  fullWidth = false, // should the component be the full width of the parent
  onChange,
  requireEmail = false, // is the email address required
  value,
  overrideButtonLabel,
  rorMenuPlacement, // ROR affiliation dropdown position
  showMiddleName = false, // should the middle name field be used
  showOrcidId = false, // should the ORCID field be used
  isRoRMulti = false, // should be multi-select
}) => {
  const [validatePerField, setValidatePerField] = useState([])
  const { t } = useTranslation()
  const { validationOrcid, searchRor } = useAuthorsFieldQueries()

  const groupName = window.location.pathname.split('/')[1] // first URL segment = group name (verify)
  const { searchPeople } = useStationPeople(groupName)

  const filterOptions = response => {
    return response.data.searchRor.map(ror => ({
      label: ror.name,
      value: ror.id,
    }))
  }

  const cleanedVal = Array.isArray(value) ? value : [] // We're getting momentary mismatches between field and value, so this can momentarily receive e.g. a string from another field, before a rerender corrects it. Not sure why yet.

  /**
   * add more definitions here as needed, and define them in `getAuthorFields`.
   * These are used to customise the `authorFields`. See function below for more details.
   */
  const authorFieldOptions = {
    requireEmail,
    showMiddleName,
    showOrcidId,
    validationOrcid,
  }

  const authorFields = getAuthorFields(authorFieldOptions)
  const localizedFields = localizeFields(authorFields, t)

  if (value && !Array.isArray(value))
    console.error('Illegal StationAuthorsInput value:', value)

  useEffect(() => {
    const validate = async () => {
      const validationPerField = await Promise.all(
        cleanedVal.map(async author =>
          validateAuthor(author, { validationOrcid, requireEmail }),
        ),
      )

      setValidatePerField([
        ...validationPerField.map(field => {
          const obj = {}
          field.forEach(f => {
            const [key] = Object.keys(f)
            obj[key] = f[key]
          })
          return obj
        }),
      ])
    }

    validate()
  }, [JSON.stringify(cleanedVal)])

  return (
    <>
      <div style={{ marginBottom: '8px', maxWidth: '480px' }}>
        <FieldLabel $valid>
          <div>Add existing author</div>
        </FieldLabel>
        <StyledPersonSelect
          cacheOptions
          classNamePrefix="react-select"
          defaultOptions
          loadOptions={searchPeople}
          menuPortalTarget={document.querySelector('body')}
          onChange={opt => {
            if (!opt || !opt.person) return
            const p = opt.person
            onChange([
              ...cleanedVal,
              {
                firstName: p.firstName || '',
                middleName: p.middleName || '',
                lastName: p.lastName || '',
                email: p.email || '',
                id: uuid(),
                ror: Array.isArray(p.ror) ? p.ror : [],
                orcid: bareOrcid(p.orcid),
              },
            ])
          }}
          placeholder="Search published authors…"
          value={null}
        />
      </div>
      <StyledButton
        disabled={validateAuthors(cleanedVal, authorFieldOptions)}
        onClick={() => {
          const newVal = [
            ...cleanedVal,
            {
              firstName: '',
              middleName: '',
              lastName: '',
              email: '',
              id: uuid(),
              ror: [],
              orcid: '',
            },
          ]

          onChange(newVal)
        }}
        title={
          validateAuthors(cleanedVal, authorFieldOptions)
            ? 'Correct or delete "persons" with invalid fields, then add a new one!'
            : 'Add a new person'
        }
        type="button"
      >
        <PlusCircle />
        {!overrideButtonLabel
          ? t('decisionPage.Add another person')
          : overrideButtonLabel}
      </StyledButton>
      <Wrapper>
        {cleanedVal.map((author, index) => (
          <AuthorContainer fullWidth={fullWidth} key={author.id}>
            <Author>
              {localizedFields.map(f => {
                if (!f.label) return null

                const invalidity = validatePerField[index]
                  ? validatePerField[index][f.name]
                  : false

                const handleChange = v => {
                  const newVal = [...cleanedVal]
                  newVal[index][f.name] = v?.target?.value ?? v
                  onChange(newVal)
                }

                // eslint-disable-next-line no-nested-ternary
                const val = isRoRMulti
                  ? isEmpty(author[f.name])
                    ? []
                    : author[f.name]
                  : author[f.name]

                return (
                  <div key={f.name}>
                    <FieldLabel $valid={!invalidity}>
                      <div>{f.label}</div>
                      <div>{invalidity && <>{invalidity}!</>}</div>
                    </FieldLabel>
                    {f.name === 'ror' ? (
                      <StyledSelect
                        classNamePrefix="react-select"
                        createOptionPosition="first"
                        isClearable
                        isMulti={isRoRMulti}
                        loadOptions={searchRor(filterOptions)}
                        menuPlacement={rorMenuPlacement || 'auto'}
                        menuPortalTarget={document.querySelector('body')}
                        onChange={handleChange}
                        placeholder={f.placeholder}
                        value={val}
                      />
                    ) : (
                      <TextInput
                        label={f.label}
                        onChange={handleChange}
                        placeholder={f.placeholder}
                        style={{
                          outline: invalidity ? '1px solid #f20' : 'none',
                        }}
                        value={author[f.name]}
                      />
                    )}
                  </div>
                )
              })}
            </Author>

            <StyledDeleteControl
              iconProps={{ color: '#555', size: '2.5' }}
              onClick={() => {
                onChange(cleanedVal.filter((_, i) => i !== index))
              }}
              tooltip={t('decisionPage.Delete this author')}
            />
          </AuthorContainer>
        ))}
      </Wrapper>
    </>
  )
}

StationAuthorsInput.propTypes = {
  fullWidth: PropTypes.bool,
  onChange: PropTypes.func.isRequired,
  overrideButtonLabel: PropTypes.string,
  requireEmail: PropTypes.bool,
  rorMenuPlacement: PropTypes.oneOf(['bottom', 'top', 'auto']),
  showMiddleName: PropTypes.bool,
  isRoRMulti: PropTypes.bool,
  showOrcidId: PropTypes.bool,
  value: PropTypes.oneOfType([
    PropTypes.arrayOf(
      PropTypes.shape({
        firstName: PropTypes.string.isRequired,
        lastName: PropTypes.string.isRequired,
        email: PropTypes.string.isRequired,
        middleName: PropTypes.string,
        ror: PropTypes.shape({}),
        orcid: PropTypes.string,
      }).isRequired,
    ),
  ]),
}

export default StationAuthorsInput