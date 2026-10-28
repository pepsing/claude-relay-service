const express = require('express')
const { authenticateAdminSession } = require('../../middleware/auth')
const accessService = require('../../services/accountAccessService')

const router = express.Router()
// Authorization changes require an administrator session, not an ordinary relay key
// or a management key whose account-edit scope does not grant key permissions.
router.use('/account-access', authenticateAdminSession)

router.get('/account-access', async (_req, res) => {
  try {
    const [state, catalog] = await Promise.all([
      accessService.readState(),
      accessService.getCatalog()
    ])
    return res.json({ success: true, data: { state, ...catalog } })
  } catch (error) {
    return res.status(error.statusCode || 503).json({ success: false, message: error.message })
  }
})

router.put('/account-access', async (req, res) => {
  try {
    const state = await accessService.saveState(req.body, req.admin.username)
    return res.json({ success: true, data: state })
  } catch (error) {
    return res.status(error.statusCode || 503).json({ success: false, message: error.message })
  }
})

router.get('/account-access/audit', async (_req, res) => {
  try {
    return res.json({ success: true, data: await accessService.getAudit() })
  } catch (error) {
    return res.status(503).json({ success: false, message: error.message })
  }
})

module.exports = router
