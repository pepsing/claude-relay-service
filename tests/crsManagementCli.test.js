const fs = require('fs')
const os = require('os')
const path = require('path')
const {
  maskManagementKey,
  resolveConnectionConfig,
  run,
  saveConnectionConfig
} = require('../src/cli/crsManagementCli')

const managementKey = `crsm_${'a'.repeat(64)}`

function memoryStream() {
  let value = ''
  return {
    write: (chunk) => {
      value += chunk
    },
    read: () => value
  }
}

function createClient() {
  return {
    getUsageSummary: jest.fn().mockResolvedValue({ success: true, data: { requests: 3 } }),
    listApiKeys: jest.fn().mockResolvedValue({ success: true, data: { items: [] } }),
    createApiKey: jest.fn().mockResolvedValue({
      success: true,
      data: { apiKey: `cr_${'b'.repeat(64)}` }
    }),
    updateApiKey: jest.fn().mockResolvedValue({ success: true }),
    revealApiKey: jest.fn().mockResolvedValue({ success: true }),
    disableApiKey: jest.fn().mockResolvedValue({ success: true }),
    deleteApiKey: jest.fn().mockResolvedValue({ success: true }),
    listAccounts: jest.fn().mockResolvedValue({
      success: true,
      data: Array.from({ length: 25 }, (_, index) => ({ id: `account-${index}` }))
    }),
    createAccount: jest.fn().mockResolvedValue({ success: true }),
    updateAccount: jest.fn().mockResolvedValue({ success: true }),
    testAccount: jest.fn().mockResolvedValue({ success: true }),
    refreshAccount: jest.fn().mockResolvedValue({ success: true }),
    deleteAccount: jest.fn().mockResolvedValue({ success: true }),
    getApiKeyStats: jest.fn().mockResolvedValue({ success: true }),
    getAccountStats: jest.fn().mockResolvedValue({ success: true })
  }
}

async function runCommand(args, overrides = {}) {
  const stdout = memoryStream()
  const stderr = memoryStream()
  const client = overrides.client || createClient()
  let exitCode = 0
  const result = await run(['node', 'crsctl', ...args], {
    env: {
      CRS_BASE_URL: 'https://crs.example.com/',
      CRS_MANAGEMENT_KEY: managementKey,
      ...overrides.env
    },
    clientFactory: (options) => {
      if (overrides.onClientOptions) {
        overrides.onClientOptions(options)
      }
      return client
    },
    promptForManagementKey: overrides.promptForManagementKey,
    stdout,
    stderr,
    setExitCode: (value) => {
      exitCode = value
    }
  })

  return {
    client,
    exitCode,
    result,
    stderr: stderr.read(),
    stdout: stdout.read()
  }
}

describe('CRS management CLI', () => {
  test('runs compact status output through the shared CRS client', async () => {
    let clientOptions
    const execution = await runCommand(['--compact', 'status'], {
      onClientOptions: (options) => {
        clientOptions = options
      }
    })

    expect(execution.result).toBe(0)
    expect(execution.client.getUsageSummary).toHaveBeenCalledTimes(1)
    expect(JSON.parse(execution.stdout)).toEqual({
      success: true,
      data: { requests: 3 }
    })
    expect(clientOptions).toEqual({
      baseUrl: 'https://crs.example.com',
      managementKey,
      timeoutMs: 30000
    })
  })

  test('limits API key list output to ten items by default', async () => {
    const execution = await runCommand(['api-keys', 'list'])

    expect(execution.client.listApiKeys).toHaveBeenCalledWith({
      page: 1,
      pageSize: 10,
      search: undefined,
      isActive: undefined,
      sortBy: 'createdAt',
      sortOrder: 'desc'
    })
  })

  test('merges API key convenience options with JSON payload fields', async () => {
    const execution = await runCommand([
      'api-keys',
      'create',
      '--name',
      'Codex agent',
      '--permissions',
      'claude,openai',
      '--data',
      '{"dailyCostLimit":5}'
    ])

    expect(execution.client.createApiKey).toHaveBeenCalledWith({
      dailyCostLimit: 5,
      name: 'Codex agent',
      permissions: ['claude', 'openai']
    })
    expect(JSON.parse(execution.stdout).data.apiKey).toMatch(/^cr_[a-f0-9]{64}$/)
  })

  test('refuses destructive operations without explicit confirmation', async () => {
    const execution = await runCommand(['accounts', 'delete', 'claude', 'account-1'])

    expect(execution.result).toBe(1)
    expect(execution.exitCode).toBe(1)
    expect(execution.client.deleteAccount).not.toHaveBeenCalled()
    expect(JSON.parse(execution.stderr)).toEqual({
      success: false,
      error: 'Refusing to delete the account without --yes',
      status: null
    })
  })

  test('limits account list responses locally', async () => {
    const execution = await runCommand(['accounts', 'list', 'claude', '--limit', '3'])
    const response = JSON.parse(execution.stdout)

    expect(execution.client.listAccounts).toHaveBeenCalledWith('claude')
    expect(response.data).toHaveLength(3)
    expect(response.cli).toEqual({
      truncated: true,
      returned: 3,
      total: 25
    })
  })

  test('reads sensitive account data from a file without echoing it', async () => {
    const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'crsctl-test-'))
    const dataPath = path.join(tempDirectory, 'account.json')
    const refreshToken = 'sensitive-refresh-token'
    fs.writeFileSync(dataPath, JSON.stringify({ name: 'Rocky account', refreshToken }), {
      mode: 0o600
    })

    try {
      const execution = await runCommand(['accounts', 'create', 'claude', '--data-file', dataPath])

      expect(execution.client.createAccount).toHaveBeenCalledWith('claude', {
        name: 'Rocky account',
        refreshToken
      })
      expect(execution.stdout).not.toContain(refreshToken)
      expect(execution.stderr).not.toContain(refreshToken)
    } finally {
      fs.rmSync(tempDirectory, { recursive: true, force: true })
    }
  })

  test('redacts management and relay keys from error messages', async () => {
    const client = createClient()
    client.getUsageSummary.mockRejectedValue(
      new Error(`failed for ${managementKey} and cr_${'b'.repeat(64)}`)
    )

    const execution = await runCommand(['status'], { client })

    expect(execution.stderr).not.toContain(managementKey)
    expect(execution.stderr).not.toContain(`cr_${'b'.repeat(64)}`)
    expect(JSON.parse(execution.stderr).error).toBe('failed for crsm_[REDACTED] and cr_[REDACTED]')
  })

  test('stores local configuration with mode 0600 and masks the key', () => {
    const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'crsctl-test-'))
    const configPath = path.join(tempDirectory, 'config.json')

    try {
      const saved = saveConnectionConfig(
        {
          baseUrl: 'https://crs.example.com/',
          managementKey,
          timeoutMs: 45000
        },
        configPath
      )

      expect(saved.managementKey).toBe(maskManagementKey(managementKey))
      expect(fs.statSync(configPath).mode & 0o777).toBe(0o600)
      expect(JSON.parse(fs.readFileSync(configPath, 'utf8'))).toEqual({
        baseUrl: 'https://crs.example.com',
        managementKey,
        timeoutMs: 45000
      })
    } finally {
      fs.rmSync(tempDirectory, { recursive: true, force: true })
    }
  })

  test('environment variables override the stored connection', () => {
    const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'crsctl-test-'))
    const configPath = path.join(tempDirectory, 'config.json')
    const otherKey = `crsm_${'c'.repeat(64)}`

    try {
      saveConnectionConfig(
        {
          baseUrl: 'https://stored.example.com',
          managementKey,
          timeoutMs: 30000
        },
        configPath
      )

      expect(
        resolveConnectionConfig({
          configPath,
          env: {
            CRS_BASE_URL: 'https://env.example.com/',
            CRS_MANAGEMENT_KEY: otherKey,
            CRS_TIMEOUT_MS: '12000'
          }
        })
      ).toEqual({
        baseUrl: 'https://env.example.com',
        managementKey: otherKey,
        timeoutMs: 12000
      })
    } finally {
      fs.rmSync(tempDirectory, { recursive: true, force: true })
    }
  })
})
