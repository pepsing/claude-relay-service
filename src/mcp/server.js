const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js')
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js')
const z = require('zod')
const { CrsClient } = require('./crsClient')

function toolResult(data) {
  const structuredContent =
    data && typeof data === 'object' && !Array.isArray(data) ? data : { data }
  return {
    content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
    structuredContent
  }
}

function toolError(error) {
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(
          {
            error: error.message,
            status: error.status || null,
            details: error.data || null
          },
          null,
          2
        )
      }
    ],
    isError: true
  }
}

function registerTool(server, name, definition, handler) {
  server.registerTool(name, definition, async (args) => {
    try {
      return toolResult(await handler(args))
    } catch (error) {
      return toolError(error)
    }
  })
}

async function createServer(options = {}) {
  const client =
    options.client ||
    new CrsClient({
      baseUrl: options.baseUrl || process.env.CRS_BASE_URL,
      managementKey: options.managementKey || process.env.CRS_MANAGEMENT_KEY,
      timeoutMs: Number(options.timeoutMs || process.env.CRS_MCP_TIMEOUT_MS || 30000)
    })
  const accountTypes = client.getAccountTypes()
  const accountTypeSchema = z.enum(accountTypes)
  const jsonObjectSchema = z.record(z.string(), z.unknown())
  const apiKeyPayloadSchema = z
    .object({
      name: z.string().min(1).describe('API key display name'),
      description: z.string().optional(),
      permissions: z.array(z.enum(['claude', 'gemini', 'openai', 'droid'])).optional(),
      expiresAt: z.string().optional(),
      concurrencyLimit: z.number().int().nonnegative().optional(),
      rateLimitWindow: z.number().int().positive().optional(),
      rateLimitRequests: z.number().int().positive().optional(),
      rateLimitCost: z.number().nonnegative().optional(),
      dailyCostLimit: z.number().nonnegative().optional(),
      totalCostLimit: z.number().nonnegative().optional()
    })
    .passthrough()

  const server = new McpServer({
    name: 'crs-management',
    version: '1.1.0'
  })

  registerTool(
    server,
    'crs_get_capabilities',
    {
      title: 'Get CRS management API capabilities',
      description:
        'Get the management API version, pagination limits, current key scopes, and supported operations.',
      inputSchema: {},
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true
      }
    },
    async () => await client.getCapabilities()
  )

  registerTool(
    server,
    'crs_list_api_keys',
    {
      title: 'List CRS relay API keys',
      description:
        'List relay API keys and their metadata. Secrets are masked; use crs_reveal_api_key for a specific plaintext key.',
      inputSchema: {
        page: z.number().int().positive().optional(),
        pageSize: z.number().int().min(1).max(100).optional(),
        search: z.string().optional(),
        isActive: z.boolean().optional(),
        sortBy: z
          .enum(['name', 'createdAt', 'expiresAt', 'lastUsedAt', 'isActive', 'cost'])
          .optional(),
        sortOrder: z.enum(['asc', 'desc']).optional()
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true
      }
    },
    async (args) => await client.listApiKeys(args)
  )

  registerTool(
    server,
    'crs_create_api_key',
    {
      title: 'Create a CRS relay API key',
      description:
        'Create a relay API key. The result contains the full plaintext cr_ key and must be handled as a secret.',
      inputSchema: {
        key: apiKeyPayloadSchema
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true
      }
    },
    async ({ key }) => await client.createApiKey(key)
  )

  registerTool(
    server,
    'crs_update_api_key',
    {
      title: 'Update a CRS relay API key',
      description: 'Update relay API key metadata, permissions, limits, bindings, or active state.',
      inputSchema: {
        keyId: z.string().min(1),
        updates: jsonObjectSchema
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true
      }
    },
    async ({ keyId, updates }) => await client.updateApiKey(keyId, updates)
  )

  registerTool(
    server,
    'crs_reveal_api_key',
    {
      title: 'Reveal a CRS relay API key',
      description:
        'Return the full plaintext cr_ key for one relay key. This action is security-sensitive and audited by CRS.',
      inputSchema: {
        keyId: z.string().min(1)
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true
      }
    },
    async ({ keyId }) => await client.revealApiKey(keyId)
  )

  registerTool(
    server,
    'crs_disable_api_key',
    {
      title: 'Disable a CRS relay API key',
      description: 'Disable a relay API key without permanently deleting its usage history.',
      inputSchema: {
        keyId: z.string().min(1)
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true
      }
    },
    async ({ keyId }) => await client.disableApiKey(keyId)
  )

  registerTool(
    server,
    'crs_delete_api_key',
    {
      title: 'Delete a CRS relay API key',
      description:
        'Soft-delete a relay API key. The key stops authenticating while existing usage history is retained.',
      inputSchema: {
        keyId: z.string().min(1)
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true
      }
    },
    async ({ keyId }) => await client.deleteApiKey(keyId)
  )

  registerTool(
    server,
    'crs_list_account_types',
    {
      title: 'List supported CRS account types',
      description: 'List account type identifiers accepted by the CRS account tools.',
      inputSchema: {},
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    async () => ({ success: true, data: accountTypes })
  )

  registerTool(
    server,
    'crs_list_accounts',
    {
      title: 'List CRS upstream accounts',
      description:
        'List upstream accounts. Omit accountType to query every supported account type.',
      inputSchema: {
        accountType: accountTypeSchema.optional(),
        page: z.number().int().positive().optional(),
        pageSize: z.number().int().min(1).max(100).optional(),
        search: z.string().optional(),
        status: z.string().optional(),
        isActive: z.boolean().optional(),
        sortBy: z
          .enum(['name', 'createdAt', 'updatedAt', 'lastUsedAt', 'priority', 'status'])
          .optional(),
        sortOrder: z.enum(['asc', 'desc']).optional()
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true
      }
    },
    async ({ accountType, ...params }) => await client.listAccounts(accountType, params)
  )

  registerTool(
    server,
    'crs_create_account',
    {
      title: 'Create a CRS upstream account',
      description:
        'Create an upstream account. The account object must match the selected CRS provider payload.',
      inputSchema: {
        accountType: accountTypeSchema,
        account: jsonObjectSchema
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true
      }
    },
    async ({ accountType, account }) => await client.createAccount(accountType, account)
  )

  registerTool(
    server,
    'crs_update_account',
    {
      title: 'Update a CRS upstream account',
      description: 'Update an existing upstream account.',
      inputSchema: {
        accountType: accountTypeSchema,
        accountId: z.string().min(1),
        updates: jsonObjectSchema
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true
      }
    },
    async ({ accountType, accountId, updates }) =>
      await client.updateAccount(accountType, accountId, updates)
  )

  registerTool(
    server,
    'crs_test_account',
    {
      title: 'Test a CRS upstream account',
      description: 'Run the existing CRS connectivity or health test for an upstream account.',
      inputSchema: {
        accountType: accountTypeSchema,
        accountId: z.string().min(1)
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true
      }
    },
    async ({ accountType, accountId }) => await client.testAccount(accountType, accountId)
  )

  registerTool(
    server,
    'crs_refresh_account',
    {
      title: 'Refresh a CRS upstream account',
      description:
        'Refresh credentials or profile state for account types that expose a refresh endpoint.',
      inputSchema: {
        accountType: accountTypeSchema,
        accountId: z.string().min(1)
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true
      }
    },
    async ({ accountType, accountId }) => await client.refreshAccount(accountType, accountId)
  )

  registerTool(
    server,
    'crs_delete_account',
    {
      title: 'Delete a CRS upstream account',
      description: 'Permanently delete an upstream account from CRS.',
      inputSchema: {
        accountType: accountTypeSchema,
        accountId: z.string().min(1)
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true
      }
    },
    async ({ accountType, accountId }) => await client.deleteAccount(accountType, accountId)
  )

  registerTool(
    server,
    'crs_get_usage_summary',
    {
      title: 'Get CRS usage summary',
      description: 'Get the CRS dashboard summary, including usage and account health totals.',
      inputSchema: {},
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true
      }
    },
    async () => await client.getUsageSummary()
  )

  registerTool(
    server,
    'crs_get_api_key_stats',
    {
      title: 'Get relay API key statistics',
      description: 'Get model usage statistics for one relay API key.',
      inputSchema: {
        keyId: z.string().min(1),
        period: z.enum(['daily', 'monthly', 'all', 'custom']).optional(),
        startDate: z.string().optional(),
        endDate: z.string().optional()
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true
      }
    },
    async ({ keyId, ...params }) => await client.getApiKeyStats(keyId, params)
  )

  registerTool(
    server,
    'crs_get_account_stats',
    {
      title: 'Get upstream account statistics',
      description:
        'Get recent usage history for one upstream account. Azure OpenAI and CCR do not expose this CRS endpoint yet.',
      inputSchema: {
        accountType: accountTypeSchema,
        accountId: z.string().min(1),
        days: z.number().int().min(1).max(365).optional()
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true
      }
    },
    async ({ accountType, accountId, days }) =>
      await client.getAccountStats(accountType, accountId, days)
  )

  return server
}

async function main() {
  try {
    const server = await createServer()
    const transport = new StdioServerTransport()
    await server.connect(transport)
    process.stderr.write('CRS Management MCP server connected over stdio\n')
  } catch (error) {
    process.stderr.write(`Failed to start CRS Management MCP server: ${error.message}\n`)
    process.exitCode = 1
  }
}

if (require.main === module) {
  main()
}

module.exports = {
  createServer,
  main,
  toolResult,
  toolError
}
