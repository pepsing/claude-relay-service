const express = require('express')
const { authenticateAdmin } = require('../../middleware/auth')
const logger = require('../../utils/logger')
const accountImportExportService = require('../../services/account/accountImportExportService')

const router = express.Router()

router.post('/accounts/export-json', authenticateAdmin, async (req, res) => {
  try {
    const accounts = Array.isArray(req.body?.accounts) ? req.body.accounts : null
    const data = await accountImportExportService.exportAccounts(accounts)

    return res.json({
      success: true,
      data
    })
  } catch (error) {
    logger.error('❌ Failed to export accounts JSON:', error)
    return res.status(500).json({
      success: false,
      message: error.message || '导出账户 JSON 失败'
    })
  }
})

router.post('/accounts/import-json', authenticateAdmin, async (req, res) => {
  try {
    const accounts = Array.isArray(req.body?.accounts) ? req.body.accounts : req.body
    const strategy = req.body?.strategy || 'ask'
    const result = await accountImportExportService.importAccounts(accounts, strategy)

    if (!result.success && result.code === 'ACCOUNT_NAME_CONFLICT') {
      return res.status(409).json(result)
    }

    return res.json(result)
  } catch (error) {
    logger.error('❌ Failed to import accounts JSON:', error)
    return res.status(400).json({
      success: false,
      message: error.message || '导入账户 JSON 失败'
    })
  }
})

router.post('/accounts/sync-json', authenticateAdmin, async (req, res) => {
  try {
    const result = await accountImportExportService.syncFromRemote({
      baseUrl: req.body?.baseUrl,
      username: req.body?.username,
      password: req.body?.password,
      strategy: req.body?.strategy || 'ask'
    })

    if (!result.success && result.code === 'ACCOUNT_NAME_CONFLICT') {
      return res.status(409).json(result)
    }

    return res.json(result)
  } catch (error) {
    logger.error('❌ Failed to sync accounts from remote CRS:', error)
    return res.status(400).json({
      success: false,
      message: error.message || '同步远端 CRS 账户失败'
    })
  }
})

module.exports = router
