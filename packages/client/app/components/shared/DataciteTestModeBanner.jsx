// iplaces: shown wherever a record can get a DOI while the station is set to
// DataCite TEST DOIs (Configuration > Integrations > DataCite > "Use test
// DOIs"). Reads the station's public config, which keeps useSandbox.
import { useContext } from 'react'
import { useTranslation } from 'react-i18next'
import { ConfigContext } from '../config/src'
import Alert from './Alert'

const DataciteTestModeBanner = () => {
  const config = useContext(ConfigContext)
  const { t } = useTranslation()

  if (!config?.publishing?.datacite?.useSandbox) return null

  return (
    <Alert
      bottomMargin={1}
      description={t('configPage.dataciteTestModeBannerDetail')}
      message={t('configPage.dataciteTestModeBanner')}
      showIcon
      type="warning"
    />
  )
}

export default DataciteTestModeBanner
