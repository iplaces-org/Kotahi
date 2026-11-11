/* eslint-disable react-hooks/exhaustive-deps */
import { useContext, useEffect, useState } from 'react'
import { useLazyQuery, useMutation, useQuery } from '@apollo/client/react'
import { ConfigContext } from '../../config/src'
import {
  UPDATE_CONFIG,
  GET_SUBMISSION_FORM,
  GET_CONFIG_AND_EMAIL_TEMPLATES,
  CREATE_FILE,
  DELETE_FILE,
  GENERATE_NEW_COAR_AUTH_TOKEN,
  HAS_TOKEN,
  DATACITE_CONNECTION_CHECK,
} from '../../../queries'

import { CommsErrorBanner } from '../../shared'
import Spinner from '../../../ui/shared/Spinner'
import ConfigManagerForm from './ConfigManagerForm'

const ConfigManagerPage = () => {
  const config = useContext(ConfigContext)
  const [update] = useMutation(UPDATE_CONFIG)
  const [createFile] = useMutation(CREATE_FILE)
  const [deleteFile] = useMutation(DELETE_FILE)

  const { groupId } = config

  const [generateNewCoarAuthToken] = useMutation(GENERATE_NEW_COAR_AUTH_TOKEN)

  const [updateConfigStatus, setUpdateConfigStatus] = useState(null)

  // iplaces: after load and after every Save, ask the server whether the
  // DataCite settings work in the mode they are in (test or real).
  const [
    checkDatacite,
    { data: dataciteCheckData, loading: dataciteChecking },
  ] = useLazyQuery(DATACITE_CONNECTION_CHECK, { fetchPolicy: 'network-only' })

  useEffect(() => {
    checkDatacite().catch(() => {})
  }, [])

  const {
    data: currentMetadata,
    previousData: previousMetadata,
    loading: loadingMetadata,
  } = useQuery(GET_SUBMISSION_FORM, {
    variables: {
      groupId,
    },
  })

  const {
    loading,
    error,
    data: currentData,
    previousData,
  } = useQuery(GET_CONFIG_AND_EMAIL_TEMPLATES, {
    variables: { id: config?.id },
    fetchPolicy: 'network-only',
  })

  const {
    data: currentHasCoarTokenData,
    previousData: previousHasCoarTokenData,
    loading: loadingHasCoarToken,
  } = useQuery(HAS_TOKEN, {
    variables: { name: 'coar', groupId },
  })

  // iPlaces: keep the page mounted while these queries refetch (for example
  // after an image upload on the General tab). Without the previous data the
  // full-page spinner replaced the form on every refetch and the page jumped.
  const metadata = currentMetadata ?? previousMetadata
  const data = currentData ?? previousData
  const hasCoarTokenData = currentHasCoarTokenData ?? previousHasCoarTokenData

  const handleRefreshCoarAuthToken = async () => {
    const { data: coarRefreshData, errors: coarRefreshError } =
      await generateNewCoarAuthToken({
        variables: { name: 'coar', groupId },
        errorPolicy: 'all',
      })

    if (coarRefreshError) {
      console.error(
        'Error refreshing COAR Notify auth token:',
        coarRefreshError,
      )
    }

    return {
      authToken: coarRefreshData?.generateNewToken,
      error: coarRefreshError
        ? JSON.stringify(coarRefreshError[0], null, 2)
        : undefined,
    }
  }

  if (
    (loading && !data) ||
    (!metadata && loadingMetadata) ||
    (!hasCoarTokenData && loadingHasCoarToken)
  )
    return <Spinner fullpage />

  if (error) return <CommsErrorBanner error={error} />

  const hasCoarToken = hasCoarTokenData?.hasToken ?? false

  const updateConfig = async (configId, formData) => {
    setUpdateConfigStatus('pending')

    const response = await update({
      variables: {
        id: configId,
        input: {
          formData: JSON.stringify(formData),
          active: true,
        },
      },
    })

    setUpdateConfigStatus(response.data.updateConfig ? 'success' : 'failure')
    if (response.data.updateConfig) checkDatacite().catch(() => {})

    return response
  }

  const { submissionForm = {} } = metadata || {}

  const form = submissionForm?.structure ?? {
    name: '',
    children: [],
    description: '',
    haspopup: 'false',
  }

  return (
    <ConfigManagerForm
      config={data.config}
      configId={data.config.id}
      createFile={createFile}
      dataciteCheck={dataciteCheckData?.dataciteConnectionCheck}
      dataciteChecking={dataciteChecking}
      deleteFile={deleteFile}
      disabled={!data.config.active}
      emailTemplates={data.emailTemplates}
      formData={JSON.parse(data.config.formData)}
      hasCoarToken={hasCoarToken}
      onRefreshCoarAuthToken={handleRefreshCoarAuthToken}
      submissionForm={form}
      updateConfig={updateConfig}
      updateConfigStatus={updateConfigStatus}
    />
  )
}

export default ConfigManagerPage
