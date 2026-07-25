<template>
  <section>
    <div
      class="mb-5 flex flex-col gap-3 rounded-xl border border-blue-100 bg-blue-50/70 p-4 dark:border-blue-900/60 dark:bg-blue-950/30 sm:flex-row sm:items-center sm:justify-between"
    >
      <div>
        <h4 class="font-semibold text-gray-900 dark:text-gray-100">系统管理 API Key</h4>
        <p class="mt-1 text-sm text-gray-600 dark:text-gray-400">
          供本地 MCP 等受信任 Agent 调用管理 API，和 cr_ 中转密钥完全隔离。
        </p>
      </div>
      <button class="btn btn-primary shrink-0" type="button" @click="openCreate">
        <i class="fas fa-plus mr-2" />
        新建管理密钥
      </button>
    </div>

    <div v-if="loading" class="py-10 text-center">
      <div class="loading-spinner mx-auto mb-3" />
      <p class="text-sm text-gray-500 dark:text-gray-400">正在加载管理密钥...</p>
    </div>

    <div
      v-else-if="keys.length === 0"
      class="rounded-xl border border-dashed border-gray-300 px-5 py-12 text-center dark:border-gray-600"
    >
      <i class="fas fa-key mb-3 text-3xl text-gray-300 dark:text-gray-600" />
      <p class="font-medium text-gray-700 dark:text-gray-200">还没有管理密钥</p>
      <p class="mt-1 text-sm text-gray-500 dark:text-gray-400">创建后即可配置给本地 MCP 服务。</p>
    </div>

    <div v-else class="space-y-3">
      <article
        v-for="key in keys"
        :key="key.id"
        class="rounded-xl border border-gray-200 bg-white p-4 shadow-sm dark:border-gray-700 dark:bg-gray-800"
      >
        <div class="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div class="min-w-0 flex-1">
            <div class="flex flex-wrap items-center gap-2">
              <h5 class="truncate font-semibold text-gray-900 dark:text-gray-100">
                {{ key.name }}
              </h5>
              <span
                :class="[
                  'rounded-full px-2 py-0.5 text-xs font-medium',
                  key.isActive
                    ? 'bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300'
                    : 'bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-300'
                ]"
              >
                {{ key.isActive ? '已启用' : '已停用' }}
              </span>
              <span
                v-if="isExpired(key)"
                class="rounded-full bg-red-100 px-2 py-0.5 text-xs font-medium text-red-700 dark:bg-red-900/40 dark:text-red-300"
              >
                已过期
              </span>
            </div>

            <p v-if="key.description" class="mt-1 text-sm text-gray-600 dark:text-gray-400">
              {{ key.description }}
            </p>

            <code
              class="mt-3 inline-block rounded-lg bg-gray-100 px-3 py-1.5 text-sm text-gray-700 dark:bg-gray-900 dark:text-gray-300"
            >
              {{ key.keyPreview }}
            </code>

            <div class="mt-3 flex flex-wrap gap-1.5">
              <span
                v-for="scope in key.scopes"
                :key="scope"
                class="rounded-md bg-indigo-50 px-2 py-1 text-xs text-indigo-700 dark:bg-indigo-950/50 dark:text-indigo-300"
              >
                {{ scopeLabels[scope] || scope }}
              </span>
            </div>

            <dl
              class="mt-3 grid gap-x-6 gap-y-1 text-xs text-gray-500 dark:text-gray-400 sm:grid-cols-2"
            >
              <div>
                <dt class="inline">有效期：</dt>
                <dd class="inline">{{ key.expiresAt ? formatDate(key.expiresAt) : '永久' }}</dd>
              </div>
              <div>
                <dt class="inline">最近使用：</dt>
                <dd class="inline">
                  {{ key.lastUsedAt ? formatDate(key.lastUsedAt) : '尚未使用' }}
                </dd>
              </div>
              <div>
                <dt class="inline">创建时间：</dt>
                <dd class="inline">{{ formatDate(key.createdAt) }}</dd>
              </div>
              <div v-if="key.lastUsedIp">
                <dt class="inline">最近来源：</dt>
                <dd class="inline">{{ key.lastUsedIp }}</dd>
              </div>
            </dl>
          </div>

          <div class="flex shrink-0 flex-wrap gap-2">
            <button
              class="btn btn-secondary !px-3 !py-2 text-xs"
              type="button"
              @click="openEdit(key)"
            >
              <i class="fas fa-pen mr-1.5" />
              编辑
            </button>
            <button
              class="btn btn-secondary !px-3 !py-2 text-xs"
              type="button"
              @click="rotateKey(key)"
            >
              <i class="fas fa-rotate mr-1.5" />
              轮换
            </button>
            <button
              :class="
                key.isActive
                  ? 'rounded-lg bg-amber-500 px-3 py-2 text-xs font-medium text-white transition hover:bg-amber-600'
                  : 'btn btn-success !px-3 !py-2 text-xs'
              "
              type="button"
              @click="toggleKey(key)"
            >
              <i :class="key.isActive ? 'fas fa-pause mr-1.5' : 'fas fa-play mr-1.5'" />
              {{ key.isActive ? '停用' : '启用' }}
            </button>
            <button
              class="btn btn-danger !px-3 !py-2 text-xs"
              type="button"
              @click="deleteKey(key)"
            >
              <i class="fas fa-trash mr-1.5" />
              删除
            </button>
          </div>
        </div>
      </article>
    </div>

    <div
      v-if="showForm"
      class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
      @click.self="closeForm"
    >
      <div
        class="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-2xl bg-white shadow-2xl dark:bg-gray-800"
      >
        <div
          class="flex items-center justify-between border-b border-gray-200 px-6 py-4 dark:border-gray-700"
        >
          <div>
            <h4 class="text-lg font-semibold text-gray-900 dark:text-gray-100">
              {{ editingKey ? '编辑管理密钥' : '新建管理密钥' }}
            </h4>
            <p class="mt-1 text-sm text-gray-500 dark:text-gray-400">
              按最小权限原则选择 Agent 可以执行的操作。
            </p>
          </div>
          <button
            class="rounded-lg p-2 text-gray-400 hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-gray-700"
            type="button"
            @click="closeForm"
          >
            <i class="fas fa-times" />
          </button>
        </div>

        <form class="space-y-5 p-6" @submit.prevent="saveKey">
          <label class="block">
            <span class="mb-1.5 block text-sm font-medium text-gray-700 dark:text-gray-200">
              名称
            </span>
            <input
              v-model.trim="form.name"
              class="form-input w-full dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100"
              maxlength="100"
              placeholder="例如：MacBook Codex MCP"
              required
            />
          </label>

          <label class="block">
            <span class="mb-1.5 block text-sm font-medium text-gray-700 dark:text-gray-200">
              说明
            </span>
            <textarea
              v-model.trim="form.description"
              class="form-input min-h-20 w-full dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100"
              maxlength="500"
              placeholder="记录使用设备、Agent 或用途"
            />
          </label>

          <label class="block">
            <span class="mb-1.5 block text-sm font-medium text-gray-700 dark:text-gray-200">
              过期时间
            </span>
            <input
              v-model="form.expiresAt"
              class="form-input w-full dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100"
              type="datetime-local"
            />
            <span class="mt-1 block text-xs text-gray-500 dark:text-gray-400">
              留空表示永久有效，可随时停用或轮换。
            </span>
          </label>

          <fieldset>
            <legend class="mb-2 text-sm font-medium text-gray-700 dark:text-gray-200">
              权限范围
            </legend>
            <div class="grid gap-2 sm:grid-cols-2">
              <label
                v-for="scope in supportedScopes"
                :key="scope"
                class="flex cursor-pointer items-start gap-3 rounded-lg border border-gray-200 p-3 hover:border-blue-300 dark:border-gray-700 dark:hover:border-blue-700"
              >
                <input
                  v-model="form.scopes"
                  class="mt-0.5 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                  type="checkbox"
                  :value="scope"
                />
                <span>
                  <span class="block text-sm font-medium text-gray-800 dark:text-gray-200">
                    {{ scopeLabels[scope] || scope }}
                  </span>
                  <code class="text-xs text-gray-500 dark:text-gray-400">{{ scope }}</code>
                </span>
              </label>
            </div>
          </fieldset>

          <div class="flex justify-end gap-3 border-t border-gray-200 pt-5 dark:border-gray-700">
            <button class="btn btn-secondary" type="button" @click="closeForm">取消</button>
            <button class="btn btn-primary" :disabled="saving" type="submit">
              <i v-if="saving" class="fas fa-spinner fa-spin mr-2" />
              {{ saving ? '保存中...' : '保存' }}
            </button>
          </div>
        </form>
      </div>
    </div>

    <div
      v-if="revealedSecret"
      class="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm"
    >
      <div class="w-full max-w-2xl rounded-2xl bg-white p-6 shadow-2xl dark:bg-gray-800">
        <div class="flex items-start gap-3">
          <div
            class="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-amber-100 text-amber-600 dark:bg-amber-900/40 dark:text-amber-300"
          >
            <i class="fas fa-shield-halved" />
          </div>
          <div>
            <h4 class="text-lg font-semibold text-gray-900 dark:text-gray-100">
              请立即保存管理密钥
            </h4>
            <p class="mt-1 text-sm text-gray-600 dark:text-gray-400">
              这是唯一一次显示完整密钥。关闭后只能轮换，无法再次查看。
            </p>
          </div>
        </div>

        <div
          class="mt-5 rounded-xl border border-amber-200 bg-amber-50 p-4 dark:border-amber-900/60 dark:bg-amber-950/30"
        >
          <code class="break-all text-sm font-semibold text-amber-900 dark:text-amber-200">
            {{ revealedSecret }}
          </code>
        </div>

        <div class="mt-5 flex justify-end gap-3">
          <button class="btn btn-secondary" type="button" @click="copySecret">
            <i class="fas fa-copy mr-2" />
            复制密钥
          </button>
          <button class="btn btn-primary" type="button" @click="revealedSecret = ''">
            我已保存
          </button>
        </div>
      </div>
    </div>
  </section>
</template>

<script setup>
import { onMounted, reactive, ref } from 'vue'

import {
  createManagementApiKeyApi,
  deleteManagementApiKeyApi,
  getManagementApiKeyScopesApi,
  getManagementApiKeysApi,
  rotateManagementApiKeyApi,
  updateManagementApiKeyApi
} from '@/utils/http_apis'
import { showToast } from '@/utils/tools'

const scopeLabels = {
  'api-keys:read': '查看中转密钥',
  'api-keys:write': '维护中转密钥',
  'api-keys:reveal': '查看中转密钥明文',
  'accounts:read': '查看账户',
  'accounts:write': '维护账户',
  'accounts:test': '测试账户',
  'accounts:refresh': '刷新账户',
  'stats:read': '查看统计'
}

const loading = ref(false)
const saving = ref(false)
const keys = ref([])
const supportedScopes = ref(Object.keys(scopeLabels))
const showForm = ref(false)
const editingKey = ref(null)
const revealedSecret = ref('')
const form = reactive({
  name: '',
  description: '',
  scopes: [],
  expiresAt: ''
})

const getErrorMessage = (response, fallback) => response?.message || response?.error || fallback

const loadKeys = async () => {
  loading.value = true
  try {
    const [scopeResponse, keyResponse] = await Promise.all([
      getManagementApiKeyScopesApi(),
      getManagementApiKeysApi()
    ])

    if (scopeResponse?.success && Array.isArray(scopeResponse.data)) {
      supportedScopes.value = scopeResponse.data
    }
    if (!keyResponse?.success) {
      throw new Error(getErrorMessage(keyResponse, '加载管理密钥失败'))
    }
    keys.value = Array.isArray(keyResponse.data) ? keyResponse.data : []
  } catch (error) {
    showToast(error.message || '加载管理密钥失败', 'error')
  } finally {
    loading.value = false
  }
}

const resetForm = () => {
  form.name = ''
  form.description = ''
  form.scopes = [...supportedScopes.value]
  form.expiresAt = ''
}

const openCreate = () => {
  editingKey.value = null
  resetForm()
  showForm.value = true
}

const openEdit = (key) => {
  editingKey.value = key
  form.name = key.name
  form.description = key.description || ''
  form.scopes = [...key.scopes]
  form.expiresAt = toDateTimeInput(key.expiresAt)
  showForm.value = true
}

const closeForm = () => {
  if (!saving.value) {
    showForm.value = false
    editingKey.value = null
  }
}

const saveKey = async () => {
  if (!form.name) {
    showToast('请输入名称', 'error')
    return
  }
  if (form.scopes.length === 0) {
    showToast('请至少选择一个权限', 'error')
    return
  }

  saving.value = true
  try {
    const payload = {
      name: form.name,
      description: form.description,
      scopes: form.scopes,
      expiresAt: form.expiresAt ? new Date(form.expiresAt).toISOString() : ''
    }
    const response = editingKey.value
      ? await updateManagementApiKeyApi(editingKey.value.id, payload)
      : await createManagementApiKeyApi(payload)

    if (!response?.success) {
      throw new Error(getErrorMessage(response, '保存管理密钥失败'))
    }

    if (response.data?.managementKey) {
      revealedSecret.value = response.data.managementKey
    }
    showForm.value = false
    editingKey.value = null
    showToast('管理密钥已保存', 'success')
    await loadKeys()
  } catch (error) {
    showToast(error.message || '保存管理密钥失败', 'error')
  } finally {
    saving.value = false
  }
}

const toggleKey = async (key) => {
  const response = await updateManagementApiKeyApi(key.id, { isActive: !key.isActive })
  if (!response?.success) {
    showToast(getErrorMessage(response, '更新管理密钥状态失败'), 'error')
    return
  }
  showToast(key.isActive ? '管理密钥已停用' : '管理密钥已启用', 'success')
  await loadKeys()
}

const rotateKey = async (key) => {
  if (!window.confirm(`轮换“${key.name}”后，旧密钥会立即失效。是否继续？`)) {
    return
  }
  const response = await rotateManagementApiKeyApi(key.id)
  if (!response?.success) {
    showToast(getErrorMessage(response, '轮换管理密钥失败'), 'error')
    return
  }
  revealedSecret.value = response.data?.managementKey || ''
  showToast('管理密钥已轮换', 'success')
  await loadKeys()
}

const deleteKey = async (key) => {
  if (!window.confirm(`确定永久删除管理密钥“${key.name}”吗？`)) {
    return
  }
  const response = await deleteManagementApiKeyApi(key.id)
  if (!response?.success) {
    showToast(getErrorMessage(response, '删除管理密钥失败'), 'error')
    return
  }
  showToast('管理密钥已删除', 'success')
  await loadKeys()
}

const copySecret = async () => {
  try {
    await navigator.clipboard.writeText(revealedSecret.value)
    showToast('管理密钥已复制', 'success')
  } catch (_error) {
    showToast('复制失败，请手动复制', 'error')
  }
}

const isExpired = (key) => Boolean(key.expiresAt && new Date(key.expiresAt).getTime() <= Date.now())

const formatDate = (value) => {
  if (!value) {
    return '-'
  }
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).format(new Date(value))
}

const toDateTimeInput = (value) => {
  if (!value) {
    return ''
  }
  const date = new Date(value)
  const localDate = new Date(date.getTime() - date.getTimezoneOffset() * 60 * 1000)
  return localDate.toISOString().slice(0, 16)
}

onMounted(loadKeys)
</script>
