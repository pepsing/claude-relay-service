const {
  normalizeAccountStickySessionMode,
  normalizeDefaultStickySessionMode,
  resolveStickySessionMode
} = require('../src/utils/stickySessionPolicy')

describe('stickySessionPolicy', () => {
  test('normalizes missing and invalid account modes to inherit', () => {
    expect(normalizeAccountStickySessionMode()).toBe('inherit')
    expect(normalizeAccountStickySessionMode('invalid')).toBe('inherit')
    expect(normalizeAccountStickySessionMode(' FALLBACK ')).toBe('fallback')
  })

  test('keeps fallback as the backward-compatible default', () => {
    expect(normalizeDefaultStickySessionMode()).toBe('fallback')
    expect(normalizeDefaultStickySessionMode('invalid')).toBe('fallback')
  })

  test('global disable overrides every account setting', () => {
    expect(
      resolveStickySessionMode(
        { stickySessionMode: 'fallback' },
        { stickySessionEnabled: false, stickySessionDefaultMode: 'fallback' }
      )
    ).toBe('off')
  })

  test('account mode overrides the global default while inherit follows it', () => {
    const globalConfig = {
      stickySessionEnabled: true,
      stickySessionDefaultMode: 'off'
    }

    expect(resolveStickySessionMode({ stickySessionMode: 'inherit' }, globalConfig)).toBe('off')
    expect(resolveStickySessionMode({ stickySessionMode: 'fallback' }, globalConfig)).toBe(
      'fallback'
    )
    expect(
      resolveStickySessionMode(
        { stickySessionMode: 'off' },
        { ...globalConfig, stickySessionDefaultMode: 'fallback' }
      )
    ).toBe('off')
  })
})
