/**
 * RelatedIdentifiersInput — repeatable DataCite relatedIdentifiers rows.
 * iPlaces spike, adapted from AuthorsInput.jsx (same value/onChange contract:
 * `value` is the array stored in the submission JSON; `onChange` writes it back).
 *
 * Each row = one DataCite 4.7 relatedIdentifier:
 *   { id, relatedIdentifier, relatedIdentifierType, relationType,
 *     relationTypeInformation, resourceTypeGeneral }
 *
 * TODO(vocab): lists below are 4.6-complete + the known 4.7 additions
 * (relationType "Other", resourceTypeGeneral Poster/Presentation,
 * relationTypeInformation sub-property). Verify against
 * https://datacite-metadata-schema.readthedocs.io/en/4.7/ before production,
 * then move the lists into datacite-form-schema.json.
 */

import styled from 'styled-components'
import { th, grid, uuid } from '@coko/client'
import PropTypes from 'prop-types'
import { PlusCircle } from 'react-feather'
import Select from 'react-select'
import { Button } from '../../../pubsweet'
import { DeleteControl, TextInput } from '../../../shared'
import theme, { color } from '../../../../theme'
import { FlexRow } from '../../../../globals'

// #region vocabularies
const RELATED_IDENTIFIER_TYPES = [
  'ARK',
  'arXiv',
  'bibcode',
  'CSTR',
  'DOI',
  'EAN13',
  'EISSN',
  'Handle',
  'IGSN',
  'ISBN',
  'ISSN',
  'ISTC',
  'LISSN',
  'LSID',
  'PMID',
  'PURL',
  'RRID',
  'URL',
  'URN',
  'w3id',
]

const RELATION_TYPES = [
  'IsCitedBy',
  'Cites',
  'IsSupplementTo',
  'IsSupplementedBy',
  'IsContinuedBy',
  'Continues',
  'IsDescribedBy',
  'Describes',
  'HasMetadata',
  'IsMetadataFor',
  'HasVersion',
  'IsVersionOf',
  'IsNewVersionOf',
  'IsPreviousVersionOf',
  'IsPartOf',
  'HasPart',
  'IsPublishedIn',
  'IsReferencedBy',
  'References',
  'IsDocumentedBy',
  'Documents',
  'IsCompiledBy',
  'Compiles',
  'IsVariantFormOf',
  'IsOriginalFormOf',
  'IsIdenticalTo',
  'IsReviewedBy',
  'Reviews',
  'IsDerivedFrom',
  'IsSourceOf',
  'IsRequiredBy',
  'Requires',
  'IsObsoletedBy',
  'Obsoletes',
  'IsCollectedBy',
  'Collects',
  'IsTranslationOf',
  'HasTranslation',
  'Other',
]

const RESOURCE_TYPES_GENERAL = [
  'Audiovisual',
  'Award',
  'Book',
  'BookChapter',
  'Collection',
  'ComputationalNotebook',
  'ConferencePaper',
  'ConferenceProceeding',
  'DataPaper',
  'Dataset',
  'Dissertation',
  'Event',
  'Image',
  'Instrument',
  'InteractiveResource',
  'Journal',
  'JournalArticle',
  'Model',
  'OutputManagementPlan',
  'PeerReview',
  'PhysicalObject',
  'Poster',
  'Preprint',
  'Presentation',
  'Project',
  'Report',
  'Service',
  'Software',
  'Sound',
  'Standard',
  'StudyRegistration',
  'Text',
  'Workflow',
  'Other',
]

const toOptions = list => list.map(v => ({ label: v, value: v }))
// #endregion vocabularies

// #region field definitions (declarative, mirrors getAuthorFields pattern)
const getRelatedIdentifierFields = () => [
  {
    name: 'relatedIdentifier',
    label: 'Identifier',
    placeholder: '10.60950/… or full URL/ARK…',
    type: 'text',
  },
  {
    name: 'relatedIdentifierType',
    label: 'Identifier type',
    placeholder: 'Select type…',
    type: 'select',
    options: toOptions(RELATED_IDENTIFIER_TYPES),
  },
  {
    name: 'relationType',
    label: 'Relation',
    placeholder: 'Select relation…',
    type: 'select',
    options: toOptions(RELATION_TYPES),
  },
  {
    name: 'relationTypeInformation',
    label: 'Relation detail (optional; use with "Other")',
    placeholder: 'Free-text description of the relationship…',
    type: 'text',
  },
  {
    name: 'resourceTypeGeneral',
    label: 'Related resource type',
    placeholder: 'Select resource type…',
    type: 'select',
    options: toOptions(RESOURCE_TYPES_GENERAL),
  },
]
// #endregion field definitions

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
  border: 1px solid ${color.gray80};
  border-radius: ${theme.borderRadius};
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
  relatedIdentifier: '',
  relatedIdentifierType: '',
  relationType: '',
  relationTypeInformation: '',
  resourceTypeGeneral: '',
})

const RelatedIdentifiersInput = ({ onChange, value }) => {
  const cleanedVal = Array.isArray(value) ? value : []
  const fields = getRelatedIdentifierFields()

  if (value && !Array.isArray(value))
    // eslint-disable-next-line no-console
    console.error('Illegal RelatedIdentifiersInput value:', value)

  return (
    <>
      <StyledButton
        onClick={() => onChange([...cleanedVal, emptyRow()])}
        title="Add a related identifier"
        type="button"
      >
        <PlusCircle />
        Add related identifier
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
              tooltip="Delete this related identifier"
            />
          </RowContainer>
        ))}
      </Wrapper>
    </>
  )
}

RelatedIdentifiersInput.propTypes = {
  onChange: PropTypes.func.isRequired,
  value: PropTypes.arrayOf(
    PropTypes.shape({
      id: PropTypes.string,
      relatedIdentifier: PropTypes.string,
      relatedIdentifierType: PropTypes.string,
      relationType: PropTypes.string,
      relationTypeInformation: PropTypes.string,
      resourceTypeGeneral: PropTypes.string,
    }),
  ),
}

export default RelatedIdentifiersInput
