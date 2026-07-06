const {
  CLAUDE_MODELS,
  OPENAI_MODELS,
  getDefaultModelEndpointConfigs,
  isDeprecatedClaudeUiModel,
  isHiddenDefaultUiModel,
  isImplicitProviderUiShortcut
} = require('../config/models')

describe('models config', () => {
  it('places the latest Claude 5 models first', () => {
    expect(CLAUDE_MODELS.slice(0, 2)).toEqual([
      {
        value: 'claude-sonnet-5',
        label: 'claude-sonnet-5'
      },
      {
        value: 'claude-fable-5',
        label: 'claude-fable-5'
      }
    ])
  })

  it('keeps claude-opus-4-8 in the current Claude model options', () => {
    expect(CLAUDE_MODELS[2]).toEqual({
      value: 'claude-opus-4-8',
      label: 'claude-opus-4-8'
    })
  })

  it('includes configurable endpoint defaults for current model ids', () => {
    const endpointConfigs = getDefaultModelEndpointConfigs()

    expect(OPENAI_MODELS[0]).toEqual({
      value: 'gpt-5.5',
      label: 'gpt-5.5'
    })
    expect(endpointConfigs.claude.mappingPresets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ from: 'claude-sonnet-5', to: 'claude-sonnet-5' }),
        expect.objectContaining({ from: 'claude-fable-5', to: 'claude-fable-5' }),
        expect.objectContaining({ from: 'claude-opus-4-8', to: 'claude-opus-4-8' })
      ])
    )
  })

  it('removes deprecated Claude models from UI defaults', () => {
    const endpointConfigs = getDefaultModelEndpointConfigs()
    const claudeValues = endpointConfigs.claude.whitelistModels.map((model) => model.value)
    const bedrockValues = endpointConfigs.bedrock.whitelistModels.map((model) => model.value)
    const mappingValues = endpointConfigs.claude.mappingPresets.flatMap((preset) => [
      preset.from,
      preset.to
    ])

    expect(claudeValues).toEqual(
      expect.arrayContaining([
        'claude-sonnet-5',
        'claude-fable-5',
        'claude-opus-4-8',
        'claude-sonnet-4-6',
        'claude-haiku-4-5-20251001',
        'claude-opus-4-6'
      ])
    )
    expect([...claudeValues, ...bedrockValues, ...mappingValues]).toEqual(
      expect.not.arrayContaining([
        'claude-3-5-haiku-20241022',
        'claude-haiku-4-5',
        'claude-sonnet-4-5-20250929',
        'claude-sonnet-4-20250514',
        'claude-opus-4-5-20251101',
        'claude-opus-4-1-20250805',
        'claude-opus-4-20250514'
      ])
    )
  })

  it('does not actively show implicit provider shortcuts in UI defaults', () => {
    const endpointConfigs = getDefaultModelEndpointConfigs()
    const claudeValues = endpointConfigs.claude.whitelistModels.map((model) => model.value)
    const droidValues = endpointConfigs.droid.whitelistModels.map((model) => model.value)
    const ccrValues = endpointConfigs.ccr.whitelistModels.map((model) => model.value)
    const mappingValues = endpointConfigs.claude.mappingPresets.flatMap((preset) => [
      preset.from,
      preset.to
    ])
    const implicitShortcuts = ['Qwen', 'Kimi', 'GLM', 'deepseek-chat']

    expect([...claudeValues, ...droidValues, ...ccrValues, ...mappingValues]).toEqual(
      expect.not.arrayContaining(implicitShortcuts)
    )
    implicitShortcuts.forEach((model) => {
      expect(isImplicitProviderUiShortcut(model)).toBe(true)
      expect(isHiddenDefaultUiModel(model)).toBe(true)
      expect(isDeprecatedClaudeUiModel(model)).toBe(false)
    })
  })

  it('recognizes deprecated Claude UI model ids from saved configs', () => {
    expect(isDeprecatedClaudeUiModel('claude-3-5-haiku-20241022')).toBe(true)
    expect(isDeprecatedClaudeUiModel('claude-sonnet-4-5-20250929')).toBe(true)
    expect(isDeprecatedClaudeUiModel('us.anthropic.claude-sonnet-4-20250514-v1:0')).toBe(true)
    expect(isDeprecatedClaudeUiModel('claude-opus-4-5-20251101')).toBe(true)
    expect(isDeprecatedClaudeUiModel('claude-opus-4-1-20250805')).toBe(true)
    expect(isDeprecatedClaudeUiModel('claude-haiku-4-5')).toBe(true)
    expect(isDeprecatedClaudeUiModel('sonnet')).toBe(true)
    expect(isDeprecatedClaudeUiModel('opus')).toBe(true)
    expect(isDeprecatedClaudeUiModel('haiku')).toBe(true)
    expect(isDeprecatedClaudeUiModel('codex')).toBe(true)
    expect(isDeprecatedClaudeUiModel('claude-sonnet')).toBe(true)
    expect(isDeprecatedClaudeUiModel('claude-opus')).toBe(true)
    expect(isDeprecatedClaudeUiModel('claude-haiku')).toBe(true)
    expect(isDeprecatedClaudeUiModel('claude-sonnet-5')).toBe(false)
    expect(isDeprecatedClaudeUiModel('claude-fable-5')).toBe(false)
    expect(isDeprecatedClaudeUiModel('claude-sonnet-4-6')).toBe(false)
    expect(isDeprecatedClaudeUiModel('claude-opus-4-6')).toBe(false)
    expect(isDeprecatedClaudeUiModel('anthropic.claude-haiku-4-5-20251001-v1:0')).toBe(false)
  })
})
