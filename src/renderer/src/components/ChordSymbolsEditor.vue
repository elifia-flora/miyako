<script setup lang="ts">
/**
 * 和弦符号补全词表编辑器（`data/vocab/chord-symbols.json`）。
 *
 * 只在**字母和弦泳道**的输入补全里用：候选 = 音名 × 变音记号 × 性质。
 * 与标签词表分开是刻意的 —— 那是「树 + 维度 + 别名」，这是笛卡尔积，
 * 混在一起会让 loadVocab 多出一个假维度。
 *
 * 三张表：`letters`（七个音名，不带升降号）、`accidentals`（还原 / ♯ / ♭ / 𝄪 / 𝄫）、
 * `qualities`（后缀 + 说明 + 是否常用）。保存走主进程校验（空说明、重复项都在那边报错），
 * 这里只负责收集与展示。数组顺序就是补全顺序，用每行的 ↑↓ 调整。
 *
 * 保存前必须深拷贝成纯 JSON：Vue 的响应式数组是 Proxy，Electron structured clone
 * 克隆不了，直接送 IPC 会报 `An object could not be cloned.`（这就是以前保存失败的原因）。
 */
import { computed, onMounted, ref } from 'vue';
import { t } from '../i18n';

const api = (window as any).api;
const emit = defineEmits<{ close: [] }>();

const letters = ref<string[]>([]);
const accidentals = ref<{ sign: string; label: string }[]>([]);
const qualities = ref<{ suffix: string; label: string; primary: boolean; aliases: string }[]>([]);
const note = ref('');
const loading = ref(true);
const saving = ref(false);
const error = ref('');
const saved = ref(false);
const askDiscard = ref(false);
/** 打开 / 保存时的快照：用来判断「有没有未保存的改动」 */
const snapshot = ref('');

const FILE = 'data/vocab/chord-symbols.json';

/** 别名在界面里是一行逗号分隔的文本；存盘前拆成数组，空项丢掉 */
function splitAliases(text: string): string[] {
  return String(text ?? '')
    .split(/[,，]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function serialize() {
  return JSON.stringify({
    note: note.value.trim(),
    letters: letters.value.map((r) => r.trim()),
    accidentals: accidentals.value.map((a) => ({ sign: a.sign.trim(), label: a.label.trim() })),
    qualities: qualities.value.map((q) => ({
      suffix: q.suffix.trim(),
      label: q.label.trim(),
      primary: q.primary,
      aliases: splitAliases(q.aliases),
    })),
  });
}

const dirty = computed(() => serialize() !== snapshot.value);

function applyDoc(doc: any) {
  note.value = String(doc?.note ?? '');
  letters.value = Array.isArray(doc?.letters) ? doc.letters.map((x: any) => String(x ?? '')) : [];
  accidentals.value = Array.isArray(doc?.accidentals)
    ? doc.accidentals.map((a: any) => ({ sign: String(a?.sign ?? ''), label: String(a?.label ?? '') }))
    : [];
  qualities.value = Array.isArray(doc?.qualities)
    ? doc.qualities.map((q: any) => ({
        suffix: String(q.suffix ?? ''),
        label: String(q.label ?? ''),
        primary: q.primary === true,
        aliases: Array.isArray(q.aliases) ? q.aliases.join(', ') : String(q.aliases ?? ''),
      }))
    : [];
}

onMounted(async () => {
  try {
    const doc = await api?.chords?.doc?.();
    applyDoc(doc);
    snapshot.value = serialize();
  } catch (e: any) {
    error.value = String(e?.message ?? e);
  } finally {
    loading.value = false;
  }
});

/** 一编辑就把上一次的「已保存 / 错误」收掉，别让旧状态骗人 */
function onEdit() {
  error.value = '';
  saved.value = false;
}

/** 数组内上移 / 下移；顺序就是补全顺序 */
function moveRow<T>(list: T[], i: number, dir: -1 | 1) {
  const j = i + dir;
  if (i < 0 || j < 0 || j >= list.length) return;
  [list[i], list[j]] = [list[j], list[i]];
  onEdit();
}

async function save() {
  if (saving.value) return;
  saving.value = true;
  error.value = '';
  saved.value = false;
  try {
    /**
     * 必须送**纯 JSON**。`letters` / `accidentals` 是 Vue 的响应式数组（Proxy），
     * Electron 的 structured clone 克隆不了 Proxy，会直接抛
     * `An object could not be cloned.` —— 这就是「保存失败」的根因。
     * 深拷贝一次，既去 Proxy 也把 undefined / 函数挡在外面。
     */
    const payload = JSON.parse(
      JSON.stringify({
        note: note.value,
        letters: letters.value,
        accidentals: accidentals.value,
        qualities: qualities.value.map((q) => ({
          suffix: q.suffix,
          label: q.label,
          primary: q.primary,
          aliases: splitAliases(q.aliases),
        })),
      })
    );
    const res = await api?.chords?.save?.(payload);
    if (res?.ok === false) {
      error.value = String(res.error ?? '');
      return;
    }
    // 以主进程回写的规整结果为准：空白行会被跳过、首尾空格会被 trim，
    // 界面不能继续拿旧数组算「有没有改动」。
    if (res?.doc) applyDoc(res.doc);
    snapshot.value = serialize();
    saved.value = true;
    // 网格里的候选是启动时读进内存的：不通知它重读，用户改完还得重启才生效
    window.dispatchEvent(new CustomEvent('ma:prefs', { detail: { key: 'chordSymbols' } }));
  } catch (e: any) {
    error.value = String(e?.message ?? e);
  } finally {
    saving.value = false;
  }
}

/** 有改动先问一句：这个弹窗只有一个「关闭」，误点会把刚编辑的一屏丢掉 */
function requestClose() {
  if (dirty.value) {
    askDiscard.value = true;
    return;
  }
  emit('close');
}

function openFile() {
  void api?.chords?.openFile?.();
}
</script>

<template>
  <div class="cs-mask" @click.self="requestClose">
    <div class="cs-modal" @input="onEdit" @change="onEdit">
      <div class="cs-head">
        <h3>{{ t('chordTable.title') }}</h3>
        <span class="faint tiny">{{ t('chordTable.source') }}：{{ FILE }}</span>
        <span class="grow" />
        <button class="chip" @click="openFile">{{ t('chordTable.openFile') }}</button>
        <button class="chip" @click="requestClose">{{ t('chordTable.close') }}</button>
      </div>
      <p class="faint tiny cs-note">{{ t('chordTable.note') }}</p>

      <div class="cs-cols">
        <section class="cs-sec cs-left">
          <div class="cs-h">{{ t('chordTable.letters') }}</div>
          <div class="cs-chips">
            <div v-for="(r, i) in letters" :key="'l' + i" class="cs-chip">
              <input v-model="letters[i]" class="cs-letter" spellcheck="false" maxlength="1" />
              <button class="cs-move" :disabled="i === 0" :title="t('chordTable.moveUp')" @click="moveRow(letters, i, -1)">↑</button>
              <button class="cs-move" :disabled="i === letters.length - 1" :title="t('chordTable.moveDown')" @click="moveRow(letters, i, 1)">↓</button>
              <button class="cs-x" :title="t('grid.delete')" @click="letters.splice(i, 1)">×</button>
            </div>
            <button class="chip" @click="letters.push('')">{{ t('chordTable.addLetter') }}</button>
          </div>

          <div class="cs-h">{{ t('chordTable.accidentals') }}</div>
          <div class="cs-acc-list">
            <div v-for="(a, i) in accidentals" :key="'a' + i" class="cs-chip cs-acc">
              <input
                v-model="accidentals[i].sign"
                class="cs-sign"
                spellcheck="false"
                :placeholder="t('chordTable.signPh')"
                :title="t('chordTable.signHint')"
              />
              <input v-model="accidentals[i].label" class="cs-acc-name" :placeholder="t('chordTable.label')" />
              <button class="cs-move" :disabled="i === 0" :title="t('chordTable.moveUp')" @click="moveRow(accidentals, i, -1)">↑</button>
              <button class="cs-move" :disabled="i === accidentals.length - 1" :title="t('chordTable.moveDown')" @click="moveRow(accidentals, i, 1)">↓</button>
              <button class="cs-x" :title="t('grid.delete')" @click="accidentals.splice(i, 1)">×</button>
            </div>
            <button class="chip" @click="accidentals.push({ sign: '', label: '' })">
              {{ t('chordTable.addAccidental') }}
            </button>
          </div>
        </section>

        <section class="cs-sec cs-grow">
          <div class="cs-h">{{ t('chordTable.qualities') }} <span class="faint tiny">{{ t('chordTable.orderHint') }}</span></div>
          <!-- 表格包一层滚动容器：列宽固定，放不下时在**这个容器里**横向滚，
               不会把整块推到弹窗外（以前就是这个毛病，「性质」那一列看不见） -->
          <div class="cs-tablewrap">
            <table class="cs-table">
              <thead>
                <tr>
                  <th>{{ t('chordTable.suffix') }}</th>
                  <th :title="t('chordTable.aliasesPh')">{{ t('chordTable.aliases') }}</th>
                  <th>{{ t('chordTable.label') }}</th>
                  <th :title="t('chordTable.primaryHint')">{{ t('chordTable.primary') }}</th>
                  <th>{{ t('chordTable.order') }}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                <tr v-for="(q, i) in qualities" :key="'q' + i">
                  <td>
                    <input
                      v-model="q.suffix"
                      spellcheck="false"
                      :placeholder="t('chordTable.suffixEmpty')"
                    />
                  </td>
                  <td>
                    <input
                      v-model="q.aliases"
                      class="cs-alias"
                      spellcheck="false"
                    />
                  </td>
                  <td><input v-model="q.label" :placeholder="t('chordTable.label')" /></td>
                  <td class="cs-center"><input v-model="q.primary" type="checkbox" /></td>
                  <td class="cs-order">
                    <button class="cs-move" :disabled="i === 0" :title="t('chordTable.moveUp')" @click="moveRow(qualities, i, -1)">↑</button>
                    <button class="cs-move" :disabled="i === qualities.length - 1" :title="t('chordTable.moveDown')" @click="moveRow(qualities, i, 1)">↓</button>
                  </td>
                  <td><button class="cs-x" :title="t('grid.delete')" @click="qualities.splice(i, 1)">×</button></td>
                </tr>
              </tbody>
            </table>
          </div>
          <button class="chip" @click="qualities.push({ suffix: '', label: '', primary: false, aliases: '' })">
            {{ t('chordTable.addQuality') }}
          </button>
        </section>
      </div>

      <div class="cs-foot">
        <span v-if="loading" class="faint tiny">…</span>
        <span v-else-if="error" class="cs-err">{{ error }}</span>
        <span v-else-if="saved && !dirty" class="faint tiny">{{ t('chordTable.saved', { file: FILE }) }}</span>
        <span v-else-if="askDiscard" class="cs-err">{{ t('chordTable.discard') }}</span>
        <span class="grow" />
        <template v-if="askDiscard">
          <button class="chip danger solid" @click="emit('close')">{{ t('chordTable.close') }}</button>
          <button class="chip" @click="askDiscard = false">{{ t('common.cancel') }}</button>
        </template>
        <button v-else class="chip danger solid" :disabled="saving || loading" @click="save">
          {{ t('chordTable.save') }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.cs-mask {
  position: fixed; inset: 0; z-index: 40;
  display: flex; align-items: center; justify-content: center;
  background: rgba(0, 0, 0, 0.45);
}
.cs-modal {
  width: min(1040px, 94vw); max-height: 84vh;
  display: flex; flex-direction: column;
  background: var(--surface); color: var(--text);
  border: 1px solid var(--line-strong); border-radius: 8px;
  box-shadow: var(--shadow); padding: 14px 16px;
}
.cs-head { display: flex; align-items: center; gap: 10px; }
.cs-head h3 { margin: 0; font-size: 14px; font-weight: 600; }
.cs-note { margin: 6px 0 10px; }
/* 左列（音名 / 变音）**限宽**，右列吃剩下的：以前左列按内容撑到最宽，
   把「性质」整张表推出弹窗外，右边那一列根本看不见 */
.cs-cols {
  display: grid;
  grid-template-columns: minmax(200px, 300px) minmax(0, 1fr);
  gap: 18px; min-height: 0; flex: 1;
}
.cs-sec { display: flex; flex-direction: column; min-height: 0; min-width: 0; gap: 8px; }
.cs-left { gap: 6px; overflow: auto; }
.cs-grow { min-width: 0; }
.cs-h { font-size: 12px; color: var(--text-dim); font-weight: 600; }
.cs-chips { display: flex; flex-wrap: wrap; gap: 6px; align-content: flex-start; }
.cs-chip { display: flex; align-items: center; gap: 2px; }
.cs-chip input {
  height: 22px; padding: 0 4px; font-size: 12px;
  background: var(--bg); color: var(--text);
  border: 1px solid var(--line); border-radius: 3px;
}
.cs-chip input.cs-letter { width: 42px; text-align: center; }
.cs-acc-list { display: flex; flex-direction: column; gap: 4px; }
.cs-acc { width: 100%; }
.cs-acc input.cs-sign { width: 46px; text-align: center; font-size: 13px; }
.cs-acc input.cs-acc-name { flex: 1; min-width: 0; }
.cs-tablewrap { flex: 1; min-height: 0; overflow: auto; }
.cs-table { width: 100%; table-layout: fixed; border-collapse: collapse; }
.cs-table thead th {
  position: sticky; top: 0; z-index: 1;
  background: var(--surface); text-align: left;
  font-size: 11px; font-weight: 500; color: var(--text-dim);
  padding: 3px 6px; border-bottom: 1px solid var(--line);
}
/* 固定列宽：后缀 / 别名 / 说明 / 常用 / 顺序 / 删。不固定的话长说明会把按钮顶出去 */
.cs-table th:nth-child(1) { width: 16%; }
.cs-table th:nth-child(2) { width: 28%; }
.cs-table th:nth-child(3) { width: 34%; }
.cs-table th:nth-child(4) { width: 56px; }
.cs-table th:nth-child(5) { width: 58px; }
.cs-table th:nth-child(6) { width: 30px; }
.cs-table td { padding: 2px 6px; }
.cs-table input[type='text'], .cs-table input:not([type]) {
  width: 100%; height: 22px; padding: 0 5px; font-size: 12px;
  background: var(--bg); color: var(--text);
  border: 1px solid var(--line); border-radius: 3px;
}
.cs-center { text-align: center; }
.cs-table input[type='checkbox'] { accent-color: var(--accent); }
.cs-order { text-align: center; white-space: nowrap; }
.cs-move {
  width: 16px; height: 18px; line-height: 1;
  color: var(--text-dim); border-radius: 3px;
  font-size: 11px;
}
.cs-move:hover:not(:disabled) { background: var(--sel-bg); color: var(--text); }
.cs-move:disabled { opacity: 0.2; cursor: default; }
.cs-x {
  width: 18px; height: 18px; line-height: 1;
  color: var(--text-faint); border-radius: 3px;
}
.cs-x:hover { background: var(--sel-bg); color: var(--text); }
.cs-foot { display: flex; align-items: center; gap: 8px; margin-top: 10px; padding-top: 10px; border-top: 1px solid var(--line); }
.cs-err { color: var(--warn); font-size: 11.5px; }
.grow { flex: 1; }
</style>
