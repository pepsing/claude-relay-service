jest.mock('../src/services/accountAccessService', () => ({ assertAllowed: jest.fn() }))
jest.mock('../src/services/userMessageQueueService', () => ({}))
jest.mock('../src/utils/logger', () => ({ debug: jest.fn(), info: jest.fn(), error: jest.fn() }))

describe('Bedrock authorization during SDK retries', () => {
  beforeEach(() => jest.resetModules())
  afterEach(() => jest.clearAllMocks())

  test('revocation after a retryable upstream error blocks the next network attempt', async () => {
    const access = require('../src/services/accountAccessService')
    const relay = require('../src/services/relay/bedrockRelayService')
    const { InvokeModelCommand } = require('@aws-sdk/client-bedrock-runtime')
    const denied = Object.assign(new Error('Revoked'), {
      code: 'ACCOUNT_ACCESS_DENIED',
      statusCode: 403
    })
    access.assertAllowed.mockResolvedValueOnce(undefined).mockRejectedValue(denied)
    const client = relay._getBedrockClient('us-east-1', {
      id: 'restricted-account',
      awsCredentials: { accessKeyId: 'test', secretAccessKey: 'test' }
    })
    const handle = jest.fn().mockResolvedValue({
      response: {
        statusCode: 500,
        headers: { 'content-type': 'application/json' },
        body: Buffer.from(JSON.stringify({ message: 'retry', __type: 'InternalServerException' }))
      }
    })
    client.config.requestHandler = { handle }
    await expect(
      client.send(new InvokeModelCommand({ modelId: 'test-model', body: '{}' }))
    ).rejects.toMatchObject({ code: 'ACCOUNT_ACCESS_DENIED' })
    expect(handle).toHaveBeenCalledTimes(1)
    expect(access.assertAllowed).toHaveBeenCalledTimes(2)
    client.destroy()
  })
})
