<template>
  <div class="overflow-hidden rounded-lg bg-gray-950 shadow-inner ring-1 ring-white/10">
    <div
      class="flex items-center justify-between gap-3 border-b border-white/10 bg-white/5 px-3 py-2"
    >
      <span class="text-[11px] font-semibold uppercase tracking-wide text-gray-400">
        {{ languageLabel }}
      </span>
      <button
        class="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium text-gray-300 transition-colors hover:bg-white/10 hover:text-white"
        title="复制代码"
        type="button"
        @click="copyCode"
      >
        <i class="fas fa-copy text-[11px]" />
        <span>复制</span>
      </button>
    </div>
    <pre
      class="max-h-96 overflow-x-auto p-3 text-xs leading-relaxed text-gray-100 sm:p-4 sm:text-sm"
    ><code :class="codeClass">{{ normalizedCode }}</code></pre>
  </div>
</template>

<script setup>
import { computed } from 'vue'
import { copyText } from '@/utils/tools'

const props = defineProps({
  code: {
    type: String,
    required: true
  },
  language: {
    type: String,
    default: 'text'
  },
  label: {
    type: String,
    default: ''
  }
})

const normalizedCode = computed(() => String(props.code || '').replace(/\n$/, ''))
const languageLabel = computed(() => props.label || props.language)
const codeClass = computed(() => `language-${props.language}`)

const copyCode = () => copyText(normalizedCode.value, '代码已复制')
</script>
