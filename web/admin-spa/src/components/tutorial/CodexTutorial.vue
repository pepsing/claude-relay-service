<template>
  <div class="tutorial-section">
    <!-- 第一步：安装 Codex CLI -->
    <div class="mb-4 sm:mb-10 sm:mb-6">
      <h4
        class="mb-3 flex items-center text-lg font-semibold text-gray-800 dark:text-gray-300 sm:mb-4 sm:text-xl"
      >
        <span
          class="mr-2 flex h-6 w-6 items-center justify-center rounded-full bg-green-500 text-xs font-bold text-white sm:mr-3 sm:h-8 sm:w-8 sm:text-sm"
          >1</span
        >
        安装 Codex CLI
      </h4>
      <div
        class="rounded-xl border border-green-100 bg-gradient-to-r from-green-50 to-emerald-50 p-4 dark:border-green-500/40 dark:from-green-950/30 dark:to-emerald-950/30 sm:p-6"
      >
        <p class="mb-3 text-sm text-gray-700 dark:text-gray-300 sm:mb-4 sm:text-base">
          {{ platform === 'windows' ? 'Windows 建议在 WSL2 终端中运行' : '打开终端运行' }}：
        </p>
        <TutorialCodeBlock :code="installCommand" :label="shellLabel" :language="shellLanguage" />
        <p class="mt-3 text-sm text-gray-600 dark:text-gray-400">
          安装后可运行 <code>codex --version</code> 验证。
        </p>
      </div>
    </div>

    <!-- 第二步：配置 Codex -->
    <div class="mb-4 sm:mb-10 sm:mb-6">
      <h4
        class="mb-3 flex items-center text-lg font-semibold text-gray-800 dark:text-gray-300 sm:mb-4 sm:text-xl"
      >
        <span
          class="mr-2 flex h-6 w-6 items-center justify-center rounded-full bg-indigo-500 text-xs font-bold text-white sm:mr-3 sm:h-8 sm:w-8 sm:text-sm"
          >2</span
        >
        配置 Codex
      </h4>
      <p class="mb-3 text-sm text-gray-700 dark:text-gray-300 sm:mb-4 sm:text-base">
        使用 Codex 官方 config.toml 自定义 provider，连接到中转服务：
      </p>

      <div class="space-y-4">
        <div
          class="rounded-lg border border-yellow-200 bg-yellow-50 p-3 dark:border-yellow-500/40 dark:bg-yellow-950/30 sm:p-4"
        >
          <h6 class="mb-2 font-medium text-yellow-800 dark:text-yellow-300">
            1. 配置文件 config.toml
          </h6>
          <p class="mb-3 text-sm text-yellow-700 dark:text-yellow-300">
            在
            <code class="rounded bg-yellow-100 px-1 dark:bg-yellow-900">{{ configPath }}</code>
            文件开头添加以下配置：
          </p>
          <TutorialCodeBlock :code="configToml" label="config.toml" language="toml" />
          <p class="mt-3 text-sm text-yellow-600 dark:text-yellow-400">一键写入命令：</p>
          <TutorialCodeBlock
            class="mt-2"
            :code="configTomlWriteCommand"
            :label="shellLabel"
            :language="shellLanguage"
          />
        </div>

        <div
          class="rounded-lg border border-orange-200 bg-orange-50 p-3 dark:border-orange-500/40 dark:bg-orange-950/30 sm:p-4"
        >
          <h6 class="mb-2 font-medium text-orange-800 dark:text-orange-300">2. 设置 API Key</h6>
          <p class="mb-3 text-sm text-orange-700 dark:text-orange-300">
            config.toml 中的
            <code class="rounded bg-orange-100 px-1 dark:bg-orange-900">env_key</code>
            会从本地环境变量读取 API Key：
          </p>
          <TutorialCodeBlock
            :code="apiKeyEnvCommand"
            :label="shellLabel"
            :language="shellLanguage"
          />
          <p class="mt-3 text-sm text-orange-700 dark:text-orange-300">
            需要长期生效时，可以写入用户级环境变量：
          </p>
          <TutorialCodeBlock
            class="mt-2"
            :code="apiKeyPermanentCommand"
            :label="shellLabel"
            :language="shellLanguage"
          />
        </div>

        <div
          class="rounded-lg border border-blue-200 bg-blue-50 p-3 dark:border-blue-500/40 dark:bg-blue-950/30 sm:p-4"
        >
          <h6 class="mb-2 font-medium text-blue-800 dark:text-blue-300">3. 启动 Codex</h6>
          <TutorialCodeBlock code="codex" :label="shellLabel" :language="shellLanguage" />
          <p class="mt-3 text-sm text-blue-700 dark:text-blue-300">
            首次启动如果提示登录，请确认
            <code class="rounded bg-blue-100 px-1 dark:bg-blue-900">OPENAI_API_KEY</code>
            已在当前终端生效，并且 config.toml 中的
            <code class="rounded bg-blue-100 px-1 dark:bg-blue-900">model_provider</code>
            指向 <code class="rounded bg-blue-100 px-1 dark:bg-blue-900">crs</code>。
          </p>
        </div>

        <div
          class="rounded-lg border border-yellow-200 bg-yellow-50 p-3 dark:border-yellow-500/40 dark:bg-yellow-950/30 sm:p-4"
        >
          <p class="text-sm text-yellow-700 dark:text-yellow-300">
            {{
              apiKeyForExamples
                ? '示例已带入统计查询页中的 API Key，可按需替换。'
                : '请将示例中的 API Key 替换为实际 API Key。'
            }}
          </p>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue'
import { useTutorialUrls } from '@/utils/useTutorialUrls'
import TutorialCodeBlock from './TutorialCodeBlock.vue'

const props = defineProps({
  platform: {
    type: String,
    required: true,
    validator: (value) => ['windows', 'macos', 'linux'].includes(value)
  },
  apiKey: {
    type: String,
    default: ''
  },
  statsData: {
    type: Object,
    default: null
  }
})

const { openaiBaseUrl } = useTutorialUrls()

const shellLanguage = computed(() => (props.platform === 'windows' ? 'powershell' : 'bash'))
const shellLabel = computed(() => (props.platform === 'windows' ? 'PowerShell' : 'Shell'))

const configPath = computed(() =>
  props.platform === 'windows' ? '%USERPROFILE%\\.codex\\config.toml' : '~/.codex/config.toml'
)
const apiKeyForExamples = computed(() => props.apiKey.trim())
const apiKeyValue = computed(() => apiKeyForExamples.value || '后台创建的API密钥')

const installCommandLines = computed(() => {
  if (props.platform === 'windows') {
    return [
      '# WSL2 终端中执行',
      'curl -fsSL https://chatgpt.com/codex/install.sh | sh',
      '# Windows 原生安装请按 OpenAI 官方 Windows 指南执行'
    ]
  }
  return ['curl -fsSL https://chatgpt.com/codex/install.sh | sh']
})
const installCommand = computed(() => installCommandLines.value.join('\n'))

const configTomlLines = computed(() => [
  'model = "gpt-5.5"',
  'model_provider = "crs"',
  'model_reasoning_effort = "high"',
  '',
  '[model_providers.crs]',
  'name = "crs"',
  `base_url = "${openaiBaseUrl.value}"`,
  'wire_api = "responses"',
  'env_key = "OPENAI_API_KEY"'
])
const configToml = computed(() => configTomlLines.value.join('\n'))

const configTomlWriteLines = computed(() => {
  if (props.platform === 'windows') {
    return [
      'New-Item -ItemType Directory -Force -Path "$env:USERPROFILE\\.codex" | Out-Null',
      "@'",
      ...configTomlLines.value,
      '\'@ | Set-Content -Path "$env:USERPROFILE\\.codex\\config.toml" -Encoding UTF8'
    ]
  }
  return [
    'mkdir -p ~/.codex',
    "cat > ~/.codex/config.toml <<'TOML'",
    ...configTomlLines.value,
    'TOML'
  ]
})
const configTomlWriteCommand = computed(() => configTomlWriteLines.value.join('\n'))

const apiKeyEnvLines = computed(() => {
  if (props.platform === 'windows') {
    return [`$env:OPENAI_API_KEY = "${apiKeyValue.value}"`]
  }
  return [`export OPENAI_API_KEY="${apiKeyValue.value}"`]
})
const apiKeyEnvCommand = computed(() => apiKeyEnvLines.value.join('\n'))

const apiKeyPermanentLines = computed(() => {
  if (props.platform === 'windows') {
    return [
      `[System.Environment]::SetEnvironmentVariable("OPENAI_API_KEY", "${apiKeyValue.value}", [System.EnvironmentVariableTarget]::User)`
    ]
  }
  return [
    `echo 'export OPENAI_API_KEY="${apiKeyValue.value}"' >> ${
      props.platform === 'macos' ? '~/.zshrc' : '~/.bashrc'
    }`
  ]
})
const apiKeyPermanentCommand = computed(() => apiKeyPermanentLines.value.join('\n'))
</script>
