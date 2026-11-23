<script setup lang="ts">
/**
 * 时间格式图标：
 *   小节.拍 → 四分音符；时间码 → TC；毫秒 → 时钟。
 *
 * 用 SVG 画时钟而不是 emoji：⏰/🕒 在 Windows 上会被 Segoe UI Emoji 接走，
 * 变成蓝色表情方块，和 Cubase 式的小图标完全不搭。
 */
defineProps<{ format: 'bars' | 'timecode' | 'ms' }>();
</script>

<template>
  <span class="tfi" :class="format" aria-hidden="true">
    <template v-if="format === 'bars'">♩</template>
    <template v-else-if="format === 'timecode'">TC</template>
    <svg v-else viewBox="0 0 12 12">
      <circle cx="6" cy="6" r="4.55" fill="none" stroke="currentColor" stroke-width="1.15" />
      <path d="M6 3.25V6l1.9 1.25" fill="none" stroke="currentColor" stroke-width="1.15" stroke-linecap="round" />
    </svg>
  </span>
</template>

<style scoped>
.tfi {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 13px;
  flex: none;
  color: var(--text-dim);
  font-size: 11px;
  line-height: 1;
}
.tfi.timecode {
  font-size: 8.5px;
  font-weight: 600;
  letter-spacing: -0.03em;
}
.tfi svg { width: 12px; height: 12px; }
</style>
