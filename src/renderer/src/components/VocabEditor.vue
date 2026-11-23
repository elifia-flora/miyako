<script setup lang="ts">
/**
 * VocabEditor — 词表（data/vocab/*.json）的图形编辑器。
 *
 * 为什么要有它：词表是 JSON 源文件，改一个中文名要开编辑器、找对缩进、
 * 还要小心别把 aliases 写成字符串。这个面板把「结构」收在主进程，
 * 用户只改内容（显示名 / 原名 / 别名 / 外语翻译 / 所属分组），
 * 保存时整棵树回传、逐节点校验后落盘。
 *
 * 三类人各有出口：
 * - 普通用户：点侧栏 → 改 → 保存，不用碰 JSON；
 * - 维护人员：右上「打开 JSON 文件」直接调系统编辑器看原文；
 * - 测试：`.ve-modal` / `.ve-table` / `.ve-save` 这些类名是稳定的。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import ConfirmDialog from './ConfirmDialog.vue';
import { t } from '../i18n';

const api = (window as any).api;
const props = defineProps<{ dim: string }>();
const emit = defineEmits<{ close: []; saved: [payload: any] }>();

interface TNode {
  id: string;
  name: string;
  display?: string | null;
  aliases?: string[];
  translations?: Record<string, string>;
  note?: string;
  children?: TNode[];
}

interface Entry {
  node: TNode;
  depth: number;
  rootId: string;
  parent: TNode[] | null;
}

const DIM_KEYS = new Set(['instrument', 'instrument_technique', 'composition', 'genre', 'period', 'mood', 'form', 'composition_type']);

const roots = ref<TNode[]>([]);
const refs = ref<Record<string, number>>({});
const docInfo = ref<{ file: string; note: string } | null>(null);
const snapshot = ref('');
const busy = ref(false);
const saving = ref(false);
const loadError = ref('');
const saveError = ref<any>(null);
const savedNote = ref('');

const q = ref('');
const groupId = ref('*');
const selectedId = ref('');
const aliasText = ref('');
const trRows = ref<{ lang: string; text: string }[]>([]);
const newIds = ref<Set<string>>(new Set());
const askDiscard = ref<null | 'close' | 'reload'>(null);

const dimLabel = computed(() => (DIM_KEYS.has(props.dim) ? t(`dim.${props.dim}`) : props.dim));

/** 整棵树摊平：表格要按分组筛，还要知道每一行挂在谁下面（移动分组用） */
function flatten(list: TNode[], depth = 0, rootId = '', parent: TNode[] | null = null, out: Entry[] = []): Entry[] {
  for (const node of list) {
    const rid = depth === 0 ? node.id : rootId;
    out.push({ node, depth, rootId: rid, parent });
    if (node.children?.length) flatten(node.children, depth + 1, rid, node.children, out);
  }
  return out;
}

const entries = computed(() => flatten(roots.value));

const activeEntry = computed(() => entries.value.find((e) => e.node.id === selectedId.value) ?? null);
const activeNode = computed(() => activeEntry.value?.node ?? null);
const isNew = computed(() => newIds.value.has(activeNode.value?.id ?? ''));
const dirty = computed(() => snapshot.value !== '' && JSON.stringify(roots.value) !== snapshot.value);

const list = computed(() => {
  const term = q.value.trim().toLowerCase();
  return entries.value.filter((e) => {
    if (groupId.value !== '*' && e.rootId !== groupId.value) return false;
    if (!term) return true;
    const n = e.node;
    const hay = [n.id, n.name, n.display ?? '', ...(n.aliases ?? []), ...Object.values(n.translations ?? {})]
      .join(' ')
      .toLowerCase();
    return hay.includes(term);
  });
});

const canDelete = computed(() => {
  const e = activeEntry.value;
  if (!e || e.depth === 0) return false;
  if (e.node.children?.length) return false;
  return (refs.value[e.node.id] ?? 0) === 0;
});

const deleteReason = computed(() => {
  const e = activeEntry.value;
  if (!e) return '';
  if (e.depth === 0) return t('vocab.deleteBlockedRoot');
  if (e.node.children?.length) return t('vocab.deleteBlockedChildren');
  const n = refs.value[e.node.id] ?? 0;
  return n > 0 ? t('vocab.deleteBlockedRefs', { n }) : t('vocab.removeHint');
});

function countUnder(root: TNode): number {
  return flatten([root]).length - 1;
}

function syncFields() {
  const n = activeNode.value;
  aliasText.value = (n?.aliases ?? []).join(', ');
  trRows.value = Object.entries(n?.translations ?? {}).map(([lang, text]) => ({ lang, text }));
}

watch(selectedId, syncFields);

async function load(keep = '') {
  busy.value = true;
  loadError.value = '';
  saveError.value = null;
  savedNote.value = '';
  try {
    const d = await api.vocab.doc(props.dim);
    roots.value = JSON.parse(JSON.stringify(d.roots ?? []));
    refs.value = d.refs ?? {};
    docInfo.value = { file: d.file, note: d.note ?? '' };
    snapshot.value = JSON.stringify(roots.value);
    newIds.value = new Set();

    const stillThere = keep && flatten(roots.value).some((e) => e.node.id === keep);
    if (stillThere) selectedId.value = keep;
    else if (!flatten(roots.value).some((e) => e.node.id === selectedId.value)) selectedId.value = '';
    if (!selectedId.value) selectedId.value = flatten(roots.value).find((e) => e.depth > 0)?.node.id ?? '';
    syncFields();
  } catch (err: any) {
    loadError.value = String(err?.message ?? err);
  } finally {
    busy.value = false;
  }
}

function reload() {
  if (dirty.value) askDiscard.value = 'reload';
  else void load(selectedId.value);
}

function requestClose() {
  if (dirty.value) askDiscard.value = 'close';
  else emit('close');
}

function confirmDiscard() {
  const what = askDiscard.value;
  askDiscard.value = null;
  if (what === 'close') emit('close');
  if (what === 'reload') void load(selectedId.value);
}

function onAliasInput() {
  const n = activeNode.value;
  if (!n) return;
  // 逗号、分号、换行都当分隔符：用户从别处粘一串别名进来不用先排版
  n.aliases = aliasText.value
    .split(/[,，;；\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function applyTr() {
  const n = activeNode.value;
  if (!n) return;
  const map: Record<string, string> = {};
  for (const row of trRows.value) {
    const lang = row.lang.trim().toLowerCase();
    const text = row.text.trim();
    if (lang && text) map[lang] = text;
  }
  n.translations = map;
}

function addTr() {
  trRows.value.push({ lang: '', text: '' });
  nextTick(() => {
    const inputs = document.querySelectorAll<HTMLInputElement>('.ve-form .ve-lang');
    inputs[inputs.length - 1]?.focus();
  });
}

function removeTr(i: number) {
  trRows.value.splice(i, 1);
  applyTr();
}

function onIdInput(ev: Event) {
  const n = activeNode.value;
  if (!n || !isNew.value) return;
  const next = (ev.target as HTMLInputElement).value.trim();
  newIds.value.delete(n.id);
  newIds.value.add(next);
  n.id = next;
  selectedId.value = next;
}

function onParentChange(targetRootId: string) {
  const e = activeEntry.value;
  if (!e || e.depth === 0 || !e.parent || e.rootId === targetRootId) return;
  const target = roots.value.find((r) => r.id === targetRootId);
  if (!target) return;
  const idx = e.parent.indexOf(e.node);
  if (idx >= 0) e.parent.splice(idx, 1);
  (target.children ??= []).push(e.node);
}

function select(node: TNode) {
  selectedId.value = node.id;
}

function addEntry() {
  const root = roots.value.find((r) => r.id === (groupId.value === '*' ? roots.value[0]?.id : groupId.value));
  if (!root) return;
  let n = 1;
  let id = '';
  do {
    id = `custom-${n++}`;
  } while (entries.value.some((e) => e.node.id === id));
  const node: TNode = {
    id,
    name: 'new entry',
    display: t('vocab.newEntryName'),
    aliases: [],
    translations: {},
    children: [],
  };
  (root.children ??= []).push(node);
  newIds.value.add(id);
  selectedId.value = id;
  nextTick(() => {
    const el = document.querySelector<HTMLInputElement>('.ve-form .ve-display');
    el?.focus();
    el?.select();
  });
}

function removeSelected() {
  const e = activeEntry.value;
  if (!e || !e.parent || !canDelete.value) return;
  const idx = e.parent.indexOf(e.node);
  if (idx >= 0) e.parent.splice(idx, 1);
  selectedId.value = '';
  aliasText.value = '';
  trRows.value = [];
}

async function save() {
  if (saving.value || !dirty.value) return;
  saving.value = true;
  saveError.value = null;
  savedNote.value = '';
  try {
    const res = await api.vocab.save(props.dim, JSON.parse(JSON.stringify(roots.value)));
    if (!res?.ok) {
      saveError.value = res;
      return;
    }
    savedNote.value = t('vocab.saved', { tags: res.tags ?? 0, aliases: res.aliases ?? 0 });
    const keep = selectedId.value;
    await load(keep);
    emit('saved', res);
  } catch (err: any) {
    saveError.value = { ok: false, code: 'io', detail: String(err?.message ?? err) };
  } finally {
    saving.value = false;
  }
}

function issueText(i: any): string {
  const id = i?.id || '—';
  switch (i?.code) {
    case 'badId':
      return t('vocab.err.badId', { id });
    case 'dupId':
      return t('vocab.err.dupId', { id });
    case 'takenId':
      return t('vocab.err.takenId', { id });
    case 'noName':
      return t('vocab.err.noName', { id });
    case 'badAliases':
      return t('vocab.err.badAliases', { id });
    case 'badTranslations':
      return t('vocab.err.badTranslations', { id });
    case 'tooDeep':
      return t('vocab.err.tooDeep', { id });
    case 'badShape':
      return t('vocab.err.badShape');
    default:
      return String(i?.code ?? '');
  }
}

const saveErrorText = computed(() => {
  const e = saveError.value;
  if (!e) return '';
  if (e.code === 'invalid') return (e.issues ?? []).map(issueText).join('；');
  if (e.code === 'referenced') {
    const ids = (e.refs ?? []).map((r: any) => `${r.id} (${r.count})`).join('、');
    return t('vocab.err.referenced', { ids });
  }
  if (e.code === 'unknownDim') return t('vocab.err.unknownDim');
  if (e.code === 'badShape') return t('vocab.err.badShape');
  return e.detail || String(e.code);
});

function openJson() {
  if (docInfo.value) void api.vocab.openFile(props.dim);
}

function onKey(ev: KeyboardEvent) {
  if (ev.key === 'Escape' && !askDiscard.value) {
    ev.preventDefault();
    ev.stopPropagation();
    requestClose();
  }
}

onMounted(() => {
  window.addEventListener('keydown', onKey, true);
  void load();
});
onBeforeUnmount(() => window.removeEventListener('keydown', onKey, true));
</script>

<template>
  <div class="ve-mask" @click.self="requestClose">
    <div class="ve-modal">
      <header class="ve-head">
        <div class="ve-title">
          <h3>{{ t('vocab.title', { dim: dimLabel }) }}</h3>
          <p class="ve-note">{{ t('vocab.note') }}</p>
        </div>
        <div class="ve-actions">
          <button class="chip mono" :title="docInfo?.file ?? ''" @click="openJson">
            {{ t('vocab.openJson') }}
          </button>
          <button class="chip" @click="reload">{{ t('vocab.reload') }}</button>
          <button class="chip" @click="requestClose">{{ t('vocab.close') }}</button>
        </div>
      </header>

      <p v-if="loadError" class="ve-banner err">{{ loadError }}</p>

      <div class="ve-body">
        <aside class="ve-groups">
          <button class="ve-group" :class="{ on: groupId === '*' }" @click="groupId = '*'">
            <span>{{ t('vocab.all') }}</span><em class="num">{{ entries.length }}</em>
          </button>
          <button
            v-for="r in roots"
            :key="r.id"
            class="ve-group"
            :class="{ on: groupId === r.id }"
            @click="groupId = r.id"
          >
            <span>{{ r.display || r.name }}</span><em class="num">{{ countUnder(r) }}</em>
          </button>
        </aside>

        <section class="ve-list">
          <div class="ve-toolbar">
            <input v-model="q" class="ve-search" :placeholder="t('vocab.searchPh')" />
            <button class="chip" :disabled="!roots.length" @click="addEntry">{{ t('vocab.newEntry') }}</button>
          </div>
          <div class="ve-table-wrap">
            <table class="ve-table">
              <thead>
                <tr>
                  <th>{{ t('vocab.colEntry') }}</th>
                  <th>{{ t('vocab.colId') }}</th>
                  <th class="num">{{ t('vocab.colAliases') }}</th>
                  <th class="num">{{ t('vocab.colRefs') }}</th>
                </tr>
              </thead>
              <tbody>
                <tr
                  v-for="e in list"
                  :key="e.node.id + '@' + e.depth"
                  :class="{ on: e.node.id === selectedId, group: e.depth === 0 }"
                  @click="select(e.node)"
                >
                  <td>
                    <span class="ve-indent" :style="{ paddingLeft: e.depth * 10 + 'px' }">
                      {{ e.node.display || e.node.name }}
                    </span>
                  </td>
                  <td class="mono ell">{{ e.node.id }}</td>
                  <td class="num">{{ (e.node.aliases ?? []).length }}</td>
                  <td class="num">{{ refs[e.node.id] ?? 0 }}</td>
                </tr>
                <tr v-if="!list.length">
                  <td colspan="4" class="faint">{{ t('vocab.empty') }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>

        <section class="ve-form">
          <div v-if="activeNode" class="ve-form-inner">
            <div class="ve-row">
              <label>{{ t('vocab.fieldDisplay') }}</label>
              <input v-model="activeNode.display" class="ve-display" />
            </div>
            <div class="ve-row">
              <label>{{ t('vocab.fieldName') }}</label>
              <input v-model="activeNode.name" />
            </div>
            <div class="ve-row">
              <label>id</label>
              <input
                class="mono"
                :value="activeNode.id"
                :readonly="!isNew"
                :title="isNew ? t('vocab.idNewHint') : t('vocab.idLocked')"
                @input="onIdInput"
              />
            </div>
            <div v-if="activeEntry && activeEntry.depth > 0" class="ve-row">
              <label>{{ t('vocab.fieldParent') }}</label>
              <select :value="activeEntry.rootId" @change="onParentChange(($event.target as HTMLSelectElement).value)">
                <option v-for="r in roots" :key="r.id" :value="r.id">{{ r.display || r.name }}</option>
              </select>
            </div>

            <div class="ve-row col">
              <label>{{ t('vocab.fieldAliases') }} <em class="faint">{{ t('vocab.aliasHint') }}</em></label>
              <textarea
                rows="3"
                :value="aliasText"
                @input="aliasText = ($event.target as HTMLTextAreaElement).value; onAliasInput()"
              ></textarea>
            </div>

            <div class="ve-row col">
              <label>{{ t('vocab.fieldTranslations') }}</label>
              <div v-for="(row, i) in trRows" :key="i" class="ve-tr">
                <input v-model="row.lang" class="ve-lang mono" :placeholder="t('vocab.lang')" @input="applyTr" />
                <input v-model="row.text" class="ve-text" :placeholder="t('vocab.translation')" @input="applyTr" />
                <button class="ve-x" :title="t('vocab.removeTranslation')" @click="removeTr(i)">×</button>
              </div>
              <button class="ve-add" @click="addTr">+ {{ t('vocab.addTranslation') }}</button>
            </div>

            <div class="ve-row">
              <label>{{ t('vocab.fieldRefs') }}</label>
              <em class="num">{{ refs[activeNode.id] ?? 0 }}</em>
            </div>

            <button class="ve-del" :disabled="!canDelete" :title="deleteReason" @click="removeSelected">
              {{ t('vocab.remove') }}
            </button>
          </div>
          <p v-else class="faint ve-empty">{{ t('vocab.noSelection') }}</p>
        </section>
      </div>

      <footer class="ve-foot">
        <div class="ve-status">
          <span v-if="dirty" class="warn">{{ t('vocab.dirty') }}</span>
          <span v-else-if="savedNote" class="ok">{{ savedNote }}</span>
          <span v-if="saveErrorText" class="err">{{ t('vocab.err.title') }}{{ saveErrorText }}</span>
        </div>
        <button class="chip primary ve-save" :disabled="!dirty || saving || !!loadError" @click="save">
          {{ saving ? t('vocab.saving') : t('vocab.save') }}
        </button>
      </footer>
    </div>

    <ConfirmDialog
      v-if="askDiscard"
      :title="t('vocab.confirmDiscardTitle')"
      :body="t('vocab.confirmDiscardBody')"
      :ok="t('vocab.discard')"
      @confirm="confirmDiscard"
      @cancel="askDiscard = null"
    />
  </div>
</template>

<style scoped>
.ve-mask {
  position: fixed;
  inset: 0;
  z-index: 60;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.45);
}
.ve-modal {
  display: flex;
  flex-direction: column;
  width: min(1040px, 94vw);
  height: min(640px, 84vh);
  /* 面板高度是定死的，内容再长也只能在里面滚，不允许顶出圆角 */
  overflow: hidden;
  background: var(--surface);
  border: 1px solid var(--line-strong);
  border-radius: 5px;
  box-shadow: var(--shadow);
}
.ve-head {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  padding: 12px 14px 10px;
  border-bottom: 1px solid var(--line);
}
.ve-title { flex: 1; min-width: 0; }
.ve-title h3 { margin: 0; font-size: 13px; font-weight: 500; color: var(--text); }
.ve-note { margin: 4px 0 0; font-size: 10.5px; line-height: 1.45; color: var(--text-faint); }
.ve-actions { flex: none; display: flex; gap: 6px; }
.chip {
  height: 24px;
  padding: 0 10px;
  font-size: 11px;
  color: var(--text-dim);
  border: 1px solid var(--line);
  border-radius: 3px;
  background: var(--surface-2);
}
.chip:hover:not(:disabled) { color: var(--text); border-color: var(--line-strong); }
.chip:disabled { opacity: 0.45; cursor: default; }
.chip.primary {
  color: #fff;
  background: var(--accent);
  border-color: var(--accent);
}
.chip.primary:disabled { opacity: 0.4; }

.ve-banner {
  margin: 0;
  padding: 6px 14px;
  font-size: 11px;
  border-bottom: 1px solid var(--line);
}
.ve-banner.err { color: var(--warn); }

.ve-body {
  flex: 1;
  min-height: 0;
  display: grid;
  grid-template-columns: 150px minmax(240px, 1fr) 320px;
  /**
   * 单行必须显式写成 minmax(0, 1fr)。
   * 写成隐式 auto 行时，行高 = 内容高度，词表条目一多整行就被撑到面板外面去，
   * 三栏的 overflow:auto 全部失效（父级根本没限高，它们没有可滚的空间）。
   */
  grid-template-rows: minmax(0, 1fr);
  overflow: hidden;
}
.ve-groups {
  overflow: auto;
  padding: 6px 0;
  border-right: 1px solid var(--line);
}
.ve-group {
  display: flex;
  justify-content: space-between;
  align-items: center;
  width: 100%;
  height: 24px;
  padding: 0 12px;
  font-size: 11px;
  color: var(--text-dim);
  text-align: left;
}
.ve-group:hover { background: var(--surface-2); color: var(--text); }
.ve-group.on { background: var(--sel-bg); color: var(--text); }
.ve-group em { font-style: normal; color: var(--text-faint); }

.ve-list {
  display: flex;
  flex-direction: column;
  min-width: 0;
  /* grid item 的 min-height 默认是 auto：这里必须归零，表格才能在自己内部滚 */
  min-height: 0;
  border-right: 1px solid var(--line);
}
.ve-toolbar {
  flex: none;
  display: flex;
  gap: 6px;
  padding: 6px 8px;
  border-bottom: 1px solid var(--line);
}
.ve-search { flex: 1; min-width: 0; height: 24px; font-size: 11px; }
.ve-table-wrap { flex: 1; min-height: 0; overflow: auto; }
.ve-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 10.5px;
  table-layout: fixed;
}
.ve-table th {
  position: sticky;
  top: 0;
  z-index: 1;
  padding: 4px 6px;
  font-weight: 400;
  text-align: left;
  color: var(--text-faint);
  background: var(--surface);
  border-bottom: 1px solid var(--line);
}
.ve-table th:nth-child(1) { width: auto; }
.ve-table th:nth-child(2) { width: 116px; }
.ve-table th:nth-child(3) { width: 46px; }
.ve-table th:nth-child(4) { width: 46px; }
.ve-table td {
  padding: 3px 6px;
  border-bottom: 1px solid color-mix(in srgb, var(--line) 55%, transparent);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.ve-table tbody tr { cursor: pointer; }
.ve-table tbody tr:hover { background: var(--surface-2); }
.ve-table tbody tr.on { background: var(--sel-bg); color: var(--text); }
.ve-table tbody tr.group td { color: var(--text-dim); }
.ve-table .num { text-align: right; color: var(--text-faint); }
.ve-indent { display: inline-block; }
.ell { overflow: hidden; text-overflow: ellipsis; }

.ve-form {
  overflow: auto;
  padding: 10px 12px;
}
.ve-form-inner { display: flex; flex-direction: column; gap: 8px; }
.ve-row { display: flex; align-items: center; gap: 8px; }
.ve-row.col { flex-direction: column; align-items: stretch; gap: 4px; }
.ve-row > label {
  flex: none;
  width: 84px;
  font-size: 10.5px;
  color: var(--text-faint);
}
.ve-row.col > label { width: auto; }
.ve-row label em { font-style: normal; }
.ve-row input,
.ve-row select,
.ve-row textarea {
  flex: 1;
  min-width: 0;
  font-size: 11.5px;
}
.ve-row input,
.ve-row select { height: 24px; }
.ve-row textarea { resize: vertical; line-height: 1.5; }
.ve-row input[readonly] { color: var(--text-faint); background: transparent; }
.ve-tr { display: flex; gap: 6px; }
.ve-lang { flex: none !important; width: 58px; }
.ve-x {
  flex: none;
  width: 22px;
  height: 24px;
  font-size: 13px;
  color: var(--text-faint);
  border-radius: 3px;
}
.ve-x:hover { color: var(--text); background: var(--surface-2); }
.ve-add {
  align-self: flex-start;
  margin-top: 2px;
  font-size: 10.5px;
  color: var(--text-dim);
}
.ve-add:hover { color: var(--text); }
.ve-del {
  margin-top: 4px;
  height: 24px;
  font-size: 11px;
  color: var(--warn);
  border: 1px solid var(--line);
  border-radius: 3px;
}
.ve-del:hover:not(:disabled) { border-color: var(--warn); }
.ve-del:disabled { opacity: 0.4; cursor: default; color: var(--text-faint); }
.ve-empty { margin: 20px 0 0; text-align: center; }

.ve-foot {
  flex: none;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 14px;
  border-top: 1px solid var(--line);
}
.ve-status { flex: 1; min-width: 0; font-size: 10.5px; line-height: 1.4; }
.ve-status .warn { color: var(--warn); }
.ve-status .ok { color: var(--accent); }
.ve-status .err { display: block; color: var(--warn); }
</style>
