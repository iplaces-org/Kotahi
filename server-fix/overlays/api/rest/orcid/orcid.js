const passport = require('passport')

const {
  createOrcidStrategy,
  handleOrcidOAuthResponse,
} = require('../../../controllers/orcid.controllers')

module.exports = app => {
  passport.use(createOrcidStrategy())

  // handle sign in request
  app.get('/auth/orcid', (req, res, next) => {
    const groupId = req.query.group_id
    const options = { state: `group_id=${groupId}` }
    passport.authenticate('orcid', options)(req, res, next)
  })

  // handle oauth response
  app.get(
    '/auth/orcid/callback',
    passport.authenticate('orcid', {
      failureRedirect: '/login',
      session: false,
    }),
    async (req, res) => {
      // req.user is the full user object created in the orcid strategy callback
      const redirectUrl = await handleOrcidOAuthResponse(req.user)

      // iplaces Patch 30: the redirect carries a fresh login token
      // (/<station>/login?token=<JWT>). The request logger (pino-http in
      // @coko/server) writes every response header to the server log, so
      // every login put a valid token in the Fly logs. Log the address
      // without its query string. The browser still gets the full Location.
      const getHeaders = res.getHeaders.bind(res)

      res.getHeaders = () => {
        const headers = getHeaders()
        if (typeof headers.location === 'string')
          headers.location = `${headers.location.split('?')[0]}?[redacted]`
        return headers
      }

      res.redirect(redirectUrl)
    },
  )
}
