const { Client } = require('@modelcontextprotocol/sdk/client/index.js')
const { InMemoryTransport } = require('@modelcontextprotocol/sdk/inMemory.js')
const { createServer } = require('../src/mcp/server')

describe('CRS MCP server', () => {
  let server
  let protocolClient

  afterEach(async () => {
    await protocolClient?.close()
    await server?.close()
  })

  test('lists tools and executes a tool through the MCP protocol', async () => {
    const crsClient = {
      getAccountTypes: jest.fn().mockReturnValue(['claude', 'openai']),
      listApiKeys: jest.fn().mockResolvedValue({
        success: true,
        data: [{ id: 'key-1', name: 'Example' }]
      })
    }
    server = await createServer({ client: crsClient })
    protocolClient = new Client({
      name: 'crs-mcp-test-client',
      version: '1.0.0'
    })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()

    await server.connect(serverTransport)
    await protocolClient.connect(clientTransport)

    const tools = await protocolClient.listTools()
    expect(tools.tools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining([
        'crs_list_api_keys',
        'crs_create_api_key',
        'crs_reveal_api_key',
        'crs_list_accounts',
        'crs_get_usage_summary'
      ])
    )

    const result = await protocolClient.callTool({
      name: 'crs_list_api_keys',
      arguments: { page: 1, pageSize: 20 }
    })

    expect(crsClient.listApiKeys).toHaveBeenCalledWith({ page: 1, pageSize: 20 })
    expect(result.isError).not.toBe(true)
    expect(result.structuredContent).toEqual({
      success: true,
      data: [{ id: 'key-1', name: 'Example' }]
    })
  })
})
