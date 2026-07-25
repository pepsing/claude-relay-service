const express = require('express')
const { authenticateAdmin } = require('../../middleware/auth')
const requestFailureDetailService = require('../../services/requestFailureDetailService')
const logger = require('../../utils/logger')

const router = express.Router()

function sendFailureQueryError(res, error, message) {
  const statusCode = error?.statusCode || 500
  if (statusCode >= 500) {
    logger.error(message, error)
  }
  return res.status(statusCode).json({
    success: false,
    error: statusCode === 400 ? 'Invalid request failure query' : message,
    message: error.message
  })
}

router.get('/request-failures', authenticateAdmin, async (req, res) => {
  try {
    const data = await requestFailureDetailService.listRequestFailures(req.query || {})
    return res.json({ success: true, data })
  } catch (error) {
    return sendFailureQueryError(res, error, 'Failed to list request failures')
  }
})

router.get('/request-failures/metrics', authenticateAdmin, async (_req, res) =>
  res.json({
    success: true,
    data: requestFailureDetailService.getMetrics()
  })
)

router.get('/request-failures/:requestId', authenticateAdmin, async (req, res) => {
  try {
    const data = await requestFailureDetailService.getRequestFailure(req.params.requestId)
    if (!data.record) {
      return res.status(404).json({
        success: false,
        error: 'Request failure not found'
      })
    }
    return res.json({ success: true, data })
  } catch (error) {
    return sendFailureQueryError(res, error, 'Failed to get request failure')
  }
})

module.exports = router
