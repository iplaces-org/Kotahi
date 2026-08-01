/* eslint-disable react/prop-types */
/* eslint-disable new-cap */

import { DateParser } from '@coko/client'
import { get } from 'lodash'
import FormCollaborateWax from '../../../../component-formbuilder/src/components/FormCollaborativeWax'
import CollaborativeTextFieldBuilder from '../../../../component-formbuilder/src/components/builderComponents/CollaborativeTextField'
import SimpleWaxEditor from '../../../../wax-collab/src/SimpleWaxEditor'
import { Affiliation, Email, BadgeContainer } from '../style'
import { Attachment, ColorBadge } from '../../../../shared'
import ThreadedDiscussion from '../../../../component-formbuilder/src/components/builderComponents/ThreadedDiscussion/ThreadedDiscussion'
import LocalContext from '../../../../component-submit/src/components/LocalContext'

const parseIdentifierAndName = id => {
  const lastIndex = id.lastIndexOf('-')

  // Split the input string at the last occurrence of '-' character
  const identifier = id.slice(0, lastIndex)
  const name = id.slice(lastIndex + 1)
  return { identifier, name }
}

const CollaborativeReadOnlyField = (Component, data) => {
  const RenderedComponent = FormCollaborateWax(Component)
  const { identifier, name } = parseIdentifierAndName(data)
  return (
    <RenderedComponent
      collaborativeObject={{ identifier }}
      name={name}
      onChange={() => {}}
      readonly
    />
  )
}

/** Coerce a value that may be a string, a {label,value} object, or an array
 *  of either into displayable text. Returns '' for anything empty. */
const textOf = v => {
  if (!v) return ''
  if (typeof v === 'string') return v.trim()
  if (Array.isArray(v)) return v.map(textOf).filter(Boolean).join('; ')
  if (typeof v === 'object') return textOf(v.label ?? v.value ?? '')
  return String(v)
}

/** Join non-empty parts with a separator, so empty fields leave no scaffolding. */
const joinParts = (parts, sep = ' — ') => parts.filter(Boolean).join(sep)

const ReadonlyFieldData = ({
  fieldName,
  form,
  formData,
  threadedDiscussionProps,
  isCollaborativeForm,
}) => {
  const data = get(formData, fieldName)
  const fieldDefinition = form.children?.find(field => field.name === fieldName)

  if (fieldDefinition?.component === 'LocalContext') {
    return <LocalContext readonly value={data} />
  }

  if (fieldDefinition?.component === 'AuthorsInput' && Array.isArray(data)) {
    return (data || []).map((author, i) => {
      const firstName = author.firstName || '?'
      const lastName = author.lastName || '?'

      const affiliation = author.affiliation ? ` (${author.affiliation})` : ''

      return (
        <p key={i}>
          {lastName}, {firstName}
          <Affiliation>{affiliation}</Affiliation> <Email>{author.email}</Email>
        </p>
      )
    })
  }

  if (fieldDefinition?.name === 'submission.$sourceUri') {
    return (
      <p key={data}>
        <a href={data} rel="noopener noreferrer" target="_blank">
          {data}
        </a>
      </p>
    )
  }

  if (fieldDefinition?.name === 'submission.$doi') {
    return (
      <p key={data}>
        <a
          href={`https://doi.org/${data}`}
          rel="noopener noreferrer"
          target="_blank"
        >
          {data}
        </a>
      </p>
    )
  }

  if (fieldDefinition?.name === 'submission.$dois' && Array.isArray(data)) {
    return (data || []).map((d, i) => {
      const doi = d.name || d.doi || '?'

      return (
        <p key={`doi-${i}`}>
          <a
            href={`https://doi.org/${doi}`}
            rel="noopener noreferrer"
            target="_blank"
          >
            {doi}
          </a>
        </p>
      )
    })
  }

  if (fieldDefinition?.component === 'LinksInput' && Array.isArray(data)) {
    return data.map(link => (
      <p key={link.url}>
        <a href={link.url} rel="noopener noreferrer" target="_blank">
          {link.url}
        </a>
      </p>
    ))
  }

  /* ---- iPlaces custom repeatable/object components (display-only) ---- */

  if (
    fieldDefinition?.component === 'FundingReferencesInput' &&
    Array.isArray(data)
  ) {
    return data.map(fr => {
      const funderName = textOf(fr.funder)
      const rorUrl =
        typeof fr.funder === 'object' &&
        typeof fr.funder?.value === 'string' &&
        fr.funder.value.includes('ror.org')
          ? fr.funder.value
          : null

      const award = joinParts(
        [textOf(fr.awardNumber), textOf(fr.awardTitle)],
        ': ',
      )

      return (
        <p key={fr.id}>
          {rorUrl ? (
            <a href={rorUrl} rel="noopener noreferrer" target="_blank">
              {funderName || rorUrl}
            </a>
          ) : (
            funderName || '?'
          )}
          {award ? ` — ${award}` : ''}
          {textOf(fr.awardUri) ? (
            <>
              {' '}
              <a
                href={fr.awardUri}
                rel="noopener noreferrer"
                target="_blank"
              >
                {fr.awardUri}
              </a>
            </>
          ) : null}
        </p>
      )
    })
  }

  if (
    fieldDefinition?.component === 'RelatedIdentifiersInput' &&
    Array.isArray(data)
  ) {
    return data.map(ri => {
      const line = joinParts([
        textOf(ri.relationType),
        joinParts(
          [textOf(ri.relatedIdentifier), textOf(ri.relatedIdentifierType)],
          ' ',
        ),
        textOf(ri.resourceTypeGeneral),
        textOf(ri.relationTypeInformation),
      ])

      return <p key={ri.id}>{line || '(empty entry)'}</p>
    })
  }

  if (
    fieldDefinition?.component === 'ContributorsInput' &&
    Array.isArray(data)
  ) {
    return data.map(c => {
      const isOrg = c.nameType === 'Organizational'

      const name = isOrg
        ? textOf(c.organization)
        : joinParts([textOf(c.familyName), textOf(c.givenName)], ', ')

      const details = joinParts([
        textOf(c.contributorType),
        textOf(c.affiliation),
      ])

      return (
        <p key={c.id}>
          {name || '?'}
          {details ? <Affiliation> ({details})</Affiliation> : null}{' '}
          {textOf(c.orcid) ? <Email>{textOf(c.orcid)}</Email> : null}
        </p>
      )
    })
  }

  if (fieldDefinition?.component === 'TitlesInput' && Array.isArray(data)) {
    return data.map(ti => {
      const suffix = joinParts([textOf(ti.titleType), textOf(ti.lang)], ', ')

      return (
        <p key={ti.id}>
          {textOf(ti.title) || '?'}
          {suffix ? <Affiliation> ({suffix})</Affiliation> : null}
        </p>
      )
    })
  }

  if (
    fieldDefinition?.component === 'AlternateIdentifiersInput' &&
    Array.isArray(data)
  ) {
    return data.map(ai => (
      <p key={ai.id}>
        {joinParts(
          [textOf(ai.alternateIdentifier), textOf(ai.alternateIdentifierType)],
          ' — ',
        ) || '(empty entry)'}
      </p>
    ))
  }

  if (
    fieldDefinition?.component === 'MoreThanHumanAuthorsInput' &&
    Array.isArray(data)
  ) {
    return data.map(a => {
      const details = joinParts([
        textOf(a.entityKind),
        textOf(a.position) ? `position: ${textOf(a.position)}` : '',
        textOf(a.identifier),
        textOf(a.custodialAffiliation)
          ? `custodian: ${textOf(a.custodialAffiliation)}`
          : '',
      ])

      return (
        <p key={a.id}>
          {textOf(a.name) || '?'}
          {details ? <Affiliation> ({details})</Affiliation> : null}
        </p>
      )
    })
  }

  if (fieldDefinition?.component === 'PublisherInput' && data) {
    const label = textOf(data.label ?? data)

    const rorUrl =
      typeof data === 'object' &&
      typeof data.ror === 'string' &&
      data.ror.includes('ror.org')
        ? data.ror
        : null

    if (!label && !rorUrl) return null
    return (
      <p>
        {rorUrl ? (
          <a href={rorUrl} rel="noopener noreferrer" target="_blank">
            {label || rorUrl}
          </a>
        ) : (
          label
        )}
      </p>
    )
  }

  /* ---- end custom components ---- */

  if (
    fieldDefinition?.component === 'ThreadedDiscussion' &&
    data
  ) {
    // data should be the threadedDiscussion ID
    const discussion = threadedDiscussionProps.threadedDiscussions.find(
      d => d.id === data,
    ) || {
      threads: [],
    }

    const augmentedThreadedDiscussionProps = {
      ...threadedDiscussionProps,
      threadedDiscussion: discussion,
      threadedDiscussions: undefined,
      shouldRenderSubmitButton: true,
    }

    return (
      <ThreadedDiscussion
        threadedDiscussionProps={augmentedThreadedDiscussionProps}
      />
    )
  }

  if (
    ['SupplementaryFiles', 'VisualAbstract'].includes(
      fieldDefinition?.component,
    ) &&
    Array.isArray(data)
  ) {
    return data.map(file => (
      <Attachment file={file} key={file.storedObjects[0].url} uploaded />
    ))
  }

  if (
    // Shows supplementary, visualAbstract, manuscript tagged files in Metadata submission form
    ['SupplementaryFiles', 'VisualAbstract', 'ManuscriptFile'].includes(
      fieldDefinition?.component,
    ) &&
    Array.isArray(formData.files)
  ) {
    const supplementaryFiles = formData.files.filter(file =>
      file.tags.includes('supplementary'),
    )

    const visualAbstractFiles = formData.files.filter(file =>
      file.tags.includes('visualAbstract'),
    )

    const manuscriptFiles = formData.files.filter(file =>
      file.tags.includes('manuscript'),
    )

    if (
      fieldDefinition?.component === 'SupplementaryFiles' &&
      supplementaryFiles.length > 0
    )
      return supplementaryFiles.map(file => (
        <Attachment file={file} key={file.storedObjects[0].url} uploaded />
      ))

    if (
      fieldDefinition?.component === 'VisualAbstract' &&
      visualAbstractFiles.length > 0
    )
      return visualAbstractFiles.map(file => (
        <Attachment file={file} key={file.storedObjects[0].url} uploaded />
      ))

    if (
      fieldDefinition?.component === 'ManuscriptFile' &&
      manuscriptFiles.length > 0
    )
      return manuscriptFiles.map(file => (
        <Attachment file={file} key={file.storedObjects[0].url} uploaded />
      ))
  }

  if (
    data &&
    ['AbstractEditor', 'FullWaxField'].includes(fieldDefinition?.component)
  )
    return isCollaborativeForm ? (
      CollaborativeReadOnlyField(SimpleWaxEditor, data)
    ) : (
      <SimpleWaxEditor readonly value={data} />
    )

  if (
    data &&
    fieldDefinition?.component === 'TextField' &&
    isCollaborativeForm
  ) {
    const { identifier, name } = parseIdentifierAndName(data)
    return (
      <CollaborativeTextFieldBuilder
        collaborativeObject={{ identifier }}
        disabled
        identifier={data}
        name={name}
        onChange={() => {}}
      />
    )
  }

  if (fieldDefinition?.options) {
    const items = Array.isArray(data) ? data : [data]

    return (
      <BadgeContainer>
        {items.map(item => {
          if (!item && item !== 0) return null

          const option = fieldDefinition.options.find(x => x.value === item)

          if (option) {
            if (option.labelColor)
              return (
                <ColorBadge color={option.labelColor} key={option.id}>
                  {option.label}
                </ColorBadge>
              )

            return <div key={option.id}>{option.label}</div>
          }

          return <span key={item}>{item}</span> // Fallback for data not matching any option
        })}
      </BadgeContainer>
    )
  }

  if (fieldDefinition?.component === 'DatePicker' && data) {
    return (
      <p>
        <DateParser dateFormat="DD-MM-YYYY" timestamp={data} />
      </p>
    )
  }

  /* Crash guard: never hand a raw object/array to React as a child.
     Any future custom component without an explicit case above renders a
     safe textual fallback instead of white-screening the page (React #31). */
  if (data && typeof data === 'object') {
    return (
      <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
        {JSON.stringify(data, null, 1)}
      </pre>
    )
  }

  return data || (data === 0 ? '0' : null)
}

export default ReadonlyFieldData