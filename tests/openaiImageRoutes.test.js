const request = require('supertest')
const { PassThrough, Readable } = require('stream')

jest.mock('axios', () => Object.assign(jest.fn(), { post: jest.fn() }))
jest.mock('../config/config', () => ({ requestTimeout: 30000 }))
jest.mock('../src/utils/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
  api: jest.fn(),
  security: jest.fn(),
  success: jest.fn(),
  isBrokenPipeError: jest.fn(() => false)
}))
jest.mock('../src/models/redis', () => ({
  getClientSafe: jest.fn(),
  incrConcurrency: jest.fn().mockResolvedValue(1),
  decrConcurrency: jest.fn().mockResolvedValue(0),
  refreshConcurrencyLease: jest.fn()
}))
jest.mock('../src/middleware/auth', () => ({
  authenticateApiKey(req, res, next) {
    const owner = req.headers['x-api-key']
    if (!owner) {
      return res.status(401).json({ error: 'Unauthorized' })
    }
    req.apiKey = {
      id: owner,
      permissions: ['openai'],
      enableModelRestriction: req.headers['x-block-model'] === 'true',
      restrictedModels: ['gpt-image-2']
    }
    next()
  }
}))
jest.mock('../src/services/account/openaiAccountService', () => ({
  getAccount: jest.fn(),
  decrypt: jest.fn(() => 'oauth-token'),
  isTokenExpired: jest.fn(() => false),
  refreshAccountToken: jest.fn()
}))
jest.mock('../src/services/account/openaiResponsesAccountService', () => ({
  getAccount: jest.fn(),
  getMappedModel: jest.fn((_, model) => model),
  handleProviderQuotaError: jest.fn().mockResolvedValue({ handled: false }),
  updateAccount: jest.fn(),
  updateAccountUsage: jest.fn(),
  updateUsageQuota: jest.fn()
}))
jest.mock('../src/services/scheduler/unifiedOpenAIScheduler', () => ({
  selectAccountForApiKey: jest.fn(),
  _getSessionMapping: jest.fn(),
  _deleteSessionMapping: jest.fn().mockResolvedValue(),
  isAccountRateLimited: jest.fn().mockResolvedValue(false),
  markAccountRateLimited: jest.fn(),
  markAccountUnauthorized: jest.fn()
}))
jest.mock('../src/services/claudeRelayConfigService', () => ({
  getConfig: jest.fn().mockResolvedValue({})
}))
jest.mock('../src/services/apiKeyService', () => ({
  hasPermission: jest.fn(() => true),
  recordUsage: jest.fn().mockResolvedValue({ totalCost: 0 })
}))
jest.mock('../src/services/accountGroupService', () => ({ getGroupMembers: jest.fn() }))
jest.mock('../src/utils/upstreamErrorHelper', () => ({
  sanitizeErrorForClient: jest.fn((body) => body),
  markTempUnavailable: jest.fn().mockResolvedValue(),
  parseRetryAfter: jest.fn()
}))

let app, axios, scheduler, accounts, oauthAccounts, apiKeys, records, redisClient
let accountA, accountB

beforeEach(() => {
  jest.resetModules()
  const express = require('express')
  axios = require('axios')
  scheduler = require('../src/services/scheduler/unifiedOpenAIScheduler')
  accounts = require('../src/services/account/openaiResponsesAccountService')
  oauthAccounts = require('../src/services/account/openaiAccountService')
  apiKeys = require('../src/services/apiKeyService')
  records = new Map()
  redisClient = {
    eval: jest.fn(async (_script, _count, key, value, _ttl, operation) => {
      const previous = records.get(key)
      if (!previous && operation !== 'create') return null
      if (previous && ['completed', 'failed'].includes(JSON.parse(previous).status)) return previous
      records.set(key, value)
      return value
    }),
    get: jest.fn(async (key) => records.get(key) || null),
    set: jest.fn(async (key, value, ...args) => {
      if (args.includes('NX') && records.has(key)) {
        return null
      }
      records.set(key, value)
      return 'OK'
    })
  }
  require('../src/models/redis').getClientSafe.mockReturnValue(redisClient)
  accountA = {
    id: 'account-a',
    name: 'Account A',
    apiKey: 'upstream-a',
    baseApi: 'https://a.example/v1',
    supportsImagesGenerations: true,
    supportsImagesAsync: true,
    isActive: true,
    accountType: 'shared',
    providerEndpoint: 'chat-completions',
    maxConcurrentTasks: 2
  }
  accountB = { ...accountA, id: 'account-b', apiKey: 'upstream-b', baseApi: 'https://b.example/v1' }
  accounts.getAccount.mockImplementation(async (id) =>
    [accountA, accountB].find((a) => a.id === id)
  )
  scheduler.selectAccountForApiKey.mockResolvedValue({
    accountId: accountA.id,
    accountType: 'openai-responses'
  })
  axios.mockImplementation(async () => ({
    status: 200,
    headers: {},
    data: { id: 'img_same', status: 'pending' }
  }))
  app = express()
  app.use(express.json())
  app.use('/openai', require('../src/routes/openaiRoutes'))
})

afterEach(() => jest.clearAllMocks())

async function createTask(options = {}) {
  const response = await request(app)
    .post('/openai/v1/images/generations')
    .set('x-api-key', 'owner')
    .send({ prompt: 'Draw a whale', async: true, ...options })
    .expect(200)
  return response.body.id
}

test('multipart edits preserve files, model mapping and the images path for a chat provider', async () => {
  accounts.getMappedModel.mockReturnValue('image-upstream-model')
  axios.mockResolvedValue({ status: 200, headers: {}, data: { data: [{ b64_json: 'edited' }] } })
  await request(app)
    .post('/openai/v1/images/edits')
    .set('x-api-key', 'owner')
    .field('prompt', 'Replace the sky')
    .field('n', '1')
    .field('async', 'false')
    .attach('image[]', Buffer.from([0, 1, 2, 255]), {
      filename: 'source.png',
      contentType: 'image/png'
    })
    .attach('mask', Buffer.from('mask'), { filename: 'mask.png', contentType: 'image/png' })
    .expect(200, { data: [{ b64_json: 'edited' }] })
  const sent = axios.mock.calls[0][0]
  expect(sent.url).toBe('https://a.example/v1/images/edits')
  expect(sent.headers['content-type']).toMatch(/^multipart\/form-data; boundary=/)
  expect(sent.data.getBuffer().includes(Buffer.from([0, 1, 2, 255]))).toBe(true)
  expect(sent.data.getBuffer().toString()).toContain('image-upstream-model')
  expect(sent.data.getBuffer().toString()).toContain('name="mask"')
  expect(scheduler.selectAccountForApiKey).toHaveBeenCalledWith(
    expect.anything(),
    null,
    'gpt-image-2',
    { requireImagesGenerations: true, imageAsync: false }
  )
})

test('task IDs isolate collisions and polling/download always use the creating account', async () => {
  const first = await createTask()
  scheduler.selectAccountForApiKey.mockResolvedValue({
    accountId: accountB.id,
    accountType: 'openai-responses'
  })
  const second = await createTask()
  expect(first).not.toBe(second)
  scheduler.selectAccountForApiKey.mockClear()
  axios.mockImplementation(async (options) => ({
    status: 200,
    headers: {},
    data: {
      id: 'img_same',
      status: 'completed',
      content_url: 'https://untrusted.example/content',
      usage: { input_tokens: 3, output_tokens: 4 },
      origin: options.url
    }
  }))
  const status = await request(app)
    .get(`/openai/v1/images/${first}`)
    .set('x-api-key', 'owner')
    .expect(200)
  expect(status.body.content_url).toBe(`/openai/v1/images/${first}/content`)
  expect(status.body.origin).toBe('https://a.example/v1/images/img_same')
  await Promise.all(
    [1, 2].map(() =>
      request(app).get(`/openai/v1/images/${first}`).set('x-api-key', 'owner').expect(200)
    )
  )
  expect(apiKeys.recordUsage).toHaveBeenCalledTimes(1)
  const statusB = await request(app)
    .get(`/openai/v1/images/${second}`)
    .set('x-api-key', 'owner')
    .expect(200)
  expect(statusB.body.origin).toBe('https://b.example/v1/images/img_same')
  const bytes = Buffer.from([137, 80, 78, 71, 0, 255])
  axios.mockResolvedValue({
    status: 200,
    headers: { 'content-type': 'image/png' },
    data: Readable.from([bytes])
  })
  const download = await request(app)
    .get(`/openai/v1/images/${first}/content`)
    .set('x-api-key', 'owner')
    .expect(200)
  expect(download.body).toEqual(bytes)
  expect(axios.mock.calls.at(-1)[0]).toMatchObject({
    url: 'https://a.example/v1/images/img_same/content',
    method: 'GET',
    data: undefined,
    headers: { Authorization: 'Bearer upstream-a' }
  })
  expect(scheduler.selectAccountForApiKey).not.toHaveBeenCalled()
})

test('task access rejects other API keys, missing auth, blocked models and unavailable original accounts', async () => {
  const id = await createTask()
  axios.mockClear()
  await request(app).get(`/openai/v1/images/${id}`).expect(401)
  await request(app).get(`/openai/v1/images/${id}`).set('x-api-key', 'other').expect(404)
  await request(app).get(`/openai/v1/images/${id}/content`).set('x-api-key', 'other').expect(404)
  await request(app)
    .get(`/openai/v1/images/${id}`)
    .set('x-api-key', 'owner')
    .set('x-block-model', 'true')
    .expect(403)
  await request(app).get(`/openai/v1/images/${id}/content`).set('x-api-key', 'owner').expect(409)
  accountA.supportsImagesGenerations = false
  await request(app).get(`/openai/v1/images/${id}`).set('x-api-key', 'owner').expect(503)
  accountA.supportsImagesGenerations = true
  accountA.baseApi = 'https://changed.example/v1'
  await request(app).get(`/openai/v1/images/${id}`).set('x-api-key', 'owner').expect(409)
  accounts.getAccount.mockResolvedValue(null)
  await request(app).get(`/openai/v1/images/${id}`).set('x-api-key', 'owner').expect(503)
  expect(axios).not.toHaveBeenCalled()
  expect(scheduler.selectAccountForApiKey).toHaveBeenCalledTimes(1)
})

test.each([{ n: 2 }, { stream: true }, { async: 'true' }])(
  'rejects invalid async parameters %j before scheduling',
  async (body) => {
    await request(app)
      .post('/openai/v1/images/generations')
      .set('x-api-key', 'owner')
      .send({ prompt: 'Draw', async: true, ...body })
      .expect(400)
    expect(scheduler.selectAccountForApiKey).not.toHaveBeenCalled()
  }
)

test('multipart model restriction is enforced after parsing', async () => {
  await request(app)
    .post('/openai/images/edits')
    .set('x-api-key', 'owner')
    .set('x-block-model', 'true')
    .field('prompt', 'Edit')
    .field('model', 'gpt-image-2')
    .attach('image', Buffer.from('image'), 'image.png')
    .expect(403)
  expect(scheduler.selectAccountForApiKey).not.toHaveBeenCalled()
})

test('unversioned aliases support async edits and lookup', async () => {
  const response = await request(app)
    .post('/openai/images/edits')
    .set('x-api-key', 'owner')
    .field('prompt', 'Edit')
    .field('async', 'true')
    .attach('image', Buffer.from('image'), 'image.png')
    .expect(200)
  expect(response.body.operation).toBe('edit')
  axios.mockResolvedValue({
    status: 200,
    headers: {},
    data: { id: 'img_same', status: 'completed' }
  })
  const status = await request(app)
    .get(`/openai/images/${response.body.id}`)
    .set('x-api-key', 'owner')
    .expect(200)
  expect(status.body.content_url).toBe(`/openai/images/${response.body.id}/content`)
})

test('OAuth async editing continues after acceptance and exposes a persisted downloadable result', async () => {
  const oauthAccount = {
    ...accountA,
    id: 'oauth',
    accessToken: 'encrypted',
    accountId: 'chatgpt-id'
  }
  oauthAccounts.getAccount.mockResolvedValue(oauthAccount)
  scheduler.selectAccountForApiKey.mockResolvedValue({ accountId: 'oauth', accountType: 'openai' })
  const upstream = new PassThrough()
  axios.post.mockResolvedValue({ status: 200, data: upstream })
  const created = await request(app)
    .post('/openai/v1/images/edits')
    .set('x-api-key', 'owner')
    .field('prompt', 'Edit')
    .field('async', 'true')
    .attach('image', Buffer.from('original'), 'image.png')
    .attach('mask', Buffer.from('mask'), 'mask.png')
    .expect(200)
  expect(created.body.status).toBe('pending')
  await new Promise(setImmediate)
  const payload = axios.post.mock.calls[0][1]
  expect(payload.tools[0]).toMatchObject({
    action: 'edit',
    input_image_mask: { image_url: 'data:image/png;base64,bWFzaw==' }
  })
  expect(payload.input[0].content[1]).toEqual({
    type: 'input_image',
    image_url: 'data:image/png;base64,b3JpZ2luYWw='
  })
  expect(axios.post.mock.calls[0][2].signal.aborted).toBe(false)
  const id = created.body.id
  const bytes = Buffer.from('final image bytes')
  upstream.end(
    `data: ${JSON.stringify({
      type: 'response.completed',
      response: {
        tools: [{ output_format: 'png' }],
        output: [{ type: 'image_generation_call', result: bytes.toString('base64') }],
        usage: { input_tokens: 2, output_tokens: 3 }
      }
    })}\n`
  )
  await new Promise(setImmediate)
  await new Promise(setImmediate)
  const status = await request(app)
    .get(`/openai/v1/images/${id}`)
    .set('x-api-key', 'owner')
    .expect(200)
  expect(status.body.status).toBe('completed')
  const content = await request(app)
    .get(status.body.content_url)
    .set('x-api-key', 'owner')
    .expect(200)
  expect(content.body).toEqual(bytes)
  expect(scheduler.selectAccountForApiKey).toHaveBeenCalledTimes(1)
  expect(apiKeys.recordUsage).toHaveBeenCalledTimes(1)
  expect(require('../src/models/redis').decrConcurrency).toHaveBeenCalledTimes(1)
  expect([...records.values()].join('')).not.toContain('oauth-token')
})

test('terminal status cannot regress and model mapping cannot bypass task restrictions', async () => {
  accounts.getMappedModel.mockReturnValue('provider-image-model')
  const id = await createTask()
  axios.mockResolvedValueOnce({
    status: 200,
    headers: {},
    data: { id: 'img_same', status: 'completed' }
  })
  await request(app).get(`/openai/v1/images/${id}`).set('x-api-key', 'owner').expect(200)
  axios.mockResolvedValueOnce({
    status: 200,
    headers: {},
    data: { id: 'img_same', status: 'pending' }
  })
  const late = await request(app)
    .get(`/openai/v1/images/${id}`)
    .set('x-api-key', 'owner')
    .expect(200)
  expect(late.body.status).toBe('completed')
  expect(late.body.model).toBe('gpt-image-2')
  await request(app)
    .get(`/openai/v1/images/${id}`)
    .set('x-api-key', 'owner')
    .set('x-block-model', 'true')
    .expect(403)
})

test('upstream errors and expired bindings never trigger reselection', async () => {
  const id = await createTask()
  scheduler.selectAccountForApiKey.mockClear()
  axios.mockResolvedValueOnce({
    status: 503,
    headers: {},
    data: { error: { message: 'Temporarily unavailable' } }
  })
  await request(app).get(`/openai/v1/images/${id}`).set('x-api-key', 'owner').expect(503)
  records.clear()
  axios.mockClear()
  await request(app).get(`/openai/v1/images/${id}`).set('x-api-key', 'owner').expect(404)
  await request(app).get(`/openai/v1/images/${id}/content`).set('x-api-key', 'owner').expect(404)
  expect(axios).not.toHaveBeenCalled()
  expect(scheduler.selectAccountForApiKey).not.toHaveBeenCalled()
})

test('rejects malformed edits without reaching an account', async () => {
  await request(app)
    .post('/openai/v1/images/edits')
    .set('x-api-key', 'owner')
    .send({ prompt: 'Edit' })
    .expect(415)
  await request(app)
    .post('/openai/v1/images/edits')
    .set('x-api-key', 'owner')
    .field('prompt', 'Edit')
    .expect(400)
  await request(app)
    .post('/openai/v1/images/edits')
    .set('x-api-key', 'owner')
    .field('prompt', 'Edit')
    .field('async', 'maybe')
    .attach('image', Buffer.from('image'), 'image.png')
    .expect(400)
  await request(app)
    .post('/openai/v1/images/edits')
    .set('x-api-key', 'owner')
    .field('prompt', 'Edit')
    .attach('other', Buffer.from('file'), 'file.txt')
    .expect(400)
  expect(scheduler.selectAccountForApiKey).not.toHaveBeenCalled()
})

test('OAuth worker failures persist a failed task and release its account lease', async () => {
  oauthAccounts.getAccount.mockResolvedValue({ ...accountA, id: 'oauth', accessToken: 'encrypted' })
  scheduler.selectAccountForApiKey.mockResolvedValue({ accountId: 'oauth', accountType: 'openai' })
  const upstream = new PassThrough()
  axios.post.mockResolvedValue({ status: 200, data: upstream })
  const id = await createTask()
  await new Promise(setImmediate)
  upstream.destroy(new Error('stream failed'))
  await new Promise(setImmediate)
  const status = await request(app)
    .get(`/openai/v1/images/${id}`)
    .set('x-api-key', 'owner')
    .expect(200)
  expect(status.body.status).toBe('failed')
  await request(app).get(`/openai/v1/images/${id}/content`).set('x-api-key', 'owner').expect(409)
  expect(require('../src/models/redis').decrConcurrency).toHaveBeenCalledTimes(1)
})

test('content redirects download bytes without forwarding account credentials to the new origin', async () => {
  const http = require('http')
  const bytes = Buffer.from([137, 80, 78, 71, 255, 0])
  let storageHeaders, contentHeaders
  const storage = http.createServer((req, res) => {
    storageHeaders = req.headers
    res.writeHead(200, { 'content-type': 'image/png' })
    res.end(bytes)
  })
  const upstream = http.createServer((req, res) => {
    if (req.url.endsWith('/content')) {
      contentHeaders = req.headers
      res.writeHead(302, { location: `http://127.0.0.1:${storage.address().port}/signed.png` })
      res.end()
    } else {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ id: 'img_real', status: 'completed' }))
    }
  })
  await new Promise((resolve) => storage.listen(0, '127.0.0.1', resolve))
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve))
  try {
    accountA.baseApi = `http://127.0.0.1:${upstream.address().port}/v1`
    axios.mockImplementation((options) => jest.requireActual('axios')({ ...options, proxy: false }))
    const id = await createTask()
    const download = await request(app)
      .get(`/openai/v1/images/${id}/content`)
      .set('x-api-key', 'owner')
      .expect(200)
    expect(download.body).toEqual(bytes)
    expect(contentHeaders.authorization).toBe('Bearer upstream-a')
    expect(storageHeaders.authorization).toBeUndefined()
    expect(storageHeaders['x-api-key']).toBeUndefined()
  } finally {
    await Promise.all(
      [upstream, storage].map((server) => new Promise((resolve) => server.close(resolve)))
    )
  }
})

test('async multipart edits pass their mode to the scheduler', async () => {
  await request(app)
    .post('/openai/v1/images/edits')
    .set('x-api-key', 'owner')
    .field('prompt', 'Edit')
    .field('async', 'true')
    .attach('image', Buffer.from('input'), { filename: 'input.png', contentType: 'image/png' })
    .expect(200)
  expect(scheduler.selectAccountForApiKey).toHaveBeenCalledWith(
    expect.anything(),
    null,
    'gpt-image-2',
    { requireImagesGenerations: true, imageAsync: true }
  )
})

test.each([true, false])(
  'rejects a stale selected account missing the requested image mode: async=%s',
  async (async) => {
    accountA[async ? 'supportsImagesAsync' : 'supportsImagesSync'] = false
    await request(app)
      .post('/openai/v1/images/generations')
      .set('x-api-key', 'owner')
      .send({ prompt: 'Draw', async })
      .expect(400)
    expect(axios).not.toHaveBeenCalled()
  }
)

test('disabling creation modes does not reroute or block an existing task', async () => {
  const id = await createTask()
  accountA.supportsImagesSync = false
  accountA.supportsImagesAsync = false
  axios.mockResolvedValue({
    status: 200,
    headers: {},
    data: { id: 'img_same', status: 'completed' }
  })
  scheduler.selectAccountForApiKey.mockClear()
  await request(app).get(`/openai/v1/images/${id}`).set('x-api-key', 'owner').expect(200)
  axios.mockResolvedValue({
    status: 200,
    headers: { 'content-type': 'image/png' },
    data: Readable.from([Buffer.from('image')])
  })
  await request(app).get(`/openai/v1/images/${id}/content`).set('x-api-key', 'owner').expect(200)
  expect(scheduler.selectAccountForApiKey).not.toHaveBeenCalled()
  expect(axios.mock.calls.at(-1)[0].url).toBe('https://a.example/v1/images/img_same/content')
})
