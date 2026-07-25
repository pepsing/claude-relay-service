const fs = require('fs')
const os = require('os')
const path = require('path')
const { Command } = require('commander')
const inquirer = require('inquirer')
const { ACCOUNT_ROUTES, CrsClient } = require('../mcp/crsClient')

const DEFAULT_TIMEOUT_MS = 30000
const MANAGEMENT_KEY_PATTERN = /^crsm_[a-f0-9]{64}$/

function defaultConfigPath() {
  return path.join(os.homedir(), '.config', 'crsctl', 'config.json')
}

function resolveConfigPath(options = {}) {
  return path.resolve(options.configPath || options.env?.CRSCTL_CONFIG || defaultConfigPath())
}

function parsePositiveInteger(value, label = 'value') {
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive integer`)
  }
  return parsed
}

function parseBoolean(value) {
  if (value === true || value === 'true') {
    return true
  }
  if (value === false || value === 'false') {
    return false
  }
  throw new Error('active must be true or false')
}

function parseCsv(value) {
  return String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
}

function redactSecretText(value) {
  return String(value || '')
    .replace(/crsm_[a-f0-9]{64}/gi, 'crsm_[REDACTED]')
    .replace(/cr_[a-f0-9]{64}/gi, 'cr_[REDACTED]')
}

function maskManagementKey(value) {
  if (!value) {
    return ''
  }
  const key = String(value)
  return key.length > 18 ? `${key.slice(0, 9)}...${key.slice(-6)}` : '[REDACTED]'
}

function readStoredConfig(configPath) {
  if (!fs.existsSync(configPath)) {
    return {}
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch (error) {
    throw new Error(`Cannot read CRS CLI config ${configPath}: ${error.message}`)
  }
}

function validateConnectionConfig(config) {
  if (!config.baseUrl) {
    throw new Error('CRS base URL is required')
  }

  const parsedUrl = new URL(config.baseUrl)
  if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
    throw new Error('CRS base URL must use http or https')
  }
  if (!MANAGEMENT_KEY_PATTERN.test(config.managementKey || '')) {
    throw new Error('A valid crsm_ management key is required')
  }

  return {
    baseUrl: String(config.baseUrl).replace(/\/+$/, ''),
    managementKey: config.managementKey,
    timeoutMs: parsePositiveInteger(config.timeoutMs || DEFAULT_TIMEOUT_MS, 'timeout')
  }
}

function resolveConnectionConfig(options = {}) {
  const env = options.env || process.env
  const configPath = resolveConfigPath({ configPath: options.configPath, env })
  const stored = readStoredConfig(configPath)

  return validateConnectionConfig({
    baseUrl: options.baseUrl || env.CRS_BASE_URL || stored.baseUrl,
    managementKey: env.CRS_MANAGEMENT_KEY || stored.managementKey,
    timeoutMs:
      options.timeoutMs ||
      env.CRS_TIMEOUT_MS ||
      env.CRS_MCP_TIMEOUT_MS ||
      stored.timeoutMs ||
      DEFAULT_TIMEOUT_MS
  })
}

function saveConnectionConfig(config, configPath = defaultConfigPath()) {
  const validated = validateConnectionConfig(config)
  const resolvedPath = path.resolve(configPath)
  const directory = path.dirname(resolvedPath)

  fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
  fs.writeFileSync(
    resolvedPath,
    `${JSON.stringify(
      {
        baseUrl: validated.baseUrl,
        managementKey: validated.managementKey,
        timeoutMs: validated.timeoutMs
      },
      null,
      2
    )}\n`,
    { mode: 0o600 }
  )
  fs.chmodSync(resolvedPath, 0o600)

  return {
    configPath: resolvedPath,
    baseUrl: validated.baseUrl,
    managementKey: maskManagementKey(validated.managementKey),
    timeoutMs: validated.timeoutMs
  }
}

function readJsonPayload(options = {}) {
  if (options.data && options.dataFile) {
    throw new Error('Use either --data or --data-file, not both')
  }

  const raw = options.dataFile
    ? fs.readFileSync(path.resolve(options.dataFile), 'utf8')
    : options.data

  if (!raw) {
    return {}
  }

  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new Error(`Invalid JSON payload: ${error.message}`)
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('JSON payload must be an object')
  }
  return parsed
}

function limitKnownCollection(result, limit) {
  const candidates = [['data'], ['accounts'], ['items'], ['data', 'accounts'], ['data', 'items']]

  for (const segments of candidates) {
    let current = result
    for (const segment of segments) {
      current = current?.[segment]
    }
    if (!Array.isArray(current)) {
      continue
    }

    const limited = current.slice(0, limit)
    if (limited.length === current.length) {
      return result
    }

    const clone = { ...result }
    let target = clone
    let source = result
    for (let index = 0; index < segments.length - 1; index += 1) {
      const segment = segments[index]
      target[segment] = { ...source[segment] }
      target = target[segment]
      source = source[segment]
    }
    target[segments[segments.length - 1]] = limited
    clone.cli = {
      truncated: true,
      returned: limited.length,
      total: current.length
    }
    return clone
  }

  return result
}

function writeJson(stream, value, compact = false) {
  stream.write(`${JSON.stringify(value, null, compact ? 0 : 2)}\n`)
}

async function defaultPromptForManagementKey() {
  const response = await inquirer.prompt([
    {
      type: 'password',
      name: 'managementKey',
      message: 'Rocky CRS 管理密钥:',
      mask: '*',
      validate: (value) => MANAGEMENT_KEY_PATTERN.test(value) || '请输入有效的 crsm_ 管理密钥'
    }
  ])
  return response.managementKey
}

function createProgram(dependencies = {}) {
  const env = dependencies.env || process.env
  const stdout = dependencies.stdout || process.stdout
  const stderr = dependencies.stderr || process.stderr
  const clientFactory = dependencies.clientFactory || ((options) => new CrsClient(options))
  const promptForManagementKey =
    dependencies.promptForManagementKey || defaultPromptForManagementKey

  const program = new Command()
    .name('crsctl')
    .description('Agent-friendly CLI for managing a remote CRS instance')
    .version('1.0.0')
    .option('--config <path>', 'configuration file path')
    .option('--compact', 'emit compact single-line JSON')
    .option('--timeout <ms>', 'request timeout in milliseconds', (value) =>
      parsePositiveInteger(value, 'timeout')
    )
    .showHelpAfterError()

  program.configureOutput({
    writeOut: (value) => stdout.write(value),
    writeErr: (value) => stderr.write(value)
  })

  const output = (command, value) => {
    const options = command.optsWithGlobals()
    writeJson(stdout, value, options.compact)
  }

  const execute = async (command, handler) => {
    const options = command.optsWithGlobals()
    const connection = resolveConnectionConfig({
      configPath: options.config,
      timeoutMs: options.timeout,
      env
    })
    const client = clientFactory(connection)
    output(command, await handler(client))
  }

  program
    .command('configure')
    .description('save the CRS URL and management key in a mode-0600 local config file')
    .requiredOption('--base-url <url>', 'CRS root URL without /admin')
    .option('--timeout <ms>', 'request timeout in milliseconds', (value) =>
      parsePositiveInteger(value, 'timeout')
    )
    .action(async (options, command) => {
      const managementKey = env.CRS_MANAGEMENT_KEY || (await promptForManagementKey())
      const configPath = resolveConfigPath({
        configPath: command.optsWithGlobals().config,
        env
      })
      output(
        command,
        saveConnectionConfig(
          {
            baseUrl: options.baseUrl,
            managementKey,
            timeoutMs: options.timeout || DEFAULT_TIMEOUT_MS
          },
          configPath
        )
      )
    })

  const config = program.command('config').description('inspect local CLI configuration')

  config
    .command('path')
    .description('print the active configuration path')
    .action((_options, command) => {
      output(command, {
        configPath: resolveConfigPath({
          configPath: command.optsWithGlobals().config,
          env
        })
      })
    })

  config
    .command('show')
    .description('show non-secret configuration and a masked key preview')
    .action((_options, command) => {
      const globalOptions = command.optsWithGlobals()
      const configPath = resolveConfigPath({ configPath: globalOptions.config, env })
      const connection = resolveConnectionConfig({
        configPath,
        timeoutMs: globalOptions.timeout,
        env
      })
      output(command, {
        configPath,
        baseUrl: connection.baseUrl,
        managementKey: maskManagementKey(connection.managementKey),
        managementKeySource: env.CRS_MANAGEMENT_KEY ? 'environment' : 'config',
        timeoutMs: connection.timeoutMs
      })
    })

  program
    .command('status')
    .description('get the CRS dashboard and service summary')
    .action(async (_options, command) => {
      await execute(command, async (client) => await client.getUsageSummary())
    })

  const apiKeys = program.command('api-keys').description('manage relay API keys')

  apiKeys
    .command('list')
    .description('list relay API keys (defaults to 10 results)')
    .option('--page <number>', 'page number', (value) => parsePositiveInteger(value, 'page'), 1)
    .option(
      '--page-size <number>',
      'page size: 10, 20, 50, 100, or 200',
      (value) => parsePositiveInteger(value, 'page-size'),
      10
    )
    .option('--search <text>', 'search term')
    .option('--active <boolean>', 'filter by active state', parseBoolean)
    .option('--sort-by <field>', 'sort field', 'createdAt')
    .option('--sort-order <order>', 'asc or desc', 'desc')
    .action(async (options, command) => {
      await execute(
        command,
        async (client) =>
          await client.listApiKeys({
            page: options.page,
            pageSize: options.pageSize,
            search: options.search,
            isActive: options.active,
            sortBy: options.sortBy,
            sortOrder: options.sortOrder
          })
      )
    })

  apiKeys
    .command('create')
    .description('create a relay API key; output contains the plaintext cr_ key')
    .option('--name <name>', 'display name')
    .option('--description <text>', 'description')
    .option('--permissions <csv>', 'comma-separated service permissions', parseCsv)
    .option('--expires-at <iso>', 'ISO-8601 expiration time')
    .option('--data <json>', 'additional JSON object fields')
    .option('--data-file <path>', 'read additional JSON object fields from a file')
    .action(async (options, command) => {
      const payload = {
        ...readJsonPayload(options),
        ...(options.name ? { name: options.name } : {}),
        ...(options.description ? { description: options.description } : {}),
        ...(options.permissions ? { permissions: options.permissions } : {}),
        ...(options.expiresAt ? { expiresAt: options.expiresAt } : {})
      }
      if (!payload.name) {
        throw new Error('API key name is required via --name or --data')
      }
      await execute(command, async (client) => await client.createApiKey(payload))
    })

  apiKeys
    .command('update <key-id>')
    .description('update relay API key metadata, permissions, limits, or bindings')
    .option('--data <json>', 'JSON object with updates')
    .option('--data-file <path>', 'read the JSON updates from a file')
    .action(async (keyId, options, command) => {
      const payload = readJsonPayload(options)
      if (Object.keys(payload).length === 0) {
        throw new Error('API key updates are required via --data or --data-file')
      }
      await execute(command, async (client) => await client.updateApiKey(keyId, payload))
    })

  apiKeys
    .command('reveal <key-id>')
    .description('reveal one plaintext relay API key')
    .action(async (keyId, _options, command) => {
      await execute(command, async (client) => await client.revealApiKey(keyId))
    })

  apiKeys
    .command('disable <key-id>')
    .description('disable a relay API key')
    .option('--yes', 'confirm the state-changing operation')
    .action(async (keyId, options, command) => {
      if (!options.yes) {
        throw new Error('Refusing to disable the API key without --yes')
      }
      await execute(command, async (client) => await client.disableApiKey(keyId))
    })

  apiKeys
    .command('delete <key-id>')
    .description('soft-delete a relay API key')
    .option('--yes', 'confirm the destructive operation')
    .action(async (keyId, options, command) => {
      if (!options.yes) {
        throw new Error('Refusing to delete the API key without --yes')
      }
      await execute(command, async (client) => await client.deleteApiKey(keyId))
    })

  const accounts = program.command('accounts').description('manage upstream accounts')

  accounts
    .command('types')
    .description('list supported account type identifiers')
    .action((_options, command) => {
      output(command, { success: true, data: Object.keys(ACCOUNT_ROUTES) })
    })

  accounts
    .command('list <type>')
    .description('list accounts for one account type')
    .option(
      '--limit <number>',
      'maximum returned accounts',
      (value) => parsePositiveInteger(value, 'limit'),
      20
    )
    .action(async (type, options, command) => {
      await execute(command, async (client) =>
        limitKnownCollection(await client.listAccounts(type), options.limit)
      )
    })

  accounts
    .command('create <type>')
    .description('create an upstream account')
    .option('--data <json>', 'account JSON object')
    .option('--data-file <path>', 'read the account JSON object from a file')
    .action(async (type, options, command) => {
      const payload = readJsonPayload(options)
      if (Object.keys(payload).length === 0) {
        throw new Error('Account data is required via --data or --data-file')
      }
      await execute(command, async (client) => await client.createAccount(type, payload))
    })

  accounts
    .command('update <type> <account-id>')
    .description('update an upstream account')
    .option('--data <json>', 'account update JSON object')
    .option('--data-file <path>', 'read the account update JSON object from a file')
    .action(async (type, accountId, options, command) => {
      const payload = readJsonPayload(options)
      if (Object.keys(payload).length === 0) {
        throw new Error('Account updates are required via --data or --data-file')
      }
      await execute(command, async (client) => await client.updateAccount(type, accountId, payload))
    })

  accounts
    .command('test <type> <account-id>')
    .description('run the existing account connectivity test')
    .action(async (type, accountId, _options, command) => {
      await execute(command, async (client) => await client.testAccount(type, accountId))
    })

  accounts
    .command('refresh <type> <account-id>')
    .description('refresh account credentials or profile through the existing API')
    .action(async (type, accountId, _options, command) => {
      await execute(command, async (client) => await client.refreshAccount(type, accountId))
    })

  accounts
    .command('delete <type> <account-id>')
    .description('permanently delete an upstream account')
    .option('--yes', 'confirm the destructive operation')
    .action(async (type, accountId, options, command) => {
      if (!options.yes) {
        throw new Error('Refusing to delete the account without --yes')
      }
      await execute(command, async (client) => await client.deleteAccount(type, accountId))
    })

  const stats = program.command('stats').description('query CRS usage statistics')

  stats
    .command('summary')
    .description('get the CRS dashboard summary')
    .action(async (_options, command) => {
      await execute(command, async (client) => await client.getUsageSummary())
    })

  stats
    .command('api-key <key-id>')
    .description('get model statistics for one relay API key')
    .option('--days <number>', 'number of days', (value) => parsePositiveInteger(value, 'days'))
    .action(async (keyId, options, command) => {
      await execute(
        command,
        async (client) =>
          await client.getApiKeyStats(keyId, options.days ? { days: options.days } : {})
      )
    })

  stats
    .command('account <type> <account-id>')
    .description('get usage history for one upstream account')
    .option('--days <number>', 'number of days', (value) => parsePositiveInteger(value, 'days'), 30)
    .action(async (type, accountId, options, command) => {
      await execute(
        command,
        async (client) => await client.getAccountStats(type, accountId, options.days)
      )
    })

  return program
}

async function run(argv = process.argv, dependencies = {}) {
  const stderr = dependencies.stderr || process.stderr
  const setExitCode =
    dependencies.setExitCode ||
    ((code) => {
      process.exitCode = code
    })
  const program = createProgram(dependencies)
  program.exitOverride()

  try {
    await program.parseAsync(argv)
    return 0
  } catch (error) {
    if (['commander.helpDisplayed', 'commander.version'].includes(error.code)) {
      return 0
    }
    writeJson(stderr, {
      success: false,
      error: redactSecretText(error.message),
      status: error.status || null
    })
    setExitCode(1)
    return 1
  }
}

module.exports = {
  createProgram,
  defaultConfigPath,
  limitKnownCollection,
  maskManagementKey,
  parseBoolean,
  parseCsv,
  parsePositiveInteger,
  readJsonPayload,
  readStoredConfig,
  redactSecretText,
  resolveConfigPath,
  resolveConnectionConfig,
  run,
  saveConnectionConfig,
  validateConnectionConfig
}
