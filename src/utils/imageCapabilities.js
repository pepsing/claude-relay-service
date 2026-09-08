const enabled = (value) => value === true || value === 'true'

// Existing image accounts remain synchronous; async must be explicitly enabled.
function getImageCapabilities(account = {}) {
  return {
    supportsImagesSync:
      account.supportsImagesSync === undefined || account.supportsImagesSync === null
        ? true
        : enabled(account.supportsImagesSync),
    supportsImagesAsync: enabled(account.supportsImagesAsync)
  }
}

function supportsImageRequest(account, async = false) {
  if (!enabled(account?.supportsImagesGenerations)) {
    return false
  }
  const capabilities = getImageCapabilities(account)
  return async ? capabilities.supportsImagesAsync : capabilities.supportsImagesSync
}

function imageCapabilityDescription(async) {
  return async === undefined
    ? '/v1/images/generations'
    : `${async ? 'asynchronous' : 'synchronous'} image generation and editing`
}

module.exports = { getImageCapabilities, supportsImageRequest, imageCapabilityDescription }
