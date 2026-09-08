const crypto = require('crypto')
const { EventEmitter } = require('events')
const redis = require('../models/redis')
const config = require('../../config/config')
const logger = require('../utils/logger')
const apiKeyService = require('./apiKeyService')
const openaiAccountService = require('./account/openaiAccountService')
const openaiResponsesAccountService = require('./account/openaiResponsesAccountService')
const accountGroupService = require('./accountGroupService')
const { getSafeMessage } = require('../utils/errorSanitizer')

const TASK_TTL_SECONDS = 24 * 60 * 60
const MAX_RESULT_BYTES = 100 * 1024 * 1024
const SAVE_TASK_SCRIPT = `
local previous = redis.call('GET', KEYS[1])
if not previous and ARGV[3] ~= 'create' then return nil end
if previous then
  local task = cjson.decode(previous)
  if task.status == 'completed' or task.status == 'failed' then return previous end
end
redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[2])
return ARGV[1]
`

function taskError(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode, code: 'image_task_error' })
}

function taskKey(apiKeyId, id) {
  return `openai:image-task:${apiKeyId}:${id}`
}

function checkPermission(apiKey, model) {
  if (!apiKeyService.hasPermission(apiKey?.permissions, 'openai')) {
    throw taskError('This API key does not have permission to access OpenAI', 403)
  }
  if (
    apiKey.enableModelRestriction &&
    apiKey.restrictedModels?.some(
      (restricted) => String(restricted).toLowerCase() === String(model).toLowerCase()
    )
  ) {
    throw taskError('This API key does not have permission to access the image model', 403)
  }
}

function publicTask(task, req, upstream = {}) {
  const root = `${req.baseUrl || ''}${req.path.startsWith('/v1/') ? '/v1' : ''}/images`
  return {
    ...upstream,
    id: task.id,
    object: 'image',
    status: task.status,
    operation: task.operation,
    model: task.model,
    content_url: task.status === 'completed' ? `${root}/${task.id}/content` : null,
    error: task.error || null
  }
}

async function createTask(req, account, accountType, upstreamId = null) {
  const task = {
    id: `img_crs_${crypto.randomUUID()}`,
    apiKeyId: req.apiKey.id,
    accountId: account.id,
    accountType,
    baseApi: accountType === 'openai-responses' ? account.baseApi : null,
    upstreamId,
    model: req._imageRequestedModel || req.body.model || 'gpt-image-2',
    operation: req.path.endsWith('/edits') ? 'edit' : 'generation',
    status: 'pending',
    createdAt: Date.now(),
    deadline: Date.now() + 2 * (config.requestTimeout || 600000),
    expiresAt: Date.now() + TASK_TTL_SECONDS * 1000
  }
  await saveTask(task, true)
  return task
}

async function saveTask(task, create = false) {
  const ttl = Math.max(1, Math.ceil((task.expiresAt - Date.now()) / 1000))
  const saved = await redis
    .getClientSafe()
    .eval(
      SAVE_TASK_SCRIPT,
      1,
      taskKey(task.apiKeyId, task.id),
      JSON.stringify(task),
      ttl,
      create ? 'create' : 'update'
    )
  if (!saved) {
    throw taskError('Image task not found or expired', 404)
  }
  Object.assign(task, JSON.parse(saved))
}

async function bindUpstreamTask(req, account, data) {
  if (!data || !/^[\w-]{1,200}$/.test(data.id || '')) {
    throw taskError('Upstream did not return a valid image task ID', 502)
  }
  const task = await createTask(req, account, 'openai-responses', data.id)
  return updateUpstreamTask(task, req, data)
}

async function updateUpstreamTask(task, req, data) {
  if (data?.id !== task.upstreamId || !['pending', 'completed', 'failed'].includes(data?.status)) {
    throw taskError('Invalid upstream image task response', 502)
  }
  // Never rewrite the immutable account binding or copy upstream URLs into it.
  task.status = data.status
  task.error = data.error || null
  await saveTask(task)
  req._skipImageUsage = true
  if (data.usage || data.response?.usage) {
    const claimed = await redis
      .getClientSafe()
      .set(`${taskKey(task.apiKeyId, task.id)}:usage`, '1', 'EX', TASK_TTL_SECONDS, 'NX')
    req._skipImageUsage = claimed !== 'OK'
  }
  return publicTask(task, req, data)
}

async function getTask(req) {
  const id = req.params.imageId
  if (!/^img_crs_[\w-]{1,100}$/.test(id || '')) {
    throw taskError('Image task not found or expired', 404)
  }
  const stored = await redis.getClientSafe().get(taskKey(req.apiKey.id, id))
  if (!stored) {
    throw taskError('Image task not found or expired', 404)
  }
  const task = JSON.parse(stored)
  checkPermission(req.apiKey, task.model)
  if (!task.upstreamId && task.status === 'pending' && Date.now() > task.deadline) {
    task.status = 'failed'
    task.error = { message: 'Image task timed out or its worker stopped', type: 'task_failed' }
    await saveTask(task)
  }
  return task
}

async function getTaskAccount(task, apiKey) {
  const service =
    task.accountType === 'openai' ? openaiAccountService : openaiResponsesAccountService
  const account = await service.getAccount(task.accountId)
  if (
    !account ||
    account.isActive === false ||
    account.isActive === 'false' ||
    ['error', 'unauthorized', 'disabled'].includes(account.status) ||
    ![true, 'true'].includes(account.supportsImagesGenerations)
  ) {
    throw taskError('The original image task account is unavailable', 503)
  }
  if (task.accountType === 'openai-responses' && account.baseApi !== task.baseApi) {
    throw taskError('The original image task account endpoint has changed', 409)
  }
  const binding = apiKey.openaiAccountId
  if (binding?.startsWith('group:')) {
    const members = await accountGroupService.getGroupMembers(binding.slice(6))
    if (!members.includes(task.accountId)) {
      throw taskError('The API key no longer has access to the original task account', 403)
    }
  } else if (binding) {
    const expected =
      task.accountType === 'openai-responses' ? `responses:${task.accountId}` : task.accountId
    if (binding !== expected) {
      throw taskError('The API key no longer has access to the original task account', 403)
    }
  } else if (account.accountType && account.accountType !== 'shared') {
    throw taskError('The API key no longer has access to the original task account', 403)
  }
  return account
}

async function startLocalTask(req, account, execute) {
  const task = await createTask(req, account, 'openai')
  // The accepted task owns its lifetime; closing the creation response must not cancel it.
  const jobReq = Object.assign(new EventEmitter(), {
    apiKey: req.apiKey,
    body: { ...req.body, async: false },
    headers: { ...req.headers },
    path: req.path,
    originalUrl: req.originalUrl,
    baseUrl: req.baseUrl,
    method: 'POST',
    socket: { destroyed: false },
    complete: true,
    imageFiles: req.imageFiles,
    requestId: req.requestId,
    rateLimitInfo: req.rateLimitInfo
  })
  setImmediate(() => {
    runLocalTask(task, jobReq, execute).catch((error) => {
      logger.error('Failed to persist local image task result', {
        taskId: task.id,
        message: getSafeMessage(error)
      })
    })
  })
  return publicTask(task, req)
}

async function runLocalTask(task, jobReq, execute) {
  let timer
  try {
    const result = await new Promise((resolve, reject) => {
      const jobRes = Object.assign(new EventEmitter(), {
        statusCode: 200,
        headersSent: false,
        writableEnded: false,
        status(code) {
          this.statusCode = code
          return this
        },
        json(body) {
          this.headersSent = true
          this.writableEnded = true
          if (this.statusCode >= 400) {
            reject(taskError(body?.error?.message || 'Image task failed', this.statusCode))
          } else {
            resolve(body)
          }
          return this
        }
      })
      timer = setTimeout(
        () => {
          jobReq.emit('aborted')
          jobRes.destroyed = true
          reject(taskError('Image task timed out', 504))
        },
        Math.max(1, task.deadline - Date.now())
      )
      timer.unref?.()
      Promise.resolve()
        .then(() => execute(jobReq, jobRes))
        .catch(reject)
    })
    const encoded = JSON.stringify(result)
    if (!result?.data?.[0]?.b64_json || Buffer.byteLength(encoded) > MAX_RESULT_BYTES) {
      throw taskError('Invalid or oversized image task result', 502)
    }
    const ttl = Math.max(1, Math.ceil((task.expiresAt - Date.now()) / 1000))
    await redis.getClientSafe().set(`${taskKey(task.apiKeyId, task.id)}:result`, encoded, 'EX', ttl)
    task.status = 'completed'
  } catch (error) {
    task.status = 'failed'
    task.error = { message: getSafeMessage(error), type: 'task_failed' }
  } finally {
    clearTimeout(timer)
  }
  await saveTask(task)
}

async function sendLocalContent(task, res) {
  if (task.status !== 'completed') {
    throw taskError('Image task is not completed', 409)
  }
  const stored = await redis.getClientSafe().get(`${taskKey(task.apiKeyId, task.id)}:result`)
  if (!stored) {
    throw taskError('Image task result has expired', 410)
  }
  const result = JSON.parse(stored)
  const format = result.output_format || 'png'
  const types = { png: 'image/png', jpeg: 'image/jpeg', jpg: 'image/jpeg', webp: 'image/webp' }
  res.setHeader('Content-Type', types[format] || 'application/octet-stream')
  res.setHeader('Cache-Control', 'private, no-store')
  return res.send(Buffer.from(result.data[0].b64_json, 'base64'))
}

module.exports = {
  checkPermission,
  bindUpstreamTask,
  updateUpstreamTask,
  getTask,
  getTaskAccount,
  publicTask,
  startLocalTask,
  sendLocalContent
}
