import { ReactNode } from 'react'
import styled from 'styled-components'
// @ts-ignore
import DataciteTestModeBanner from '../../components/shared/DataciteTestModeBanner'

// iplaces: the DataCite test-mode bar (only in test mode) sits across the
// top of every page. The layout below it keeps its full 100vh, as before, so
// pages that size themselves to the window are unchanged; in test mode the
// window scrolls by the bar's height instead of clipping the bottom. On real
// DOIs there is no bar and this is exactly the old layout.
const StyledShell = styled.div`
  height: 100vh;
  overflow-x: hidden;
  overflow-y: auto;
  width: 100vw;
`

const StyledLayout = styled.div`
  display: flex;

  height: 100vh;
  width: 100vw;

  overflow: hidden;

  > *:last-child {
    flex-grow: 1;
    min-width: 0;
  }
`

type LayoutProps = {
  children: ReactNode
}

const Layout = (props: LayoutProps): ReactNode => {
  const { children } = props

  return (
    <StyledShell>
      <DataciteTestModeBanner />
      <StyledLayout>{children}</StyledLayout>
    </StyledShell>
  )
}

export default Layout
