<script setup lang="ts">
/**
 * 把和弦描述里的**双变音记号**（𝄪 / 𝄫）单独放大一点再显示。
 *
 * 为什么需要它：这两个字在 11~12px 下墨迹只有 3px 宽，`C𝄪 属七（C𝄪–E𝄪–G𝄪–B♯）`
 * 读起来像一串细线。canvas 那边用 `paintChordText` 放大 25%；这里是 DOM 的那一份
 * （选区条里的解析说明），用 span 放大 —— 但只能放大记号本身，整串字变大就成了另一个层级。
 *
 * 注意 `𝄪`/`𝄫` 是**代理对**：字符类 `[𝄪𝄫]` 会按 code unit 把它们劈成两半（渲染成 .notdef），
 * 所以这里用「择一」`(𝄪|𝄫)` 来切。
 */
import { computed } from 'vue';

const props = defineProps<{ text?: string | null }>();

const SEG = /(𝄪|𝄫)/;

const parts = computed(() =>
  String(props.text ?? '')
    .split(SEG)
    .filter((s) => s !== '')
    .map((s) => ({ s, big: s === '𝄪' || s === '𝄫' }))
);
</script>

<template>
  <span class="chord-text"
    ><template v-for="(p, i) in parts" :key="i"
      ><span v-if="p.big" class="acc2">{{ p.s }}</span
      ><template v-else>{{ p.s }}</template></template
    ></span
  >
</template>

<style scoped>
/* 只放大记号。`line-height: 0` 让它的行盒不撑高父容器（选区条是固定 26px），
   竖向上靠 `vertical-align` 把它拉回到和字母同一条中线附近 */
/* 这两个字的**墨迹只占 em 框上半截**（它是照五线谱的临时记号设计的），所以光放大字号
   会变成「一个字上标」：既不像字母、也没真的变大。放大 2 倍再用 translateY 压下来，
   让它落在字母的中线上。`line-height: 0` 保证不撑高选区条那 26px 的行。 */
.chord-text .acc2 {
  display: inline-block;
  font-size: 2em;
  font-weight: inherit;
  line-height: 0;
  transform: translateY(2.5px);
}
</style>
