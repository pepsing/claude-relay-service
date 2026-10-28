<template>
  <el-dialog
    class="account-access-dialog"
    :close-on-click-modal="false"
    :model-value="true"
    title="账户访问授权"
    top="16px"
    width="min(1100px, 96vw)"
    @close="$emit('close')"
  >
    <div v-loading="loading" class="space-y-5 text-gray-700 dark:text-gray-200">
      <p class="text-sm text-gray-500 dark:text-gray-400">
        访问组与调度分组独立。授权通过后，仍按原有绑定、模型和可用性选择账户。修改保存后生效。
      </p>
      <el-alert v-if="error" :closable="false" :title="error" type="error" />
      <template v-if="state">
        <el-tabs v-model="tab">
          <el-tab-pane label="账户权限" name="accounts">
            <div class="space-y-4">
              <el-select
                v-model="selectedAccounts"
                class="w-full"
                filterable
                multiple
                placeholder="选择一个或多个账户"
                @change="loadSinglePolicy"
              >
                <el-option
                  v-for="account in accounts"
                  :key="account.ref"
                  :label="`${account.name} · ${account.type}`"
                  :value="account.ref"
                />
              </el-select>
              <el-radio-group v-model="policy.mode">
                <el-radio value="open">不额外限制</el-radio>
                <el-radio value="restricted">仅授权访问</el-radio>
              </el-radio-group>
              <template v-if="policy.mode === 'restricted'">
                <div>
                  <label class="mb-2 block">允许的访问组</label
                  ><el-select
                    v-model="policy.groupIds"
                    class="w-full"
                    filterable
                    multiple
                    placeholder="选择访问组"
                    ><el-option
                      v-for="group in state.groups"
                      :key="group.id"
                      :label="group.name"
                      :value="group.id"
                  /></el-select>
                </div>
                <div>
                  <label class="mb-2 block">单独授权的 API Key</label
                  ><el-select
                    v-model="policy.keyIds"
                    class="w-full"
                    filterable
                    multiple
                    placeholder="选择 API Key"
                    ><el-option
                      v-for="key in keys"
                      :key="key.id"
                      :label="keyLabel(key)"
                      :value="key.id"
                  /></el-select>
                </div>
                <el-alert
                  :closable="false"
                  title="访问组与单独授权满足任意一项即可访问。两项均为空时，所有 Key 都不能访问。"
                  type="info"
                />
              </template>
              <el-button :disabled="!selectedAccounts.length" @click="applyPolicies"
                >应用到所选 {{ selectedAccounts.length }} 个账户</el-button
              >
              <div
                class="max-h-72 overflow-auto rounded-lg border border-gray-200 dark:border-gray-700"
              >
                <table class="w-full text-left text-sm">
                  <thead class="bg-gray-50 dark:bg-gray-800">
                    <tr>
                      <th class="p-3">账户</th>
                      <th class="p-3">调度 / 访问</th>
                      <th class="p-3">授权范围</th>
                      <th class="p-3"></th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr
                      v-for="account in accounts"
                      :key="account.ref"
                      class="border-t border-gray-200 dark:border-gray-700"
                    >
                      <td class="p-3">
                        {{ account.name }}
                        <div class="text-xs text-gray-500">{{ account.type }}</div>
                      </td>
                      <td class="p-3">
                        {{ poolLabel(account.accountType) }} ·
                        {{
                          state.policies[account.ref]?.mode === 'restricted'
                            ? '受限访问'
                            : '不额外限制'
                        }}
                      </td>
                      <td class="p-3">{{ policySummary(account.ref) }}</td>
                      <td class="p-3">
                        <el-button size="small" @click="editAccount(account.ref)">编辑</el-button>
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>
          </el-tab-pane>
          <el-tab-pane label="Key 访问组" name="keys">
            <div class="space-y-4">
              <el-input v-model="keySearch" clearable placeholder="按 Key 名称或普通标签筛选" />
              <el-select
                v-model="selectedKeys"
                class="w-full"
                filterable
                multiple
                placeholder="选择需要批量授权的 Key"
                ><el-option
                  v-for="key in filteredKeys"
                  :key="key.id"
                  :label="keyLabel(key)"
                  :value="key.id"
              /></el-select>
              <el-button @click="selectedKeys = filteredKeys.map((key) => key.id)"
                >选择筛选结果（{{ filteredKeys.length }}）</el-button
              >
              <el-select v-model="selectedGroups" class="w-full" multiple placeholder="选择访问组"
                ><el-option
                  v-for="group in state.groups"
                  :key="group.id"
                  :label="group.name"
                  :value="group.id"
              /></el-select>
              <div class="flex flex-wrap gap-2">
                <el-button
                  :disabled="!selectedKeys.length || !selectedGroups.length"
                  @click="applyMemberships('add')"
                  >加入所选组</el-button
                ><el-button
                  :disabled="!selectedKeys.length || !selectedGroups.length"
                  @click="applyMemberships('remove')"
                  >移出所选组</el-button
                >
              </div>
              <div class="max-h-72 overflow-auto">
                <div
                  v-for="key in filteredKeys"
                  :key="key.id"
                  class="flex flex-wrap items-center justify-between gap-2 border-b border-gray-200 py-3 dark:border-gray-700"
                >
                  <span>{{ keyLabel(key) }}</span
                  ><el-select
                    class="w-72"
                    :model-value="state.memberships[key.id] || []"
                    multiple
                    placeholder="无访问组"
                    @update:model-value="(value) => setMembership(key.id, value)"
                    ><el-option
                      v-for="group in state.groups"
                      :key="group.id"
                      :label="group.name"
                      :value="group.id"
                  /></el-select>
                </div>
              </div>
            </div>
          </el-tab-pane>
          <el-tab-pane label="管理访问组" name="groups">
            <div class="space-y-3">
              <div class="flex gap-2">
                <el-input
                  v-model="newGroupName"
                  maxlength="100"
                  placeholder="新访问组名称，例如 tokensaver 使用者"
                /><el-button :disabled="!newGroupName.trim()" @click="addGroup">创建</el-button>
              </div>
              <div v-for="group in state.groups" :key="group.id" class="flex items-center gap-3">
                <el-input v-model="group.name" maxlength="100" @input="dirty = true" /><el-button
                  plain
                  type="danger"
                  @click="removeGroup(group.id)"
                  >删除</el-button
                >
              </div>
              <p class="text-sm text-gray-500">
                删除组会撤销该组授权；受限账户仍保持受限，不会自动开放。其他组或单独 Key
                授权继续有效。
              </p>
            </div>
          </el-tab-pane>
          <el-tab-pane label="授权预览" name="preview">
            <el-select
              v-model="previewKey"
              class="mb-4 w-full"
              filterable
              placeholder="选择 API Key 查看授权来源"
              ><el-option v-for="key in keys" :key="key.id" :label="keyLabel(key)" :value="key.id"
            /></el-select>
            <p class="mb-3 text-sm text-gray-500">
              仅展示账户访问授权。实际可用账户还受平台权限、绑定、模型和健康状态限制。
            </p>
            <div v-if="previewKey" class="max-h-96 overflow-auto">
              <div
                v-for="account in accounts"
                :key="account.ref"
                class="flex justify-between gap-4 border-b border-gray-200 py-3 dark:border-gray-700"
              >
                <span>{{ account.name }}</span
                ><span>{{ accessReason(account.ref) }}</span>
              </div>
            </div>
          </el-tab-pane>
          <el-tab-pane label="变更记录" name="audit">
            <el-button @click="loadAudit">刷新记录</el-button>
            <div class="max-h-96 overflow-auto">
              <details
                v-for="entry in audit"
                :key="entry.id"
                class="border-b border-gray-200 py-3 dark:border-gray-700"
              >
                <summary>
                  {{ new Date(entry.at).toLocaleString() }} · {{ entry.actor }} · 版本
                  {{ entry.revision }}
                </summary>
                <pre class="mt-2 overflow-auto text-xs">{{
                  JSON.stringify({ before: entry.before, after: entry.after }, null, 2)
                }}</pre>
              </details>
            </div>
          </el-tab-pane>
        </el-tabs>
      </template>
    </div>
    <template #footer
      ><div class="flex flex-wrap items-center justify-end gap-3">
        <span v-if="dirty" class="text-sm text-amber-600">有未保存的修改</span
        ><el-button @click="$emit('close')">关闭</el-button
        ><el-button :disabled="loading" @click="load">重新加载</el-button
        ><el-button :disabled="!dirty || !state" :loading="saving" type="primary" @click="save"
          >保存授权配置</el-button
        >
      </div></template
    >
  </el-dialog>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import request from '@/utils/request'

defineEmits(['close'])
const tab = ref('accounts')
const state = ref(null)
const accounts = ref([])
const keys = ref([])
const loading = ref(false)
const saving = ref(false)
const error = ref('')
const dirty = ref(false)
const selectedAccounts = ref([])
const selectedKeys = ref([])
const selectedGroups = ref([])
const policy = ref({ mode: 'restricted', keyIds: [], groupIds: [] })
const keySearch = ref('')
const newGroupName = ref('')
const previewKey = ref('')
const audit = ref([])
const copy = (value) => JSON.parse(JSON.stringify(value))
const keyLabel = (key) => `${key.name}${key.isActive ? '' : '（停用）'} · ${key.id.slice(0, 8)}`
const poolLabel = (type) => ({ shared: '共享', dedicated: '专属', group: '分组' })[type] || type
const filteredKeys = computed(() =>
  keys.value.filter((key) =>
    `${key.name} ${key.tags.join(' ')}`.toLowerCase().includes(keySearch.value.toLowerCase())
  )
)
const groupName = (id) => state.value.groups.find((group) => group.id === id)?.name || id

async function load() {
  if (dirty.value) {
    try {
      await ElMessageBox.confirm('重新加载将丢弃尚未保存的授权修改。', '重新加载')
    } catch {
      return
    }
  }
  loading.value = true
  error.value = ''
  try {
    const result = await request({ url: '/admin/account-access', method: 'GET' })
    if (!result.success) {
      error.value = result.message
      return
    }
    state.value = result.data.state
    accounts.value = result.data.accounts
    keys.value = result.data.keys
    dirty.value = false
    selectedAccounts.value = []
  } finally {
    loading.value = false
  }
}

function loadSinglePolicy() {
  if (selectedAccounts.value.length === 1)
    policy.value = copy(
      state.value.policies[selectedAccounts.value[0]] || { mode: 'open', keyIds: [], groupIds: [] }
    )
}
function editAccount(ref) {
  selectedAccounts.value = [ref]
  loadSinglePolicy()
}
function applyPolicies() {
  for (const ref of selectedAccounts.value) state.value.policies[ref] = copy(policy.value)
  dirty.value = true
  ElMessage.success('已应用，请保存授权配置')
}
function setMembership(id, groups) {
  state.value.memberships[id] = groups
  dirty.value = true
}
function applyMemberships(action) {
  for (const id of selectedKeys.value) {
    const previous = state.value.memberships[id] || []
    setMembership(
      id,
      action === 'add'
        ? [...new Set([...previous, ...selectedGroups.value])]
        : previous.filter((group) => !selectedGroups.value.includes(group))
    )
  }
}
function addGroup() {
  state.value.groups.push({
    id:
      globalThis.crypto?.randomUUID?.() ||
      `group_${Date.now()}_${Math.random().toString(36).slice(2)}`,
    name: newGroupName.value.trim()
  })
  newGroupName.value = ''
  dirty.value = true
}
async function removeGroup(id) {
  try {
    await ElMessageBox.confirm(
      `删除“${groupName(id)}”并撤销该组的授权？保存后生效。`,
      '删除访问组',
      { type: 'warning' }
    )
  } catch {
    return
  }
  state.value.groups = state.value.groups.filter((group) => group.id !== id)
  for (const key of Object.keys(state.value.memberships))
    state.value.memberships[key] = state.value.memberships[key].filter((group) => group !== id)
  for (const value of Object.values(state.value.policies))
    value.groupIds = value.groupIds.filter((group) => group !== id)
  policy.value.groupIds = policy.value.groupIds.filter((group) => group !== id)
  selectedGroups.value = selectedGroups.value.filter((group) => group !== id)
  dirty.value = true
}
function policySummary(ref) {
  const value = state.value.policies[ref]
  if (!value || value.mode === 'open') return '沿用现有调度权限'
  return `${value.groupIds.map(groupName).join('、') || '无访问组'} · ${value.keyIds.length} 个单独授权 Key`
}
function accessReason(ref) {
  const value = state.value.policies[ref]
  if (!value || value.mode === 'open') return '通过：不额外限制'
  const reasons = []
  if (value.keyIds.includes(previewKey.value)) reasons.push('单独 Key 授权')
  for (const id of value.groupIds)
    if ((state.value.memberships[previewKey.value] || []).includes(id))
      reasons.push(`访问组 ${groupName(id)}`)
  return reasons.length ? `通过：${reasons.join('；')}` : '拒绝：未获得授权'
}
async function save() {
  saving.value = true
  error.value = ''
  try {
    const result = await request({ url: '/admin/account-access', method: 'PUT', data: state.value })
    if (!result.success) {
      error.value = result.message
      return
    }
    state.value = result.data
    dirty.value = false
    ElMessage.success('授权配置已保存')
  } finally {
    saving.value = false
  }
}
async function loadAudit() {
  const result = await request({ url: '/admin/account-access/audit', method: 'GET' })
  if (result.success) audit.value = result.data
  else error.value = result.message
}
onMounted(load)
</script>

<style>
.account-access-dialog {
  display: flex;
  flex-direction: column;
  max-height: calc(100vh - 32px);
  max-height: calc(100dvh - 32px);
  margin-bottom: 16px;
}

.account-access-dialog .el-dialog__header,
.account-access-dialog .el-dialog__footer {
  flex: 0 0 auto;
}

.account-access-dialog .el-dialog__body {
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
  scrollbar-gutter: stable;
}
</style>
