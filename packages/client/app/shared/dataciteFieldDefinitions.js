/**
 * dataciteFieldDefinitions.js — iPlaces shared schema module for DataCite 4.7
 * form fields. The single source of truth for controlled vocabularies and the
 * sub-field definitions of each repeatable DataCite array. Mirrors upstream's
 * authorsFieldDefinitions.js pattern.
 *
 * Field definition shape (consumed by RepeatableFieldRows):
 *   name         key within the row object
 *   label        display label
 *   placeholder  input placeholder
 *   type         'text' | 'select'
 *   options      [{label, value}] (select only)
 *   clearable    select only; default true
 *   isMulti      ror only; store an array of {label, value} selections
 *   showIf       optional row => boolean; field renders only when true
 *
 * VOCAB-VERIFIED 2026-07-07 against the official 4.7 docs
 * (https://datacite-metadata-schema.readthedocs.io/en/4.7/, Appendix 1):
 *   relationType          39/39 exact (order aligned to doc)
 *   resourceTypeGeneral   34/34 exact
 *   contributorType       22/22 exact
 *   nameType               2/2  exact
 *   relatedIdentifierType  fixed: added RAiD + SWHID (new in 4.7) and UPC
 *                          (pre-existing, missing from the draft) -> 23/23
 *   titleType              added (verified from properties/title/): 4 values
 */

export const RELATED_IDENTIFIER_TYPES = [
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
  'RAiD',
  'RRID',
  'SWHID',
  'UPC',
  'URL',
  'URN',
  'w3id',
]

export const RELATION_TYPES = [
  'IsCitedBy',
  'Cites',
  'IsSupplementTo',
  'IsSupplementedBy',
  'IsContinuedBy',
  'Continues',
  'Describes',
  'IsDescribedBy',
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
  'Obsoletes',
  'IsObsoletedBy',
  'IsCollectedBy',
  'Collects',
  'IsTranslationOf',
  'HasTranslation',
  'Other',
]

export const RESOURCE_TYPES_GENERAL = [
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

export const CONTRIBUTOR_TYPES = [
  'ContactPerson',
  'DataCollector',
  'DataCurator',
  'DataManager',
  'Distributor',
  'Editor',
  'HostingInstitution',
  'Producer',
  'ProjectLeader',
  'ProjectManager',
  'ProjectMember',
  'RegistrationAgency',
  'RegistrationAuthority',
  'RelatedPerson',
  'Researcher',
  'ResearchGroup',
  'RightsHolder',
  'Sponsor',
  'Supervisor',
  'Translator',
  'WorkPackageLeader',
  'Other',
]

export const NAME_TYPES = ['Personal', 'Organizational']

/* titleType (3.a) — used only on titles beyond the main title; a title
   with no titleType is the main title. Verified 4.7. */
export const TITLE_TYPES = [
  'AlternativeTitle',
  'Subtitle',
  'TranslatedTitle',
  'Other',
]

const toOptions = list => list.map(v => ({ label: v, value: v }))

/* ------------------------------------------------------------------ */
/* titles — ADDITIONAL titles beyond the main title ($title stays the
   form's own title field and serializes with no titleType). Row shape:
   { id, title, titleType, lang }; lang is a BCP-47 tag.               */
export const getTitleFields = () => [
  {
    name: 'title',
    label: 'Title',
    placeholder: 'Additional title text…',
    type: 'text',
  },
  {
    name: 'titleType',
    label: 'Title type',
    placeholder: 'Select type…',
    type: 'select',
    options: toOptions(TITLE_TYPES),
  },
  {
    name: 'lang',
    label: 'Language (BCP-47, optional)',
    placeholder: 'e.g. fr, ty, en-US…',
    type: 'text',
  },
]

/* ------------------------------------------------------------------ */
/* relatedIdentifiers — row shape:
   { id, relatedIdentifier, relatedIdentifierType, relationType,
     relationTypeInformation, resourceTypeGeneral }                    */
export const getRelatedIdentifierFields = () => [
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

/* ------------------------------------------------------------------ */
/* fundingReferences — row shape:
   { id, funder: {label,value}|'' , awardNumber, awardTitle, awardUri }
   funder is a ror-type value: label = funder name; value = ROR URL when
   picked from the registry (serializer emits funderIdentifierType ROR),
   or free text (serializer emits funderName only).                    */
export const getFundingReferenceFields = () => [
  {
    name: 'funder',
    label: 'Funder (search ROR, or type any name freely)',
    placeholder: 'Start typing to search ROR…',
    type: 'ror',
  },
  {
    name: 'awardNumber',
    label: 'Award number (optional)',
    placeholder: 'e.g. 2136…',
    type: 'text',
  },
  {
    name: 'awardTitle',
    label: 'Award title (optional)',
    placeholder: 'Grant/award title…',
    type: 'text',
  },
  {
    name: 'awardUri',
    label: 'Award URI (optional)',
    placeholder: 'https://…',
    type: 'text',
  },
]

/* ------------------------------------------------------------------ */
/* contributors — row shape (flat; serializer builds the DataCite
   nesting):
   Personal:       { id, nameType, contributorType, givenName,
                     familyName, orcid,
                     affiliation: [{label,value}] (legacy: single object) }
   Organizational: { id, nameType, contributorType,
                     organization: {label,value}|'' }
   (ror-type values: label = display name; value = ROR URL when picked
   from the registry, or the same free text when typed manually)       */
export const getContributorFields = () => [
  {
    name: 'contributorType',
    label: 'Contributor role',
    placeholder: 'Select role…',
    type: 'select',
    options: toOptions(CONTRIBUTOR_TYPES),
  },
  {
    name: 'nameType',
    label: 'Person or organization?',
    placeholder: '',
    type: 'select',
    options: toOptions(NAME_TYPES),
    clearable: false,
  },
  {
    name: 'givenName',
    label: 'Given name',
    placeholder: 'Given name…',
    type: 'text',
    showIf: row => row.nameType !== 'Organizational',
  },
  {
    name: 'familyName',
    label: 'Family name',
    placeholder: 'Family name…',
    type: 'text',
    showIf: row => row.nameType !== 'Organizational',
  },
  {
    name: 'orcid',
    label: 'ORCID (optional)',
    placeholder: '0000-0002-1825-0097',
    type: 'text',
    showIf: row => row.nameType !== 'Organizational',
  },
  {
    name: 'affiliation',
    label: 'Affiliations (search ROR, or type freely — multiple allowed)',
    placeholder: 'Start typing to search ROR…',
    type: 'ror',
    isMulti: true,
    showIf: row => row.nameType !== 'Organizational',
  },
  {
    name: 'organization',
    label: 'Organization (search ROR, or type any name freely)',
    placeholder: 'Start typing to search ROR…',
    type: 'ror',
    showIf: row => row.nameType === 'Organizational',
  },
]
