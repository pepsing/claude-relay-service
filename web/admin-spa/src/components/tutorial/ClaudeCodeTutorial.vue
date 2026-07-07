<template>
  <div class="tutorial-content">
    <!-- 第一步：安装 Claude Code -->
    <div class="mb-4 sm:mb-10 sm:mb-6">
      <h4
        class="mb-3 flex items-center text-lg font-semibold text-gray-800 dark:text-gray-300 sm:mb-4 sm:text-xl"
      >
        <span
          class="mr-2 flex h-6 w-6 items-center justify-center rounded-full bg-green-500 text-xs font-bold text-white sm:mr-3 sm:h-8 sm:w-8 sm:text-sm"
          >1</span
        >
        安装 Claude Code
      </h4>

      <div
        class="mb-4 rounded-xl border border-green-100 bg-gradient-to-r from-green-50 to-emerald-50 p-4 dark:border-green-500/40 dark:from-green-950/30 dark:to-emerald-950/30 sm:mb-6 sm:p-6"
      >
        <h5
          class="mb-2 flex items-center text-base font-semibold text-gray-800 dark:text-gray-200 sm:mb-3 sm:text-lg"
        >
          <i class="fas fa-download mr-2 text-green-600" />
          使用官方安装器
        </h5>
        <p class="mb-3 text-sm text-gray-700 dark:text-gray-300 sm:mb-4 sm:text-base">
          {{ platform === 'windows' ? '打开 PowerShell' : '打开终端' }}，运行以下命令：
        </p>
        <TutorialCodeBlock
          class="mb-4"
          :code="installCommand"
          :label="shellLabel"
          :language="shellLanguage"
        />
        <p class="text-sm text-gray-600 dark:text-gray-400">
          Native installer 会安装官方 Claude Code CLI，并支持自动更新。
        </p>

        <div
          class="mt-4 rounded-lg border border-blue-200 bg-blue-50 p-3 dark:border-blue-500/40 dark:bg-blue-950/30 sm:p-4"
        >
          <h6 class="mb-2 text-sm font-medium text-blue-800 dark:text-blue-300 sm:text-base">
            可选安装方式
          </h6>
          <TutorialCodeBlock
            :code="alternateInstallCommand"
            :label="shellLabel"
            :language="shellLanguage"
          />
        </div>
      </div>

      <div
        class="rounded-lg border border-green-200 bg-green-50 p-3 dark:border-green-500/40 dark:bg-green-950/30 sm:p-4"
      >
        <h6 class="mb-2 font-medium text-green-800 dark:text-green-300">验证 Claude Code 安装</h6>
        <TutorialCodeBlock code="claude --version" :label="shellLabel" :language="shellLanguage" />
      </div>
    </div>

    <!-- 第二步：settings.json 配置 -->
    <div class="mb-6 sm:mb-10">
      <h4
        class="mb-3 flex items-center text-lg font-semibold text-gray-800 dark:text-gray-300 sm:mb-4 sm:text-xl"
      >
        <span
          class="mr-2 flex h-6 w-6 items-center justify-center rounded-full bg-purple-500 text-xs font-bold text-white sm:mr-3 sm:h-8 sm:w-8 sm:text-sm"
          >2</span
        >
        配置 settings.json
      </h4>

      <div
        class="mb-4 rounded-xl border border-purple-100 bg-gradient-to-r from-purple-50 to-pink-50 p-4 dark:border-purple-500/40 dark:from-purple-950/30 dark:to-pink-950/30 sm:mb-6 sm:p-6"
      >
        <h5
          class="mb-2 flex items-center text-base font-semibold text-gray-800 dark:text-gray-200 sm:mb-3 sm:text-lg"
        >
          <i class="fas fa-cog mr-2 text-purple-600" />
          推荐：写入用户级 settings.json
        </h5>
        <p class="mb-3 text-sm text-gray-700 dark:text-gray-300 sm:mb-4 sm:text-base">
          用户级配置文件：
          <code class="rounded bg-purple-100 px-1 dark:bg-purple-900">{{ settingsPath }}</code>
        </p>

        <TutorialCodeBlock
          class="mb-4"
          :code="settingsJson"
          label="settings.json"
          language="json"
        />

        <p class="mb-3 text-sm text-gray-700 dark:text-gray-300">一键写入命令：</p>
        <TutorialCodeBlock
          :code="settingsWriteCommand"
          :label="shellLabel"
          :language="shellLanguage"
        />

        <div
          class="mt-4 rounded-lg border border-yellow-200 bg-yellow-50 p-3 text-sm text-yellow-800 dark:border-yellow-500/40 dark:bg-yellow-950/30 dark:text-yellow-300"
        >
          {{
            apiKeyForExamples
              ? '示例已带入统计查询页中的 API Key。'
              : '将示例中的 API Key 替换为在 API Keys 页面创建的实际密钥。'
          }}
          中转服务使用 Bearer token 时保持
          <code class="rounded bg-yellow-100 px-1 dark:bg-yellow-900">ANTHROPIC_AUTH_TOKEN</code>
          ；只有网关要求 x-api-key 时才改用
          <code class="rounded bg-yellow-100 px-1 dark:bg-yellow-900">ANTHROPIC_API_KEY</code>。
        </div>
      </div>
    </div>

    <div class="mb-6 sm:mb-10">
      <div
        class="rounded-xl border border-cyan-100 bg-gradient-to-r from-cyan-50 to-sky-50 p-4 dark:border-cyan-500/40 dark:from-cyan-950/30 dark:to-sky-950/30 sm:p-6"
      >
        <div class="mb-4 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <h5
              class="mb-2 flex items-center text-base font-semibold text-gray-800 dark:text-gray-200 sm:text-lg"
            >
              <i class="fas fa-external-link-alt mr-2 text-cyan-600" />
              CC Switch 一键导入
            </h5>
            <p class="text-sm text-gray-700 dark:text-gray-300">
              生成
              <code class="rounded bg-cyan-100 px-1 dark:bg-cyan-900">ccswitch://</code>
              深度链接，把当前中转服务作为 Claude provider 导入 CC Switch。
            </p>
          </div>
          <span
            class="inline-flex w-fit items-center rounded-full bg-white/70 px-3 py-1 text-xs font-semibold text-cyan-700 ring-1 ring-cyan-200 dark:bg-cyan-950/60 dark:text-cyan-300 dark:ring-cyan-500/40"
          >
            provider / claude
          </span>
        </div>

        <div class="space-y-4">
          <div>
            <label
              class="mb-2 block text-sm font-medium text-gray-700 dark:text-gray-300"
              for="cc-switch-api-key"
            >
              API Key{{ apiKeyForExamples ? '（已带入，可修改）' : '（可选）' }}
            </label>
            <input
              id="cc-switch-api-key"
              v-model="ccSwitchApiKey"
              autocomplete="off"
              class="w-full rounded-lg border border-cyan-200 bg-white px-3 py-2 text-sm text-gray-900 outline-none transition-colors placeholder:text-gray-400 focus:border-cyan-500 focus:ring-2 focus:ring-cyan-500/20 dark:border-cyan-700 dark:bg-gray-900 dark:text-gray-100 dark:placeholder:text-gray-500"
              placeholder="cr_xxx；不填也可以先导入 endpoint，稍后在 CC Switch 中补充"
              type="password"
            />
            <p class="mt-2 text-xs text-gray-600 dark:text-gray-400">
              API Key 只用于生成本机打开的 deeplink。填入后请不要把导入链接公开分享。
            </p>
          </div>

          <dl class="grid gap-3 text-sm sm:grid-cols-2">
            <div class="rounded-lg bg-white/70 p-3 dark:bg-gray-900/60">
              <dt class="mb-1 font-medium text-gray-500 dark:text-gray-400">Endpoint</dt>
              <dd class="break-all font-mono text-gray-900 dark:text-gray-100">
                {{ currentBaseUrl }}
              </dd>
            </div>
            <div class="rounded-lg bg-white/70 p-3 dark:bg-gray-900/60">
              <dt class="mb-2 font-medium text-gray-500 dark:text-gray-400">默认模型</dt>
              <dd>
                <select
                  id="cc-switch-model"
                  v-model="selectedCcSwitchModel"
                  class="w-full rounded-lg border border-cyan-200 bg-white px-3 py-2 font-mono text-sm text-gray-900 outline-none transition-colors focus:border-cyan-500 focus:ring-2 focus:ring-cyan-500/20 dark:border-cyan-700 dark:bg-gray-900 dark:text-gray-100"
                >
                  <option
                    v-for="model in ccSwitchClaudeModelOptions"
                    :key="model.value"
                    :value="model.value"
                  >
                    {{ model.label }}
                  </option>
                </select>
              </dd>
            </div>
          </dl>

          <div class="flex flex-col gap-2 sm:flex-row">
            <button
              class="inline-flex items-center justify-center gap-2 rounded-lg bg-cyan-600 px-4 py-2 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-cyan-700 focus:outline-none focus:ring-2 focus:ring-cyan-500 focus:ring-offset-2 dark:focus:ring-offset-gray-900"
              type="button"
              @click="openCcSwitchImport"
            >
              <i class="fas fa-bolt" />
              一键导入 CC Switch
            </button>
            <button
              class="inline-flex items-center justify-center gap-2 rounded-lg border border-cyan-200 bg-white px-4 py-2 text-sm font-semibold text-cyan-700 transition-colors hover:bg-cyan-50 dark:border-cyan-700 dark:bg-gray-900 dark:text-cyan-300 dark:hover:bg-cyan-950/50"
              type="button"
              @click="copyCcSwitchImportUrl"
            >
              <i class="fas fa-copy" />
              复制导入链接
            </button>
          </div>
        </div>
      </div>
    </div>

    <!-- 第三步：临时环境变量 -->
    <div class="mb-6 sm:mb-10">
      <h4
        class="mb-3 flex items-center text-lg font-semibold text-gray-800 dark:text-gray-300 sm:mb-4 sm:text-xl"
      >
        <span
          class="mr-2 flex h-6 w-6 items-center justify-center rounded-full bg-blue-500 text-xs font-bold text-white sm:mr-3 sm:h-8 sm:w-8 sm:text-sm"
          >3</span
        >
        可选：临时环境变量
      </h4>
      <div
        class="rounded-lg border border-blue-200 bg-blue-50 p-3 dark:border-blue-500/40 dark:bg-blue-950/30 sm:p-4"
      >
        <p class="mb-3 text-sm text-blue-700 dark:text-blue-300">
          只想在当前终端验证时，可以临时设置环境变量；正式使用仍建议写入 settings.json。
        </p>
        <TutorialCodeBlock
          :code="temporaryEnvCommand"
          :label="shellLabel"
          :language="shellLanguage"
        />
        <p class="mt-3 text-xs text-blue-700 dark:text-blue-300">
          同时存在时，settings.json 中的 env 配置优先生效。
        </p>
      </div>
    </div>

    <!-- 第四步：VS Code 扩展配置 -->
    <div class="mb-6 sm:mb-10">
      <h4
        class="mb-3 flex items-center text-lg font-semibold text-gray-800 dark:text-gray-300 sm:mb-4 sm:text-xl"
      >
        <span
          class="mr-2 flex h-6 w-6 items-center justify-center rounded-full bg-indigo-500 text-xs font-bold text-white sm:mr-3 sm:h-8 sm:w-8 sm:text-sm"
          >4</span
        >
        VS Code 扩展配置
      </h4>
      <div
        class="rounded-lg border border-indigo-200 bg-indigo-50 p-3 dark:border-indigo-500/40 dark:bg-indigo-950/30 sm:p-4"
      >
        <p class="mb-3 text-sm text-indigo-700 dark:text-indigo-300">
          使用 Claude Code VS Code 扩展时，在 VS Code 用户设置 JSON 中加入：
        </p>
        <TutorialCodeBlock :code="vscodeSettings" label="VS Code settings.json" language="json" />
      </div>
    </div>

    <!-- 第五步：开始使用 -->
    <div class="mb-6 sm:mb-8">
      <h4
        class="mb-3 flex items-center text-lg font-semibold text-gray-800 dark:text-gray-300 sm:mb-4 sm:text-xl"
      >
        <span
          class="mr-2 flex h-6 w-6 items-center justify-center rounded-full bg-orange-500 text-xs font-bold text-white sm:mr-3 sm:h-8 sm:w-8 sm:text-sm"
          >5</span
        >
        验证并启动 Claude Code
      </h4>
      <div
        class="rounded-xl border border-orange-100 bg-gradient-to-r from-orange-50 to-yellow-50 p-4 dark:border-orange-500/40 dark:from-orange-950/30 dark:to-yellow-950/30 sm:p-6"
      >
        <div class="space-y-4">
          <div>
            <h6 class="mb-2 text-sm font-medium text-gray-800 dark:text-gray-300 sm:text-base">
              启动 Claude Code
            </h6>
            <TutorialCodeBlock
              :code="statusCommand"
              :label="shellLabel"
              :language="shellLanguage"
            />
            <p class="mt-2 text-sm text-gray-700 dark:text-gray-300">
              在 /status 中确认 Anthropic base URL 指向
              <code class="rounded bg-orange-100 px-1 dark:bg-orange-900">{{
                currentBaseUrl
              }}</code>
              ，且认证来源已经生效。
            </p>
          </div>

          <div>
            <h6 class="mb-2 text-sm font-medium text-gray-800 dark:text-gray-300 sm:text-base">
              在特定项目中使用
            </h6>
            <TutorialCodeBlock
              :code="projectCommand"
              :label="shellLabel"
              :language="shellLanguage"
            />
          </div>
        </div>
      </div>
    </div>

    <!-- 故障排除 -->
    <div class="mb-8">
      <h4
        class="mb-3 flex items-center text-lg font-semibold text-gray-800 dark:text-gray-300 sm:mb-4 sm:text-xl"
      >
        <i class="fas fa-wrench mr-2 text-red-600 sm:mr-3" />
        {{ platformName }} 常见问题解决
      </h4>
      <div class="space-y-4">
        <details
          class="rounded-lg border border-gray-200 bg-gray-50 dark:border-gray-700 dark:bg-gray-800"
        >
          <summary
            class="cursor-pointer p-3 text-sm font-medium text-gray-800 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-700 sm:p-4 sm:text-base"
          >
            安装命令执行失败
          </summary>
          <div class="px-3 pb-3 text-gray-600 dark:text-gray-400 sm:px-4 sm:pb-4">
            <ul class="list-inside list-disc space-y-1 text-sm">
              <template v-if="platform === 'windows'">
                <li>确认使用 PowerShell 执行安装命令</li>
                <li>或使用 WinGet 安装：<code>winget install Anthropic.ClaudeCode</code></li>
              </template>
              <template v-else-if="platform === 'macos'">
                <li>确认网络可以访问 claude.ai</li>
                <li>或使用 Homebrew 安装：<code>brew install --cask claude-code</code></li>
              </template>
              <template v-else>
                <li>确认网络可以访问 claude.ai</li>
                <li>WSL2 用户请在 Linux 子系统终端中执行安装命令</li>
              </template>
            </ul>
          </div>
        </details>

        <details
          v-if="platform === 'windows'"
          class="rounded-lg border border-gray-200 bg-gray-50 dark:border-gray-700 dark:bg-gray-800"
        >
          <summary
            class="cursor-pointer p-3 text-sm font-medium text-gray-800 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-700 sm:p-4 sm:text-base"
          >
            PowerShell 执行策略错误
          </summary>
          <div class="px-3 pb-3 text-gray-600 dark:text-gray-400 sm:px-4 sm:pb-4">
            <p class="mb-2">如果遇到执行策略限制，运行：</p>
            <TutorialCodeBlock
              code="Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser"
              label="PowerShell"
              language="powershell"
            />
          </div>
        </details>

        <details
          class="rounded-lg border border-gray-200 bg-gray-50 dark:border-gray-700 dark:bg-gray-800"
        >
          <summary
            class="cursor-pointer p-3 text-sm font-medium text-gray-800 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-700 sm:p-4 sm:text-base"
          >
            settings.json 不生效
          </summary>
          <div class="px-3 pb-3 text-gray-600 dark:text-gray-400 sm:px-4 sm:pb-4">
            <ul class="list-inside list-disc space-y-1 text-sm">
              <li>确认 JSON 语法正确，双引号和逗号没有缺失</li>
              <li>
                确认文件路径是用户级 <code>{{ settingsPath }}</code>
              </li>
              <li>重新打开终端或重启 Claude Code 会话</li>
              <li>在 Claude Code 中运行 <code>/status</code> 查看 base URL 和认证来源</li>
            </ul>
          </div>
        </details>

        <details
          v-if="platform === 'linux'"
          class="rounded-lg border border-gray-200 bg-gray-50 dark:border-gray-700 dark:bg-gray-800"
        >
          <summary
            class="cursor-pointer p-3 text-sm font-medium text-gray-800 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-700 sm:p-4 sm:text-base"
          >
            WSL2 中无法访问 Windows 文件
          </summary>
          <div class="px-3 pb-3 text-gray-600 dark:text-gray-400 sm:px-4 sm:pb-4">
            <p class="mb-2">WSL2 可以通过 /mnt/ 路径访问 Windows 文件：</p>
            <TutorialCodeBlock
              code="cd /mnt/c/Users/你的用户名/项目目录"
              label="Shell"
              language="bash"
            />
          </div>
        </details>

        <details
          class="rounded-lg border border-gray-200 bg-gray-50 dark:border-gray-700 dark:bg-gray-800"
        >
          <summary
            class="cursor-pointer p-3 text-sm font-medium text-gray-800 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-700 sm:p-4 sm:text-base"
          >
            CC Switch 导入链接无法打开
          </summary>
          <div class="px-3 pb-3 text-gray-600 dark:text-gray-400 sm:px-4 sm:pb-4">
            <ul class="mb-3 list-inside list-disc space-y-1 text-sm">
              <li>确认本机已经安装 CC Switch</li>
              <li>确认系统已经注册 <code>ccswitch://</code> 协议</li>
              <li>复制导入链接后，也可以在浏览器地址栏手动打开</li>
            </ul>
            <template v-if="platform === 'macos'">
              <p class="mb-2 text-sm">macOS 可重新注册协议：</p>
              <TutorialCodeBlock
                code='/usr/bin/open -a "CC Switch" --args --register-protocol'
                label="Shell"
                language="bash"
              />
            </template>
            <template v-else-if="platform === 'windows'">
              <p class="text-sm">
                Windows 可重新安装 CC Switch，或检查注册表
                <code>HKEY_CLASSES_ROOT\ccswitch</code>。
              </p>
            </template>
            <template v-else>
              <p class="text-sm">
                Linux 请检查桌面文件中的 <code>MimeType</code> 是否包含 cc-switch 协议处理。
              </p>
            </template>
          </div>
        </details>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed, onMounted, ref, watch } from 'vue'
import { useTutorialUrls } from '@/utils/useTutorialUrls'
import { getModelsApi } from '@/utils/http_apis'
import { copyText } from '@/utils/tools'
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

const { currentBaseUrl } = useTutorialUrls()
const ccSwitchApiKey = ref('')
const selectedCcSwitchModel = ref('claude-sonnet-5')
const globalClaudeModelOptions = ref([])

const fallbackClaudeModelOptions = [
  { value: 'claude-sonnet-5', label: 'claude-sonnet-5' },
  { value: 'claude-fable-5', label: 'claude-fable-5' },
  { value: 'claude-opus-4-8', label: 'claude-opus-4-8' },
  { value: 'claude-sonnet-4-6', label: 'claude-sonnet-4-6' },
  { value: 'claude-haiku-4-5-20251001', label: 'claude-haiku-4-5-20251001' },
  { value: 'claude-opus-4-6', label: 'claude-opus-4-6' }
]

const platformName = computed(() => {
  const names = { windows: 'Windows', macos: 'macOS', linux: 'Linux / WSL2' }
  return names[props.platform]
})

const shellLanguage = computed(() => (props.platform === 'windows' ? 'powershell' : 'bash'))
const shellLabel = computed(() => (props.platform === 'windows' ? 'PowerShell' : 'Shell'))

const settingsPath = computed(() =>
  props.platform === 'windows' ? '%USERPROFILE%\\.claude\\settings.json' : '~/.claude/settings.json'
)
const apiKeyForExamples = computed(() => props.apiKey.trim())
const apiKeyValue = computed(() => apiKeyForExamples.value || '你的API密钥')
const normalizeModelOptions = (models) => {
  if (!Array.isArray(models)) return []

  return models
    .map((model) => {
      if (typeof model === 'string') {
        const value = model.trim()
        return value ? { value, label: value } : null
      }

      if (model && typeof model === 'object') {
        const value = String(model.value || model.id || model.model || '').trim()
        if (!value) return null
        return { value, label: String(model.label || value) }
      }

      return null
    })
    .filter(Boolean)
}

const restrictedClaudeModels = computed(() => {
  const restrictions = props.statsData?.restrictions
  if (restrictions?.enableModelRestriction !== true) return []
  return Array.isArray(restrictions.restrictedModels) ? restrictions.restrictedModels : []
})

const ccSwitchClaudeModelOptions = computed(() => {
  const keyOptions = normalizeModelOptions(props.statsData?.testModelOptions?.claude || [])
  const sourceOptions =
    keyOptions.length > 0
      ? keyOptions
      : globalClaudeModelOptions.value.length > 0
        ? globalClaudeModelOptions.value
        : fallbackClaudeModelOptions
  const restricted = new Set(restrictedClaudeModels.value)

  return sourceOptions.filter((model) => !restricted.has(model.value))
})

const findPreferredModel = (predicate) =>
  ccSwitchClaudeModelOptions.value.find((model) => predicate(model.value))?.value

const selectedSonnetModel = computed(
  () =>
    findPreferredModel(
      (model) => model === selectedCcSwitchModel.value && model.includes('sonnet')
    ) ||
    findPreferredModel((model) => model.includes('sonnet')) ||
    selectedCcSwitchModel.value
)
const selectedOpusModel = computed(
  () =>
    findPreferredModel(
      (model) => model === selectedCcSwitchModel.value && model.includes('opus')
    ) ||
    findPreferredModel((model) => model.includes('opus')) ||
    selectedCcSwitchModel.value
)
const selectedHaikuModel = computed(
  () =>
    findPreferredModel(
      (model) => model === selectedCcSwitchModel.value && model.includes('haiku')
    ) ||
    findPreferredModel((model) => model.includes('haiku')) ||
    selectedCcSwitchModel.value
)

const relayHomepage = computed(() => currentBaseUrl.value.replace(/\/api\/?$/, ''))
const ccSwitchImportUrl = computed(() => {
  const params = new URLSearchParams({
    resource: 'provider',
    app: 'claude',
    name: 'Claude Relay Service',
    endpoint: currentBaseUrl.value,
    homepage: relayHomepage.value,
    model: selectedCcSwitchModel.value,
    sonnetModel: selectedSonnetModel.value,
    opusModel: selectedOpusModel.value,
    haikuModel: selectedHaikuModel.value,
    enabled: 'true',
    notes: 'Claude Relay Service /api endpoint'
  })
  const apiKey = ccSwitchApiKey.value.trim() || apiKeyForExamples.value
  if (apiKey) {
    params.set('apiKey', apiKey)
  }
  return `ccswitch://v1/import?${params.toString()}`
})

const openCcSwitchImport = () => {
  window.location.href = ccSwitchImportUrl.value
}

const copyCcSwitchImportUrl = () => copyText(ccSwitchImportUrl.value, 'CC Switch 导入链接已复制')

const loadGlobalClaudeModels = async () => {
  const result = await getModelsApi()
  if (result.success) {
    globalClaudeModelOptions.value = normalizeModelOptions(result.data?.claude || [])
  }
}

watch(
  () => props.apiKey,
  (apiKey) => {
    const normalizedApiKey = apiKey.trim()
    if (normalizedApiKey && !ccSwitchApiKey.value.trim()) {
      ccSwitchApiKey.value = normalizedApiKey
    }
  },
  { immediate: true }
)

watch(
  ccSwitchClaudeModelOptions,
  (models) => {
    if (!models.length) return
    if (!models.some((model) => model.value === selectedCcSwitchModel.value)) {
      selectedCcSwitchModel.value = models[0].value
    }
  },
  { immediate: true }
)

onMounted(loadGlobalClaudeModels)

const installCommandLines = computed(() =>
  props.platform === 'windows'
    ? ['irm https://claude.ai/install.ps1 | iex']
    : ['curl -fsSL https://claude.ai/install.sh | bash']
)
const installCommand = computed(() => installCommandLines.value.join('\n'))

const alternateInstallLines = computed(() => {
  if (props.platform === 'windows') {
    return ['winget install Anthropic.ClaudeCode']
  }
  if (props.platform === 'macos') {
    return ['brew install --cask claude-code']
  }
  return ['# Linux / WSL2 推荐使用上面的 native installer']
})
const alternateInstallCommand = computed(() => alternateInstallLines.value.join('\n'))

const settingsJsonLines = computed(() => [
  '{',
  '  "env": {',
  `    "ANTHROPIC_BASE_URL": "${currentBaseUrl.value}",`,
  `    "ANTHROPIC_AUTH_TOKEN": "${apiKeyValue.value}",`,
  '    "ANTHROPIC_MODEL": "glm",',
  '    "API_TIMEOUT_MS": "3000000",',
  '    "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1",',
  '    "DISABLE_ERROR_REPORTING": "1",',
  '    "DISABLE_NON_ESSENTIAL_MODEL_CALLS": "1",',
  '    "DISABLE_TELEMETRY": "1"',
  '  }',
  '}'
])
const settingsJson = computed(() => settingsJsonLines.value.join('\n'))

const settingsWriteCommandLines = computed(() => {
  if (props.platform === 'windows') {
    return [
      'New-Item -ItemType Directory -Force -Path "$env:USERPROFILE\\.claude" | Out-Null',
      "@'",
      ...settingsJsonLines.value,
      '\'@ | Set-Content -Path "$env:USERPROFILE\\.claude\\settings.json" -Encoding UTF8'
    ]
  }
  return [
    'mkdir -p ~/.claude',
    "cat > ~/.claude/settings.json <<'JSON'",
    ...settingsJsonLines.value,
    'JSON'
  ]
})
const settingsWriteCommand = computed(() => settingsWriteCommandLines.value.join('\n'))

const temporaryEnvLines = computed(() => {
  if (props.platform === 'windows') {
    return [
      `$env:ANTHROPIC_BASE_URL = "${currentBaseUrl.value}"`,
      `$env:ANTHROPIC_AUTH_TOKEN = "${apiKeyValue.value}"`
    ]
  }
  return [
    `export ANTHROPIC_BASE_URL="${currentBaseUrl.value}"`,
    `export ANTHROPIC_AUTH_TOKEN="${apiKeyValue.value}"`
  ]
})
const temporaryEnvCommand = computed(() => temporaryEnvLines.value.join('\n'))

const vscodeSettingsLines = computed(() => [
  '{',
  '  "claudeCode.environmentVariables": [',
  `    { "name": "ANTHROPIC_BASE_URL", "value": "${currentBaseUrl.value}" },`,
  `    { "name": "ANTHROPIC_AUTH_TOKEN", "value": "${apiKeyValue.value}" }`,
  '  ]',
  '}'
])
const vscodeSettings = computed(() => vscodeSettingsLines.value.join('\n'))
const statusCommand = 'claude\n/status'
const projectCommand = computed(() =>
  [
    '# 进入你的项目目录',
    `cd ${props.platform === 'windows' ? 'C:\\path\\to\\your\\project' : '/path/to/your/project'}`,
    '# 启动 Claude Code',
    'claude'
  ].join('\n')
)
</script>
