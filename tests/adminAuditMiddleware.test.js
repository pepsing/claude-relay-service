const express = require('express')
const { EventEmitter } = require('events')
const request = require('supertest')
const { createAdminAuditMiddleware } = require('../src/middleware/adminAudit')

function waitForAuditWrite() {
  return new Promise((resolve) => setImmediate(resolve))
}

describe('admin audit middleware', () => {
  let service
  let app

  beforeEach(() => {
    service = {
      isEnabled: jest.fn(() => true),
      record: jest.fn().mockResolvedValue({})
    }
    app = express()
    app.use(express.json())
    app.use((req, _res, next) => {
      req.requestId = 'request-1'
      next()
    })
    app.use(createAdminAuditMiddleware({ service }))
  })

  test('records a management-key mutation with device identity and field names only', async () => {
    app.put('/admin/management/v1/accounts/:type/:id', (req, res) => {
      req.admin = {
        username: 'management-key:Office agent',
        authType: 'management-api-key',
        managementApiKeyId: 'management-key-1'
      }
      req.managementApiKey = { name: 'Office agent' }
      res.json({ success: true, data: { id: req.params.id, name: req.body.name } })
    })

    await request(app)
      .put('/admin/management/v1/accounts/claude/account-1')
      .set('X-CRS-Device-ID', 'device-1')
      .set('X-CRS-Device-Name', 'Office Mac')
      .set('X-CRS-Client', 'crsctl/1.2.0')
      .send({ name: 'Updated', refreshToken: 'must-not-be-recorded' })
      .expect(200)
    await waitForAuditWrite()

    expect(service.record).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: 'request-1',
        actorType: 'management-key',
        actorId: 'management-key-1',
        actorName: 'Office agent',
        deviceId: 'device-1',
        deviceName: 'Office Mac',
        clientName: 'crsctl',
        clientVersion: '1.2.0',
        action: 'account.update',
        resourceType: 'account',
        resourceId: 'account-1',
        resourceName: 'Updated',
        result: 'success',
        changedFields: ['name', 'refreshToken'],
        metadata: { accountType: 'claude' }
      })
    )
    expect(JSON.stringify(service.record.mock.calls[0][0])).not.toContain('must-not-be-recorded')
  })

  test('records failed authentication without persisting the password', async () => {
    app.post('/web/auth/login', (_req, res) => {
      res.status(401).json({ error: 'Invalid credentials' })
    })

    await request(app)
      .post('/web/auth/login')
      .send({ username: 'admin', password: 'must-not-be-recorded' })
      .expect(401)
    await waitForAuditWrite()

    expect(service.record).toHaveBeenCalledWith(
      expect.objectContaining({
        actorType: 'admin-session',
        actorId: 'admin',
        action: 'auth.login',
        result: 'failure',
        errorCode: 'HTTP_401',
        changedFields: ['username', 'password']
      })
    )
    expect(JSON.stringify(service.record.mock.calls[0][0])).not.toContain('must-not-be-recorded')
  })

  test('does not record ordinary read requests or audit-log queries', async () => {
    app.get('/admin/api-keys', (_req, res) => res.json({ success: true }))
    app.get('/admin/management/v1/audit-logs', (_req, res) => res.json({ success: true }))

    await request(app).get('/admin/api-keys').expect(200)
    await request(app).get('/admin/management/v1/audit-logs').expect(200)
    await waitForAuditWrite()

    expect(service.record).not.toHaveBeenCalled()
  })

  test('records administrator-only user changes but ignores user self-service writes', async () => {
    app.patch('/users/:userId/status', (req, res) => {
      req.admin = { username: 'admin' }
      res.json({ success: true })
    })
    app.post('/users/api-keys', (_req, res) => res.json({ success: true }))

    await request(app).patch('/users/user-1/status').send({ isActive: false }).expect(200)
    await request(app).post('/users/api-keys').send({ name: 'self-service' }).expect(200)
    await waitForAuditWrite()

    expect(service.record).toHaveBeenCalledTimes(1)
    expect(service.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'user.update_status',
        resourceType: 'user',
        resourceId: 'user-1',
        actorId: 'admin'
      })
    )
  })

  test('records a client-aborted management operation as a failure', async () => {
    const response = new EventEmitter()
    response.statusCode = 200
    response.writableEnded = false
    response.json = jest.fn()
    const req = {
      method: 'POST',
      originalUrl: '/admin/management/v1/accounts/claude/account-1/test',
      requestId: 'request-aborted',
      headers: {
        'x-crs-device-id': 'device-1'
      },
      get: (name) => req.headers[name.toLowerCase()],
      body: {},
      admin: {
        username: 'management-key:Agent',
        authType: 'management-api-key',
        managementApiKeyId: 'management-key-1'
      },
      managementApiKey: { name: 'Agent' },
      ip: '127.0.0.1'
    }
    const next = jest.fn()

    createAdminAuditMiddleware({ service })(req, response, next)
    response.emit('close')
    await waitForAuditWrite()

    expect(next).toHaveBeenCalledTimes(1)
    expect(service.record).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: 'request-aborted',
        result: 'failure',
        statusCode: 499,
        errorCode: 'CLIENT_ABORTED'
      })
    )
  })
})
