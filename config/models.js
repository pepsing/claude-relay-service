/**
 * 模型列表配置
 * 用于前端展示和测试功能
 */

const parseClaudeUiFamilyVersion = (value, family) => {
  if (!value || typeof value !== 'string') {
    return null
  }

  const normalized = value.trim().toLowerCase()
  if (!normalized.includes(family)) {
    return null
  }

  const oldFormatMatch = normalized.match(
    new RegExp(`claude[- ](\\d+)(?:[.-](\\d{1,2}))?[- ]${family}`)
  )
  if (oldFormatMatch) {
    return {
      major: parseInt(oldFormatMatch[1], 10),
      minor: oldFormatMatch[2] ? parseInt(oldFormatMatch[2], 10) : 0
    }
  }

  const newFormatMatch = normalized.match(
    new RegExp(`${family}[- ](\\d+)(?:[.-](\\d{1,2})(?=[-.:]|$))?`)
  )
  if (newFormatMatch) {
    return {
      major: parseInt(newFormatMatch[1], 10),
      minor: newFormatMatch[2] ? parseInt(newFormatMatch[2], 10) : 0
    }
  }

  return null
}

const isBelowClaudeUiVersion = (version, minMajor, minMinor) => {
  if (!version) {
    return false
  }
  if (version.major < minMajor) {
    return true
  }
  return version.major === minMajor && version.minor < minMinor
}

const HIDDEN_UI_MODEL_ALIASES = new Set([
  'sonnet',
  'opus',
  'haiku',
  'codex',
  'claude-sonnet',
  'claude-opus',
  'claude-haiku',
  'claude-haiku-4-5'
])

const IMPLICIT_PROVIDER_UI_SHORTCUTS = new Set(['qwen', 'kimi', 'glm', 'deepseek-chat'])

const isDeprecatedClaudeUiModel = (value) => {
  const model = typeof value === 'string' ? value.trim().toLowerCase() : ''
  if (!model) {
    return false
  }

  if (HIDDEN_UI_MODEL_ALIASES.has(model)) {
    return true
  }

  if (model.includes('haiku')) {
    return isBelowClaudeUiVersion(parseClaudeUiFamilyVersion(model, 'haiku'), 4, 5)
  }

  if (model.includes('sonnet')) {
    return isBelowClaudeUiVersion(parseClaudeUiFamilyVersion(model, 'sonnet'), 4, 6)
  }

  if (model.includes('opus')) {
    return isBelowClaudeUiVersion(parseClaudeUiFamilyVersion(model, 'opus'), 4, 6)
  }

  return false
}

const isDeprecatedClaudeUiMappingPreset = (preset) =>
  isDeprecatedClaudeUiModel(preset?.from) || isDeprecatedClaudeUiModel(preset?.to)

const isImplicitProviderUiShortcut = (value) => {
  const model = typeof value === 'string' ? value.trim().toLowerCase() : ''
  return IMPLICIT_PROVIDER_UI_SHORTCUTS.has(model)
}

const isHiddenDefaultUiModel = (value) =>
  isDeprecatedClaudeUiModel(value) || isImplicitProviderUiShortcut(value)

const isHiddenDefaultUiMappingPreset = (preset) =>
  isHiddenDefaultUiModel(preset?.from) || isHiddenDefaultUiModel(preset?.to)

const CLAUDE_MODELS = [
  { value: 'claude-sonnet-5', label: 'claude-sonnet-5' },
  { value: 'claude-fable-5', label: 'claude-fable-5' },
  { value: 'claude-opus-4-8', label: 'claude-opus-4-8' },
  { value: 'claude-sonnet-4-6', label: 'claude-sonnet-4-6' },
  { value: 'claude-haiku-4-5-20251001', label: 'claude-haiku-4-5-20251001' },
  { value: 'claude-opus-4-6', label: 'claude-opus-4-6' }
]

const GEMINI_MODELS = [
  { value: 'gemini-2.5-pro', label: 'gemini-2.5-pro' },
  { value: 'gemini-2.5-flash', label: 'gemini-2.5-flash' },
  { value: 'gemini-3-pro-preview', label: 'gemini-3-pro-preview' },
  { value: 'gemini-3-flash-preview', label: 'gemini-3-flash-preview' },
  { value: 'gemini-3.1-pro-preview', label: 'gemini-3.1-pro-preview' }
]

const OPENAI_MODELS = [
  { value: 'gpt-5.6-sol', label: 'gpt-5.6-sol' },
  { value: 'gpt-5.6-terra', label: 'gpt-5.6-terra' },
  { value: 'gpt-5.6-luna', label: 'gpt-5.6-luna' },
  { value: 'gpt-5.5', label: 'gpt-5.5' },
  { value: 'gpt-5.5-pro', label: 'gpt-5.5-pro' },
  { value: 'gpt-5.4', label: 'gpt-5.4' },
  { value: 'gpt-5.4-pro', label: 'gpt-5.4-pro' },
  { value: 'gpt-5.4-mini', label: 'gpt-5.4-mini' },
  { value: 'gpt-5.4-nano', label: 'gpt-5.4-nano' },
  { value: 'gpt-5', label: 'gpt-5' },
  { value: 'gpt-5-mini', label: 'gpt-5-mini' },
  { value: 'gpt-5-nano', label: 'gpt-5-nano' },
  { value: 'gpt-5.1', label: 'gpt-5.1' },
  { value: 'gpt-5.1-codex', label: 'gpt-5.1-codex' },
  { value: 'gpt-5.1-codex-max', label: 'gpt-5.1-codex-max' },
  { value: 'gpt-5.1-codex-mini', label: 'gpt-5.1-codex-mini' },
  { value: 'gpt-5.2', label: 'gpt-5.2' },
  { value: 'gpt-5.2-codex', label: 'gpt-5.2-codex' },
  { value: 'gpt-5.3-codex', label: 'gpt-5.3-codex' },
  { value: 'gpt-5.3-codex-spark', label: 'gpt-5.3-codex-spark' },
  { value: 'codex-mini', label: 'codex-mini' }
]

const BEDROCK_MODELS = [
  { value: 'anthropic.claude-opus-4-8', label: 'anthropic.claude-opus-4-8' },
  { value: 'anthropic.claude-sonnet-4-6', label: 'anthropic.claude-sonnet-4-6' },
  {
    value: 'anthropic.claude-haiku-4-5-20251001-v1:0',
    label: 'anthropic.claude-haiku-4-5-20251001-v1:0'
  },
  {
    value: 'us.anthropic.claude-opus-4-6-20250610-v1:0',
    label: 'us.anthropic.claude-opus-4-6-20250610-v1:0'
  }
]

// 其他完整模型（用于账户编辑的模型映射）
const OTHER_MODELS = [{ value: 'glm-5.1', label: 'glm-5.1' }]

const mergeModelOptions = (...groups) => {
  const seen = new Set()
  const merged = []

  groups.flat().forEach((model) => {
    if (!model?.value || seen.has(model.value) || isHiddenDefaultUiModel(model.value)) return
    seen.add(model.value)
    merged.push({ value: model.value, label: model.value })
  })

  return merged
}

const cloneModelOptions = (models) =>
  models
    .filter((model) => !isHiddenDefaultUiModel(model.value))
    .map((model) => ({ value: model.value, label: model.value }))

const cloneMappingPresets = (presets) =>
  presets
    .filter((preset) => !isHiddenDefaultUiMappingPreset(preset))
    .map((preset) => ({
      label: `+ ${preset.from}`,
      from: preset.from,
      to: preset.to
    }))

const CLAUDE_MAPPING_PRESETS = [
  { label: '+ claude-sonnet-5', from: 'claude-sonnet-5', to: 'claude-sonnet-5' },
  { label: '+ claude-fable-5', from: 'claude-fable-5', to: 'claude-fable-5' },
  { label: '+ claude-opus-4-8', from: 'claude-opus-4-8', to: 'claude-opus-4-8' },
  { label: '+ claude-sonnet-4-6', from: 'claude-sonnet-4-6', to: 'claude-sonnet-4-6' },
  {
    label: '+ claude-haiku-4-5-20251001',
    from: 'claude-haiku-4-5-20251001',
    to: 'claude-haiku-4-5-20251001'
  },
  { label: '+ claude-opus-4-6', from: 'claude-opus-4-6', to: 'claude-opus-4-6' },
  { label: '+ glm-5.1', from: 'glm-5.1', to: 'glm-5.1' }
]

const OPENAI_MAPPING_PRESETS = [
  { label: '+ gpt-5.6-sol', from: 'gpt-5.6-sol', to: 'gpt-5.6-sol' },
  { label: '+ gpt-5.6-terra', from: 'gpt-5.6-terra', to: 'gpt-5.6-terra' },
  { label: '+ gpt-5.6-luna', from: 'gpt-5.6-luna', to: 'gpt-5.6-luna' },
  { label: '+ gpt-5.5', from: 'gpt-5.5', to: 'gpt-5.5' },
  { label: '+ gpt-5.5-pro', from: 'gpt-5.5-pro', to: 'gpt-5.5-pro' },
  { label: '+ gpt-5.4', from: 'gpt-5.4', to: 'gpt-5.4' },
  { label: '+ gpt-5.4-mini', from: 'gpt-5.4-mini', to: 'gpt-5.4-mini' },
  { label: '+ gpt-5', from: 'gpt-5', to: 'gpt-5' },
  { label: '+ gpt-5-mini', from: 'gpt-5-mini', to: 'gpt-5-mini' },
  { label: '+ gpt-5.3-codex', from: 'gpt-5.3-codex', to: 'gpt-5.3-codex' }
]

const GEMINI_MAPPING_PRESETS = [
  {
    label: '+ gemini-3.1-pro-preview',
    from: 'gemini-3.1-pro-preview',
    to: 'gemini-3.1-pro-preview'
  },
  { label: '+ gemini-3-pro-preview', from: 'gemini-3-pro-preview', to: 'gemini-3-pro-preview' },
  { label: '+ gemini-2.5-pro', from: 'gemini-2.5-pro', to: 'gemini-2.5-pro' },
  { label: '+ gemini-2.5-flash', from: 'gemini-2.5-flash', to: 'gemini-2.5-flash' }
]

const BEDROCK_MAPPING_PRESETS = [
  {
    label: '+ anthropic.claude-opus-4-8',
    from: 'claude-opus-4-8',
    to: 'anthropic.claude-opus-4-8'
  },
  {
    label: '+ anthropic.claude-sonnet-4-6',
    from: 'claude-sonnet-4-6',
    to: 'anthropic.claude-sonnet-4-6'
  },
  {
    label: '+ anthropic.claude-haiku-4-5-20251001-v1:0',
    from: 'claude-haiku-4-5-20251001',
    to: 'anthropic.claude-haiku-4-5-20251001-v1:0'
  }
]

const MODEL_ENDPOINT_CONFIGS = {
  claude: {
    label: 'Claude',
    whitelistModels: mergeModelOptions(CLAUDE_MODELS, OTHER_MODELS),
    mappingPresets: CLAUDE_MAPPING_PRESETS
  },
  openai: {
    label: 'OpenAI Chat',
    whitelistModels: cloneModelOptions(OPENAI_MODELS),
    mappingPresets: OPENAI_MAPPING_PRESETS
  },
  'openai-responses': {
    label: 'OpenAI Responses',
    whitelistModels: cloneModelOptions(OPENAI_MODELS),
    mappingPresets: OPENAI_MAPPING_PRESETS
  },
  'azure-openai': {
    label: 'Azure OpenAI',
    whitelistModels: cloneModelOptions(OPENAI_MODELS),
    mappingPresets: OPENAI_MAPPING_PRESETS
  },
  gemini: {
    label: 'Gemini',
    whitelistModels: cloneModelOptions(GEMINI_MODELS),
    mappingPresets: GEMINI_MAPPING_PRESETS
  },
  bedrock: {
    label: 'Bedrock',
    whitelistModels: cloneModelOptions(BEDROCK_MODELS),
    mappingPresets: BEDROCK_MAPPING_PRESETS
  },
  droid: {
    label: 'Droid',
    whitelistModels: mergeModelOptions(CLAUDE_MODELS, OTHER_MODELS),
    mappingPresets: CLAUDE_MAPPING_PRESETS
  },
  ccr: {
    label: 'CCR',
    whitelistModels: mergeModelOptions(CLAUDE_MODELS, OTHER_MODELS),
    mappingPresets: CLAUDE_MAPPING_PRESETS
  }
}

const getDefaultModelEndpointConfigs = () =>
  Object.fromEntries(
    Object.entries(MODEL_ENDPOINT_CONFIGS).map(([endpoint, config]) => [
      endpoint,
      {
        label: config.label,
        whitelistModels: cloneModelOptions(config.whitelistModels),
        mappingPresets: cloneMappingPresets(config.mappingPresets)
      }
    ])
  )

// 各平台测试可用模型
const PLATFORM_TEST_MODELS = {
  claude: CLAUDE_MODELS,
  'claude-console': CLAUDE_MODELS,
  bedrock: BEDROCK_MODELS,
  gemini: GEMINI_MODELS,
  'gemini-api': GEMINI_MODELS,
  'openai-responses': OPENAI_MODELS,
  'azure-openai': [],
  droid: CLAUDE_MODELS,
  ccr: CLAUDE_MODELS
}

module.exports = {
  CLAUDE_MODELS,
  GEMINI_MODELS,
  OPENAI_MODELS,
  BEDROCK_MODELS,
  OTHER_MODELS,
  PLATFORM_TEST_MODELS,
  MODEL_ENDPOINT_CONFIGS,
  getDefaultModelEndpointConfigs,
  isDeprecatedClaudeUiModel,
  isDeprecatedClaudeUiMappingPreset,
  isImplicitProviderUiShortcut,
  isHiddenDefaultUiModel,
  isHiddenDefaultUiMappingPreset,
  // 按服务分组
  getModelsByService: (service) => {
    switch (service) {
      case 'claude':
        return CLAUDE_MODELS
      case 'gemini':
        return GEMINI_MODELS
      case 'openai':
        return OPENAI_MODELS
      default:
        return []
    }
  },
  // 获取所有模型（用于账户编辑）
  getAllModels: () => mergeModelOptions(CLAUDE_MODELS, GEMINI_MODELS, OPENAI_MODELS, OTHER_MODELS)
}
