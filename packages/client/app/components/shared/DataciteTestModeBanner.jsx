// iplaces: a thin yellow bar across the top of every page of the station's
// Kotahi while the station is on DataCite TEST DOIs (Configuration >
// Integrations and Publishing > DataCite > "Use test DOIs"). Nothing at all
// on real DOIs. Reads the station's public config, which keeps useSandbox.
import { useContext } from 'react'
import { useTranslation } from 'react-i18next'
import styled from 'styled-components'
import { ConfigContext } from '../config/src'

const Bar = styled.div`
  background: #fff3cd;
  border-bottom: 1px solid #e6c65c;
  color: #4d3a00;
  flex: 0 0 auto;
  font-size: 14px;
  line-height: 1.4;
  padding: 6px 16px;
  text-align: center;
`

const DataciteTestModeBanner = () => {
  const config = useContext(ConfigContext)
  const { t } = useTranslation()

  if (!config?.publishing?.datacite?.useSandbox) return null

  return (
    <Bar role="status">
      <strong>{t('configPage.dataciteTestModeBanner')}</strong>{' '}
      {t('configPage.dataciteTestModeBannerDetail')}
    </Bar>
  )
}

export default DataciteTestModeBanner
