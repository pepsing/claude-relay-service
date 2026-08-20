<template>
  <div
    class="rounded-2xl border border-red-100 bg-white/90 p-4 shadow-xl dark:border-red-900/40 dark:bg-gray-800/90 sm:p-6"
  >
    <div class="mb-5 flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
      <div>
        <div class="flex flex-wrap items-center gap-2">
          <h2 class="text-xl font-bold text-gray-900 dark:text-gray-100">{{ title }}</h2>
          <span
            :class="[
              'rounded-full px-2.5 py-1 text-xs font-semibold',
              captureEnabled
                ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300'
                : 'bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-300'
            ]"
          >
            {{ captureEnabled ? '采集已开启' : '采集已关闭' }}
          </span>
          <span
            class="rounded-full bg-blue-100 px-2.5 py-1 text-xs text-blue-700 dark:bg-blue-900/30 dark:text-blue-300"
          >
            保留 {{ retentionHours }} 小时
          </span>
        </div>
        <p class="mt-1 text-sm text-gray-500 dark:text-gray-400">
          这里只显示最终失败，不计入现有成功请求、Token 和费用统计。
        </p>
      </div>
      <button
        class="rounded-lg bg-red-500 px-4 py-2 text-sm font-medium text-white transition hover:bg-red-600 disabled:opacity-50"
        :disabled="loading"
        @click="loadRecords(1)"
      >
        <i :class="['fas mr-2', loading ? 'fa-spinner fa-spin' : 'fa-sync-alt']" />
        刷新
      </button>
    </div>

    <div
      v-if="!captureEnabled && !loading"
      class="mb-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-200"
    >
      失败采集当前关闭；仍可查看保留期内已经写入的历史记录。
    </div>

    <div class="mb-5 grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-7">
      <div
        v-for="card in summaryCards"
        :key="card.label"
        class="rounded-xl bg-gray-50 p-3 dark:bg-gray-900/50"
      >
        <p class="text-xs text-gray-500 dark:text-gray-400">{{ card.label }}</p>
        <p :class="['mt-1 text-xl font-bold', card.color]">{{ card.value }}</p>
      </div>
    </div>

    <form
      class="mb-5 grid gap-3 md:grid-cols-2"
      :class="isAdmin ? 'xl:grid-cols-7' : 'xl:grid-cols-6'"
      @submit.prevent="loadRecords(1)"
    >
      <input
        v-model.trim="filters.keyword"
        class="rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-gray-800 outline-none focus:border-red-400 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-200"
        placeholder="Request ID / 错误摘要"
        type="search"
      />
      <el-select
        v-if="isAdmin"
        v-model="filters.apiKeyId"
        class="w-full"
        clearable
        filterable
        placeholder="全部 API Key"
      >
        <el-option
          v-for="apiKeyOption in apiKeyOptions"
          :key="apiKeyOption.id"
          :label="`${apiKeyOption.name || apiKeyOption.id} (${shortId(apiKeyOption.id)})`"
          :value="apiKeyOption.id"
        />
      </el-select>
      <select v-model="filters.statusCode" class="filter-control">
        <option value="">全部状态</option>
        <option v-for="status in availableFilters.statusCodes" :key="status" :value="status">
          HTTP {{ status }}
        </option>
      </select>
      <select v-model="filters.failureType" class="filter-control">
        <option value="">全部错误类型</option>
        <option v-for="type in availableFilters.failureTypes" :key="type" :value="type">
          {{ formatFailureType(type) }}
        </option>
      </select>
      <select v-model="filters.model" class="filter-control">
        <option value="">全部模型</option>
        <option v-for="model in availableFilters.models" :key="model" :value="model">
          {{ model }}
        </option>
      </select>
      <select v-model="filters.endpoint" class="filter-control">
        <option value="">全部接口</option>
        <option v-for="endpoint in availableFilters.endpoints" :key="endpoint" :value="endpoint">
          {{ endpoint }}
        </option>
      </select>
      <div class="flex gap-2">
        <button
          class="flex-1 rounded-lg bg-gray-800 px-3 py-2 text-sm text-white hover:bg-gray-900 dark:bg-gray-600 dark:hover:bg-gray-500"
          type="submit"
        >
          查询
        </button>
        <button
          class="rounded-lg border border-gray-200 px-3 py-2 text-sm text-gray-600 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-700"
          type="button"
          @click="resetFilters"
        >
          重置
        </button>
      </div>
    </form>

    <div class="overflow-x-auto rounded-xl border border-gray-200 dark:border-gray-700">
      <table class="min-w-full divide-y divide-gray-200 text-sm dark:divide-gray-700">
        <thead class="bg-gray-50 dark:bg-gray-900/60">
          <tr class="text-left text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400">
            <th class="px-3 py-3">时间</th>
            <th v-if="showApiKey" class="px-3 py-3">API Key</th>
            <th class="px-3 py-3">状态</th>
            <th class="px-3 py-3">错误类型</th>
            <th class="px-3 py-3">模型 / 接口</th>
            <th v-if="isAdmin" class="px-3 py-3">上游账户</th>
            <th class="min-w-64 px-3 py-3">错误摘要</th>
            <th class="px-3 py-3">耗时</th>
            <th class="px-3 py-3">操作</th>
          </tr>
        </thead>
        <tbody class="divide-y divide-gray-100 bg-white dark:divide-gray-800 dark:bg-gray-800">
          <tr v-if="loading">
            <td
              class="px-4 py-12 text-center text-gray-500"
              :colspan="isAdmin ? 9 : showApiKey ? 8 : 7"
            >
              <i class="fas fa-spinner fa-spin mr-2" />加载中
            </td>
          </tr>
          <tr v-else-if="records.length === 0">
            <td
              class="px-4 py-12 text-center text-gray-500"
              :colspan="isAdmin ? 9 : showApiKey ? 8 : 7"
            >
              暂无失败明细
            </td>
          </tr>
          <tr
            v-for="record in records"
            v-else
            :key="record.requestId"
            class="hover:bg-red-50/40 dark:hover:bg-red-950/10"
          >
            <td class="whitespace-nowrap px-3 py-3 text-gray-600 dark:text-gray-300">
              {{ formatDate(record.timestamp) }}
            </td>
            <td
              v-if="showApiKey"
              class="max-w-40 truncate px-3 py-3 text-gray-700 dark:text-gray-200"
            >
              {{ record.apiKeyName || record.apiKeyId || '-' }}
            </td>
            <td class="px-3 py-3">
              <span :class="statusBadgeClass(record.httpStatus)"
                >HTTP {{ record.httpStatus || '-' }}</span
              >
            </td>
            <td class="whitespace-nowrap px-3 py-3 text-gray-700 dark:text-gray-200">
              {{ formatFailureType(record.failureType) }}
            </td>
            <td class="max-w-56 px-3 py-3">
              <div class="truncate font-medium text-gray-800 dark:text-gray-200">
                {{ record.model || '-' }}
              </div>
              <div class="truncate text-xs text-gray-500">{{ record.endpoint || '-' }}</div>
            </td>
            <td v-if="isAdmin" class="max-w-40 truncate px-3 py-3 text-gray-600 dark:text-gray-300">
              {{ formatAccount(record) }}
            </td>
            <td class="max-w-md px-3 py-3 text-gray-600 dark:text-gray-300">
              <p class="line-clamp-2">{{ record.errorSummary || '-' }}</p>
            </td>
            <td class="whitespace-nowrap px-3 py-3 text-gray-600 dark:text-gray-300">
              {{ formatDuration(record.durationMs) }}
            </td>
            <td class="px-3 py-3">
              <button
                class="text-blue-600 hover:text-blue-800 dark:text-blue-400"
                @click="openDetail(record)"
              >
                查看
              </button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <div v-if="pagination.totalRecords > 0" class="mt-4 flex justify-end">
      <el-pagination
        v-model:current-page="pagination.currentPage"
        v-model:page-size="pagination.pageSize"
        background
        layout="total, sizes, prev, pager, next"
        :page-sizes="[20, 50, 100]"
        :total="pagination.totalRecords"
        @current-change="loadRecords"
        @size-change="handleSizeChange"
      />
    </div>

    <el-dialog v-model="detailVisible" title="失败请求详情" width="min(900px, 94vw)">
      <div v-loading="detailLoading" class="space-y-5 text-sm">
        <template v-if="detailRecord">
          <div class="grid gap-3 rounded-xl bg-gray-50 p-4 dark:bg-gray-900/60 md:grid-cols-3">
            <div>
              <span class="detail-label">Request ID</span>
              <p class="break-all">{{ detailRecord.requestId }}</p>
            </div>
            <div>
              <span class="detail-label">HTTP 状态</span>
              <p>{{ detailRecord.httpStatus }}</p>
            </div>
            <div>
              <span class="detail-label">错误类型</span>
              <p>{{ formatFailureType(detailRecord.failureType) }}</p>
            </div>
            <div>
              <span class="detail-label">模型</span>
              <p class="break-all">{{ detailRecord.model || '-' }}</p>
            </div>
            <div>
              <span class="detail-label">接口</span>
              <p class="break-all">{{ detailRecord.endpoint || '-' }}</p>
            </div>
            <div>
              <span class="detail-label">耗时</span>
              <p>{{ formatDuration(detailRecord.durationMs) }}</p>
            </div>
            <div v-if="isAdmin">
              <span class="detail-label">API Key</span>
              <p>{{ detailRecord.apiKeyName || detailRecord.apiKeyId || '-' }}</p>
            </div>
            <div v-if="isAdmin">
              <span class="detail-label">上游账户</span>
              <p class="break-all">{{ formatAccount(detailRecord) }}</p>
            </div>
            <div>
              <span class="detail-label">是否可重试</span>
              <p>{{ detailRecord.retryable ? '是' : '否' }}</p>
            </div>
          </div>
          <section>
            <h3 class="detail-heading">错误摘要</h3>
            <pre class="detail-pre">{{ detailRecord.errorSummary || '-' }}</pre>
          </section>
          <section v-if="detailRecord.clientErrorBody">
            <h3 class="detail-heading">用户收到的错误</h3>
            <pre class="detail-pre">{{ prettyJson(detailRecord.clientErrorBody) }}</pre>
          </section>
          <section v-if="detailRecord.requestBodySnapshot">
            <h3 class="detail-heading">请求体预览</h3>
            <pre class="detail-pre">{{ prettyJson(detailRecord.requestBodySnapshot) }}</pre>
          </section>
          <section v-if="isAdmin && detailRecord.upstreamErrorBody">
            <h3 class="detail-heading">上游错误（管理员）</h3>
            <pre class="detail-pre">{{ prettyJson(detailRecord.upstreamErrorBody) }}</pre>
          </section>
          <section v-if="isAdmin && detailRecord.adminDiagnostics">
            <h3 class="detail-heading">内部诊断（管理员）</h3>
            <pre class="detail-pre">{{ prettyJson(detailRecord.adminDiagnostics) }}</pre>
          </section>
        </template>
      </div>
    </el-dialog>
  </div>
</template>

<script setup>
import { computed, onMounted, reactive, ref, watch } from 'vue'
import {
  getApiStatsRequestFailureApi,
  getApiStatsRequestFailuresApi,
  getApiKeysWithParamsApi,
  getRequestFailureApi,
  getRequestFailuresApi
} from '@/utils/http_apis'
import { showToast } from '@/utils/tools'
import { useUserStore } from '@/stores/user'

const props = defineProps({
  mode: {
    type: String,
    default: 'admin',
    validator: (value) => ['admin', 'api-stats', 'user'].includes(value)
  },
  apiKey: {
    type: String,
    default: ''
  },
  apiId: {
    type: String,
    default: ''
  },
  title: {
    type: String,
    default: '失败明细'
  }
})

const userStore = useUserStore()
const loading = ref(false)
const detailLoading = ref(false)
const detailVisible = ref(false)
const detailRecord = ref(null)
const captureEnabled = ref(false)
const retentionHours = ref(48)
const records = ref([])
const adminApiKeys = ref([])
const summary = reactive({
  totalFailures: 0,
  clientErrors: 0,
  serverErrors: 0,
  rateLimited: 0,
  timeouts: 0,
  streamFailures: 0,
  clientAborted: 0,
  avgDurationMs: 0
})
const pagination = reactive({
  currentPage: 1,
  pageSize: 50,
  totalRecords: 0,
  totalPages: 0
})
const availableFilters = reactive({
  apiKeys: [],
  models: [],
  endpoints: [],
  failureTypes: [],
  statusCodes: []
})
const filters = reactive({
  keyword: '',
  apiKeyId: '',
  statusCode: '',
  failureType: '',
  model: '',
  endpoint: ''
})

const isAdmin = computed(() => props.mode === 'admin')
const showApiKey = computed(() => props.mode !== 'api-stats')
const canQuery = computed(() => props.mode !== 'api-stats' || Boolean(props.apiKey && props.apiId))
const apiKeyOptions = computed(() => {
  const optionsById = new Map()
  for (const option of [...adminApiKeys.value, ...(availableFilters.apiKeys || [])]) {
    if (option?.id) {
      optionsById.set(option.id, {
        id: option.id,
        name: option.name || option.id
      })
    }
  }
  return [...optionsById.values()].sort((left, right) =>
    left.name.localeCompare(right.name, 'zh-CN')
  )
})
const summaryCards = computed(() => [
  { label: '失败总数', value: summary.totalFailures, color: 'text-red-600 dark:text-red-400' },
  { label: '4xx', value: summary.clientErrors, color: 'text-orange-600 dark:text-orange-400' },
  { label: '5xx', value: summary.serverErrors, color: 'text-red-700 dark:text-red-300' },
  { label: '限流', value: summary.rateLimited, color: 'text-amber-600 dark:text-amber-400' },
  { label: '超时', value: summary.timeouts, color: 'text-purple-600 dark:text-purple-400' },
  { label: '流式错误', value: summary.streamFailures, color: 'text-blue-600 dark:text-blue-400' },
  { label: '客户端中断', value: summary.clientAborted, color: 'text-gray-600 dark:text-gray-300' }
])

const buildParams = (page) => {
  const params = {
    page,
    pageSize: pagination.pageSize
  }
  for (const [key, value] of Object.entries(filters)) {
    if (value !== '' && value !== null && value !== undefined) {
      params[key] = value
    }
  }
  return params
}

const fetchList = async (params) => {
  if (props.mode === 'api-stats') {
    return getApiStatsRequestFailuresApi({
      ...params,
      apiKey: props.apiKey,
      apiId: props.apiId
    })
  }
  if (props.mode === 'user') {
    return userStore.getUserRequestFailures(params)
  }
  return getRequestFailuresApi(params)
}

const loadAdminApiKeys = async () => {
  if (!isAdmin.value) return
  try {
    const query = new URLSearchParams({
      page: '1',
      pageSize: '200',
      sortBy: 'name',
      sortOrder: 'asc'
    }).toString()
    const response = await getApiKeysWithParamsApi(query)
    adminApiKeys.value = Array.isArray(response?.data?.items) ? response.data.items : []
  } catch {
    adminApiKeys.value = []
  }
}

const fetchDetail = async (requestId) => {
  if (props.mode === 'api-stats') {
    return getApiStatsRequestFailureApi(requestId, {
      apiKey: props.apiKey,
      apiId: props.apiId
    })
  }
  if (props.mode === 'user') {
    return userStore.getUserRequestFailure(requestId)
  }
  return getRequestFailureApi(requestId)
}

const syncData = (data = {}) => {
  captureEnabled.value = data.captureEnabled === true
  retentionHours.value = data.retentionHours || 48
  records.value = Array.isArray(data.records) ? data.records : []
  Object.assign(summary, data.summary || {})
  Object.assign(pagination, data.pagination || {})
  Object.assign(availableFilters, data.availableFilters || {})
}

const loadRecords = async (page = pagination.currentPage) => {
  if (!canQuery.value) {
    records.value = []
    return
  }
  loading.value = true
  try {
    const response = await fetchList(buildParams(page))
    if (response?.success === false) {
      showToast(response.message || '加载失败明细失败', 'error')
      return
    }
    syncData(response?.data || {})
  } catch (error) {
    showToast(error.response?.data?.message || error.message || '加载失败明细失败', 'error')
  } finally {
    loading.value = false
  }
}

const openDetail = async (record) => {
  detailVisible.value = true
  detailLoading.value = true
  detailRecord.value = record
  try {
    const response = await fetchDetail(record.requestId)
    if (response?.success === false) {
      showToast(response.message || '加载失败详情失败', 'error')
      return
    }
    detailRecord.value = response?.data?.record || record
  } catch (error) {
    showToast(error.response?.data?.message || error.message || '加载失败详情失败', 'error')
  } finally {
    detailLoading.value = false
  }
}

const resetFilters = () => {
  Object.assign(filters, {
    keyword: '',
    apiKeyId: '',
    statusCode: '',
    failureType: '',
    model: '',
    endpoint: ''
  })
  loadRecords(1)
}

const handleSizeChange = () => loadRecords(1)
const shortId = (value) => {
  const text = String(value || '')
  return text.length > 12 ? `${text.slice(0, 8)}…${text.slice(-4)}` : text
}
const formatAccount = (record) => {
  const accountId = record?.accountId
  const accountName = record?.accountName
  if (!accountId) return '-'
  return accountName && accountName !== accountId ? `${accountName} (${accountId})` : accountId
}
const formatDate = (value) => (value ? new Date(value).toLocaleString('zh-CN') : '-')
const formatDuration = (value) => {
  const milliseconds = Number(value)
  if (!Number.isFinite(milliseconds)) return '-'
  return milliseconds >= 1000 ? `${(milliseconds / 1000).toFixed(2)}s` : `${milliseconds}ms`
}
const formatFailureType = (value) =>
  ({
    client_aborted: '客户端中断',
    quota_exceeded: '额度不足',
    rate_limit: '请求限流',
    timeout: '请求超时',
    no_available_account: '无可用账户',
    authentication_error: '认证错误',
    upstream_auth_error: '上游认证错误',
    permission_denied: '权限拒绝',
    request_validation_error: '请求校验错误',
    upstream_unavailable: '上游不可用',
    upstream_error: '上游错误',
    upstream_stream_error: '流式错误',
    internal_error: '内部错误',
    response_error: '响应传输错误',
    request_failed: '请求失败'
  })[value] ||
  value ||
  '请求失败'
const statusBadgeClass = (status) => [
  'inline-flex rounded-full px-2.5 py-1 text-xs font-semibold',
  Number(status) >= 500
    ? 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300'
    : Number(status) === 429
      ? 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300'
      : 'bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-300'
]
const prettyJson = (value) => {
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

onMounted(() => {
  loadAdminApiKeys()
  loadRecords(1)
})
watch(
  () => [props.apiKey, props.apiId],
  () => loadRecords(1)
)
</script>

<style scoped>
.filter-control {
  @apply rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-gray-800 outline-none focus:border-red-400 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-200;
}

.detail-label {
  @apply mb-1 block text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400;
}

.detail-heading {
  @apply mb-2 font-semibold text-gray-800 dark:text-gray-200;
}

.detail-pre {
  @apply max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-xl bg-gray-950 p-4 text-xs leading-5 text-gray-100;
}
</style>
