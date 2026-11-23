<script setup lang="ts">
/**
 * 小节.拍.十六分.tick 的固定格子显示。
 *
 * 详情面板「时间轴 · 段落」和播放条的主时间都走这一份，避免两处样式漂移。
 * 规则：小节预留 4ch、拍 2ch、十六分 2ch、tick 3ch，全部右对齐；
 * 点号固定、数字不补 0 —— Cubase 那种「点的位置不动，数字长短不跳」的观感。
 */
defineProps<{ pos: { bar: number; beat: number; sixteenth: number; sub: number } }>();
</script>

<template>
  <span class="bb-tc">
    <i class="f-bar">{{ pos.bar }}</i><em>.</em>
    <i class="f-beat">{{ pos.beat }}</i><em>.</em>
    <i class="f-16">{{ pos.sixteenth }}</i><em>.</em>
    <i class="f-tick">{{ pos.sub }}</i>
  </span>
</template>

<style scoped>
.bb-tc {
  display: inline-flex;
  align-items: baseline;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.bb-tc i { font-style: normal; }
.bb-tc em { font-style: normal; opacity: 0.5; }
/* f- 前缀是刻意的：单字母类（尤其 .k）在别的组件里有全局样式，别撞 */
.bb-tc .f-bar { width: 4ch; text-align: right; }
.bb-tc .f-beat { width: 2ch; text-align: right; }
.bb-tc .f-16 { width: 2ch; text-align: right; }
.bb-tc .f-tick { width: 3ch; text-align: right; }
</style>
