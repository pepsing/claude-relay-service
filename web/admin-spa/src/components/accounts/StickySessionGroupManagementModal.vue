<template>
  <Teleport to="body">
    <div class="modal fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4">
      <div
        class="modal-content custom-scrollbar max-h-[92vh] w-full max-w-5xl overflow-y-auto p-4 sm:p-6"
      >
        <div class="mb-5 flex items-start justify-between gap-4">
          <div class="flex items-center gap-3">
            <div
              class="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-cyan-500 to-blue-600 text-white shadow-lg"
            >
              <i class="fas fa-object-group" />
            </div>
            <div>
              <h3 class="text-xl font-bold text-gray-900 dark:text-gray-100">粘滞会话分组</h3>
              <p class="mt-1 text-sm text-gray-500 dark:text-gray-400">
                同一 session 优先在原分组内故障切换；整组不可用时才放开到其他账户
              </p>
            </div>
          </div>
          <button
            class="rounded-lg p-2 text-gray-400 hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-gray-700 dark:hover:text-gray-200"
            @click="emit('close')"
          >
            <i class="fas fa-times" />
          </button>
        </div>

        <div class="mb-5 flex flex-wrap items-center justify-between gap-3">
          <div class="flex rounded-xl bg-gray-100 p-1 dark:bg-gray-800">
            <button
              v-for="platform in platforms"
              :key="platform.value"
              :class="[
                'rounded-lg px-4 py-2 text-sm font-medium transition',
                activePlatform === platform.value
                  ? 'bg-white text-cyan-700 shadow-sm dark:bg-gray-700 dark:text-cyan-300'
                  : 'text-gray-500 hover:text-gray-800 dark:text-gray-400 dark:hover:text-gray-200'
              ]"
              @click="activePlatform = platform.value"
            >
              {{ platform.label }}
              <span class="ml-1 text-xs opacity-70">({{ platformCount(platform.value) }})</span>
            </button>
          </div>
          <button
            class="btn btn-primary flex items-center px-4 py-2.5 text-sm font-semibold"
            @click="openCreate"
          >
            <i class="fas fa-plus mr-2" />新建分组
          </button>
        </div>

        <div v-if="loading" class="py-16 text-center text-gray-500">
          <i class="fas fa-spinner fa-spin mb-3 text-2xl text-cyan-500" />
          <p>正在加载...</p>
        </div>
        <div
          v-else-if="filteredGroups.length === 0"
          class="rounded-2xl border border-dashed border-gray-300 py-14 text-center dark:border-gray-600"
        >
          <i class="fas fa-object-group mb-3 text-4xl text-gray-300 dark:text-gray-600" />
          <p class="text-gray-500 dark:text-gray-400">当前平台还没有粘滞分组</p>
        </div>
        <div v-else class="grid gap-4 md:grid-cols-2">
          <article
            v-for="group in filteredGroups"
            :key="group.id"
            class="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm transition hover:-translate-y-0.5 hover:shadow-md dark:border-gray-700 dark:bg-gray-800"
          >
            <div class="flex items-start justify-between gap-3">
              <div class="min-w-0">
                <h4 class="truncate font-semibold text-gray-900 dark:text-gray-100">
                  {{ group.name }}
                </h4>
                <p class="mt-1 min-h-10 text-sm text-gray-500 dark:text-gray-400">
                  {{ group.description || '暂无描述' }}
                </p>
              </div>
              <span
                class="shrink-0 rounded-full bg-cyan-50 px-2.5 py-1 text-xs font-medium text-cyan-700 dark:bg-cyan-900/30 dark:text-cyan-300"
              >
                {{ group.memberCount || 0 }} 个成员
              </span>
            </div>
            <div
              class="mt-4 flex items-center justify-between border-t border-gray-100 pt-4 dark:border-gray-700"
            >
              <span class="text-xs text-gray-400">{{ platformLabel(group.platform) }}</span>
              <div class="flex gap-2">
                <button
                  class="rounded-lg px-3 py-1.5 text-sm text-blue-600 hover:bg-blue-50 dark:text-blue-400 dark:hover:bg-blue-900/20"
                  @click="openEdit(group)"
                >
                  <i class="fas fa-pen mr-1" />编辑成员
                </button>
                <button
                  class="rounded-lg px-3 py-1.5 text-sm text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-900/20"
                  @click="requestDelete(group)"
                >
                  <i class="fas fa-trash mr-1" />删除
                </button>
              </div>
            </div>
          </article>
        </div>
      </div>
    </div>

    <div v-if="showForm" class="modal fixed inset-0 z-[60] flex items-center justify-center p-3">
      <div
        class="modal-content custom-scrollbar max-h-[92vh] w-full max-w-2xl overflow-y-auto p-5 sm:p-6"
      >
        <div class="mb-5 flex items-center justify-between">
          <h3 class="text-lg font-bold text-gray-900 dark:text-gray-100">
            {{ editingId ? '编辑粘滞分组' : '新建粘滞分组' }}
          </h3>
          <button class="text-gray-400 hover:text-gray-600" @click="closeForm">
            <i class="fas fa-times" />
          </button>
        </div>

        <div class="space-y-5">
          <div>
            <label class="mb-2 block text-sm font-semibold text-gray-700 dark:text-gray-300">
              分组名称 *
            </label>
            <input
              v-model.trim="form.name"
              class="form-input w-full"
              placeholder="例如：Kimi Console"
            />
          </div>
          <div>
            <label class="mb-2 block text-sm font-semibold text-gray-700 dark:text-gray-300">
              平台
            </label>
            <select
              v-model="form.platform"
              class="form-input w-full"
              :disabled="!!editingId"
              @change="loadAccounts"
            >
              <option v-for="platform in platforms" :key="platform.value" :value="platform.value">
                {{ platform.label }}
              </option>
            </select>
          </div>
          <div>
            <label class="mb-2 block text-sm font-semibold text-gray-700 dark:text-gray-300">
              描述
            </label>
            <textarea
              v-model.trim="form.description"
              class="form-input w-full resize-none"
              rows="2"
            />
          </div>

          <div>
            <div class="mb-2 flex items-center justify-between">
              <label class="text-sm font-semibold text-gray-700 dark:text-gray-300">成员账户</label>
              <span class="text-xs text-gray-500">已选择 {{ form.memberIds.length }} 个</span>
            </div>
            <p class="mb-3 text-xs text-gray-500 dark:text-gray-400">
              全局总开关开启时，分组成员将自动启用组内粘滞；移出后恢复账户原策略。一个账户只能属于一个粘滞分组。
            </p>
            <div
              v-if="accountsLoading"
              class="rounded-xl border border-gray-200 py-8 text-center text-gray-500 dark:border-gray-700"
            >
              <i class="fas fa-spinner fa-spin" />
            </div>
            <div
              v-else
              class="custom-scrollbar max-h-72 space-y-2 overflow-y-auto rounded-xl border border-gray-200 p-2 dark:border-gray-700"
            >
              <label
                v-for="account in eligibleAccounts"
                :key="account.id"
                class="flex cursor-pointer items-center justify-between gap-3 rounded-lg px-3 py-2 hover:bg-gray-50 dark:hover:bg-gray-700/60"
              >
                <span class="flex min-w-0 items-center gap-3">
                  <input v-model="form.memberIds" type="checkbox" :value="account.id" />
                  <span class="min-w-0">
                    <span class="block truncate text-sm text-gray-800 dark:text-gray-200">
                      {{ account.name }}
                    </span>
                    <span class="text-xs text-gray-400">
                      {{ account.status }} · {{ account.isActive ? '启用' : '停用' }}
                    </span>
                  </span>
                </span>
                <span
                  v-if="memberOwner(account.id) && memberOwner(account.id).id !== editingId"
                  class="shrink-0 rounded bg-amber-50 px-2 py-1 text-xs text-amber-700 dark:bg-amber-900/30 dark:text-amber-300"
                >
                  当前：{{ memberOwner(account.id).name }}
                </span>
              </label>
              <p
                v-if="eligibleAccounts.length === 0"
                class="py-6 text-center text-sm text-gray-500"
              >
                暂无可配置的共享池账户
              </p>
            </div>
          </div>

          <div class="flex gap-3 pt-2">
            <button
              class="btn btn-primary flex-1 px-4 py-2.5 font-semibold"
              :disabled="saving || !form.name"
              @click="saveGroup"
            >
              <i class="mr-2" :class="saving ? 'fas fa-spinner fa-spin' : 'fas fa-save'" />
              {{ saving ? '保存中...' : '保存' }}
            </button>
            <button class="btn btn-secondary flex-1 px-4 py-2.5" @click="closeForm">取消</button>
          </div>
        </div>
      </div>
    </div>

    <ConfirmModal
      cancel-text="取消"
      confirm-text="删除分组"
      :message="`删除“${deletingGroup?.name || ''}”后，其成员将变为未分组。已有 session 在整组不可用时会按全池规则继续路由。`"
      :show="!!deletingGroup"
      title="确认删除粘滞分组"
      type="danger"
      @cancel="deletingGroup = null"
      @confirm="confirmDelete"
    />
  </Teleport>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue'
import { showToast } from '@/utils/tools'
import * as httpApis from '@/utils/http_apis'
import ConfirmModal from '@/components/common/ConfirmModal.vue'

const emit = defineEmits(['close', 'refresh'])

const platforms = [
  { value: 'claude-console', label: 'Anthropic Console' },
  { value: 'openai-responses', label: 'ChatGPT Responses' }
]
const activePlatform = ref('claude-console')
const groups = ref([])
const loading = ref(false)
const showForm = ref(false)
const editingId = ref(null)
const saving = ref(false)
const deletingGroup = ref(null)
const eligibleAccounts = ref([])
const accountsLoading = ref(false)
const form = ref({ name: '', description: '', platform: 'claude-console', memberIds: [] })

const filteredGroups = computed(() =>
  groups.value.filter((group) => group.platform === activePlatform.value)
)

const platformLabel = (platform) =>
  platforms.find((item) => item.value === platform)?.label || platform
const platformCount = (platform) =>
  groups.value.filter((group) => group.platform === platform).length
const memberOwner = (accountId) =>
  groups.value.find((group) => (group.memberIds || []).includes(accountId)) || null

const assertSuccess = (result, message) => {
  if (!result?.success) throw new Error(result?.message || result?.error || message)
  return result
}

const loadGroups = async () => {
  loading.value = true
  try {
    const result = assertSuccess(await httpApis.getStickySessionGroupsApi(), '加载分组失败')
    groups.value = result.data || []
  } catch (error) {
    showToast(error.message, 'error')
  } finally {
    loading.value = false
  }
}

const loadAccounts = async () => {
  accountsLoading.value = true
  try {
    const result = assertSuccess(
      await httpApis.getStickySessionGroupAccountsApi(form.value.platform),
      '加载账户失败'
    )
    eligibleAccounts.value = result.data || []
  } catch (error) {
    eligibleAccounts.value = []
    showToast(error.message, 'error')
  } finally {
    accountsLoading.value = false
  }
}

const openCreate = async () => {
  editingId.value = null
  form.value = { name: '', description: '', platform: activePlatform.value, memberIds: [] }
  showForm.value = true
  await loadAccounts()
}

const openEdit = async (group) => {
  editingId.value = group.id
  form.value = {
    name: group.name,
    description: group.description || '',
    platform: group.platform,
    memberIds: [...(group.memberIds || [])]
  }
  showForm.value = true
  await loadAccounts()
}

const closeForm = () => {
  showForm.value = false
  editingId.value = null
}

const saveGroup = async () => {
  saving.value = true
  try {
    const payload = { ...form.value }
    const result = editingId.value
      ? await httpApis.updateStickySessionGroupApi(editingId.value, payload)
      : await httpApis.createStickySessionGroupApi(payload)
    assertSuccess(result, '保存分组失败')
    showToast('粘滞分组已保存', 'success')
    activePlatform.value = form.value.platform
    closeForm()
    await loadGroups()
    emit('refresh')
  } catch (error) {
    showToast(error.message, 'error')
  } finally {
    saving.value = false
  }
}

const requestDelete = (group) => {
  deletingGroup.value = group
}

const confirmDelete = async () => {
  try {
    const result = await httpApis.deleteStickySessionGroupApi(deletingGroup.value.id)
    assertSuccess(result, '删除分组失败')
    deletingGroup.value = null
    showToast('粘滞分组已删除', 'success')
    await loadGroups()
    emit('refresh')
  } catch (error) {
    showToast(error.message, 'error')
  }
}

onMounted(loadGroups)
</script>
