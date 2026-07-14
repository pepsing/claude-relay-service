const ACCOUNT_STICKY_SESSION_MODES = ['inherit', 'off', 'fallback']
const DEFAULT_STICKY_SESSION_MODES = ['off', 'fallback']

function normalizeAccountStickySessionMode(value) {
  const normalized = String(value || '')
    .trim()
    .toLowerCase()
  return ACCOUNT_STICKY_SESSION_MODES.includes(normalized) ? normalized : 'inherit'
}

function normalizeDefaultStickySessionMode(value) {
  const normalized = String(value || '')
    .trim()
    .toLowerCase()
  return DEFAULT_STICKY_SESSION_MODES.includes(normalized) ? normalized : 'fallback'
}

function resolveStickySessionMode(account, globalConfig = {}) {
  if (globalConfig.stickySessionEnabled === false) {
    return 'off'
  }

  const accountMode = normalizeAccountStickySessionMode(account?.stickySessionMode)
  if (accountMode !== 'inherit') {
    return accountMode
  }

  return normalizeDefaultStickySessionMode(globalConfig.stickySessionDefaultMode)
}

module.exports = {
  ACCOUNT_STICKY_SESSION_MODES,
  DEFAULT_STICKY_SESSION_MODES,
  normalizeAccountStickySessionMode,
  normalizeDefaultStickySessionMode,
  resolveStickySessionMode
}
