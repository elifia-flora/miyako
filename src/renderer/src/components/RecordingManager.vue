<script setup lang="ts">
/**
 * RecordingManager — 录音版本管理
 *
 * 详情面板窄，塞不下「N 个版本 × 11 个字段」。所以面板里只留一行摘要，
 * 逐版本的编辑全放到这个窗口：左边选版本，右边改字段。
 *
 * 保存语义沿用详情面板那一套：**逐字段即时落库**（失焦 / 回车），没有全局保存按钮。
 * 这样中途关窗口也不会丢掉刚改的东西，也省掉「改了没存」这种状态。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { formatMsShort } from '@shared/barbeat.js';
import { t } from '../i18n';
import { isComposing } from '../ime';

/** preload 挂在 window 上的桥。项目里没有全局类型声明，统一这样取（与 App.vue 一致） */
const api = (window as any).api;

const props = defineProps<{
  trackId: string;
  recordings: any[];
  /** 默认选中的版本 id；不传就选当前默认版本 */
  initialId?: string | null;
}>();
const emit = defineEmits<{
  close: [];
  /**
   * 库里变了，父级要重新拉一次详情 + 列表。
   * `files: true` = 文件集合 / 绑定变了（选文件、加删音质、并入、删版本），
   * 父级必须强制重载音频源 —— 只改厂牌 / 演奏者时不要传，别打断正在播的音频。
   */
  changed: [payload?: { files?: boolean }];
}>();

/** 逐版本不同的字段。加字段只改这一行，模板与样式都不动。 */
const FIELDS: { key: string; labelKey: string; num?: boolean }[] = [
  { key: 'performers', labelKey: 'rec.performers' },
  { key: 'orchestra', labelKey: 'rec.orchestra' },
  { key: 'conductor', labelKey: 'rec.conductor' },
  { key: 'soloist', labelKey: 'rec.soloist' },
  { key: 'recordedYear', labelKey: 'rec.recordedYear', num: true },
  { key: 'releaseYear', labelKey: 'rec.releaseYear', num: true },
  { key: 'label', labelKey: 'rec.label' },
  { key: 'catalogNo', labelKey: 'rec.catalogNo' },
  { key: 'recordingPlace', labelKey: 'rec.recordingPlace' },
  { key: 'mixEngineer', labelKey: 'rec.mixEngineer' },
  { key: 'masteringEngineer', labelKey: 'rec.masteringEngineer' },
];

const selectedId = ref<string | null>(
  props.initialId ?? props.recordings[0]?.id ?? null
);
const saving = ref(false);
const linkError = ref('');

watch(
  () => props.recordings,
  (list) => {
    // 被删掉的版本还选中着，就退到第一个，别留一个指向空气的表单
    if (list.length && !list.some((r) => r.id === selectedId.value)) {
      selectedId.value = list[0].id;
    }
    if (!list.length) selectedId.value = null;
  }
);

const current = computed(() => props.recordings.find((r) => r.id === selectedId.value) ?? null);
const curIndex = computed(() => props.recordings.findIndex((r) => r.id === selectedId.value));
const isFirst = computed(() => curIndex.value <= 0);
const isLast = computed(() => curIndex.value < 0 || curIndex.value >= props.recordings.length - 1);
const variants = computed<any[]>(() => (Array.isArray(current.value?.variants) ? current.value!.variants : []));
const otherVersions = computed<any[]>(() =>
  props.recordings.filter((r) => r.id !== current.value?.id)
);
/** 只有「自己还没有音质子项」的版本才能并到别人下面（否则会造出三层嵌套） */
const canMerge = computed(() => !!current.value && variants.value.length === 0 && otherVersions.value.length > 0);
const mergeTarget = ref('');
const mergeError = ref('');
/** 这个演奏版本实际会播的文件：自己的文件优先，没有就用第一个存在的音质 */
const effectiveFile = computed<any | null>(() => {
  const r = current.value;
  if (!r) return null;
  if (r.filePath && r.fileExists) return r;
  return variants.value.find((v) => v.fileExists) ?? null;
});

/**
 * 上移 / 下移 = 调整「点作品播放先播哪一版」的顺序。
 * 传完整清单给主进程，不要只传这一条 —— 主进程按清单重写 seq_order，
 * 少传一条那条就会掉到 0 号位。
 */
async function move(dir: -1 | 1) {
  const cur = current.value;
  if (!cur) return;
  const ids = props.recordings.map((r) => r.id);
  const i = ids.indexOf(cur.id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= ids.length) return;
  [ids[i], ids[j]] = [ids[j], ids[i]];
  await api.recording.reorder(props.trackId, ids);
  emit('changed');
  selectedId.value = cur.id; // 挪完还停在同一条上，别让眼睛跟丢
}

/** 版本显示名：厂牌 + 编号 → 指挥 → 文件名 → 「录音 N」 */
function recName(r: any): string {
  if (r.label && r.catalogNo) return `${r.label} · ${r.catalogNo}`;
  if (r.label) return r.label;
  if (r.conductor) return r.conductor;
  const file = r.filePath || (Array.isArray(r.variants) ? r.variants.find((v: any) => v.filePath)?.filePath : '');
  if (file) return String(file).split(/[\\/]/).pop() || '';
  return t('rec.title');
}

/** 列表右下的来源标记：本地文件 > 外链 > 空 */
function sourceKind(r: any): 'local' | 'link' | 'none' {
  if (r.filePath || (Array.isArray(r.variants) && r.variants.some((v: any) => v.filePath))) return 'local';
  if (r.link) return 'link';
  return 'none';
}
function sourceLabel(r: any): string {
  const k = sourceKind(r);
  if (k === 'local') return t('rec.sourceLocal');
  if (k === 'link') return t('rec.sourceExternal');
  return t('rec.sourceNone');
}

function fieldText(r: any, key: string): string {
  if (!r) return '';
  if (key === 'performers') return (Array.isArray(r.performers) ? r.performers : []).join(' / ');
  const v = r[key];
  return v === null || v === undefined ? '' : String(v);
}

async function patch(payload: Record<string, unknown>, opts: { files?: boolean } = {}) {
  if (!current.value || saving.value) return;
  saving.value = true;
  try {
    await api.recording.save({ trackId: props.trackId, id: current.value.id, ...payload } as any);
    emit('changed', { files: opts.files === true });
  } finally {
    saving.value = false;
  }
}

async function commitField(key: string, raw: string) {
  const r = current.value;
  if (!r) return;
  const value = String(raw ?? '').trim();
  const prev = fieldText(r, key);
  if (value === prev) return;

  if (key === 'performers') {
    // 顿号 / 逗号 / 斜杠都当分隔符：演奏者常写成「甲 / 乙」或「甲、乙」
    await patch({ performers: value ? value.split(/[/,、;]/).map((s) => s.trim()).filter(Boolean) : [] });
  } else if (key === 'recordedYear' || key === 'releaseYear') {
    await patch({ [key]: value ? Number(value) : null });
  } else {
    await patch({ [key]: value });
  }
}

async function commitLink(raw: string) {
  const r = current.value;
  if (!r) return;
  const value = String(raw ?? '').trim();
  if (value === (r.link ?? '')) return;
  if (value && !/^https?:\/\//i.test(value)) {
    linkError.value = t('rec.linkBad');
    return;
  }
  linkError.value = '';
  await patch({ link: value });
}

/**
 * 原点偏移只改**当前选中的这个版本**。
 * 同一部作品的磁带转录版与 CD 抓轨版开头留白可以差好几秒，
 * 一个作品只存一份就必然有一版对不上。
 */
async function commitOffset(raw: string) {
  const r = current.value;
  if (!r) return;
  const n = Math.round(Number(raw));
  if (!Number.isFinite(n)) return;
  if (n === (Number(r.audioOffsetMs) || 0)) return;
  await patch({ audioOffsetMs: n });
}

/** ± 按钮：从草稿里取基数，连点几下不会因为 props 还没回来而原地打转 */
function nudgeOffset(d: number) {
  const r = current.value;
  if (!r) return;
  const typed = Number(drafts.value.offsetMs);
  const base = Number.isFinite(typed) ? typed : Number(r.audioOffsetMs) || 0;
  const v = Math.round(base + d);
  drafts.value.offsetMs = String(v);
  void commitOffset(String(v));
}

/**
 * 回车提交（字段 / 外链共用）。
 *
 * 中文输入法按 Enter 确认候选词时也会派发 keydown（isComposing=true），
 * 而此刻 v-model 还没同步组合文本 —— 直接提交会存进组合前的旧值，
 * 用户看到的就是「打完回车保存不上」。所以组合期内一律放过去。
 * 同时以输入框真实值兜底，不吃 v-model 的滞后。
 */
function enterValue(ev: KeyboardEvent, key: string): string | null {
  if (isComposing(ev)) return null;
  const el = ev.target as HTMLInputElement | null;
  const v = el && typeof el.value === 'string' ? el.value : (drafts.value[key] ?? '');
  drafts.value[key] = v;
  return v;
}
function fieldEnter(ev: KeyboardEvent, key: string) {
  const v = enterValue(ev, key);
  if (v !== null) void commitField(key, v);
}
function linkEnter(ev: KeyboardEvent) {
  const v = enterValue(ev, 'link');
  if (v !== null) void commitLink(v);
}
/* 失焦提交：以输入框真实值为准（点走的那一刻可能刚好撞上组合结束） */
function fieldBlur(ev: FocusEvent, key: string) {
  const el = ev.target as HTMLInputElement | null;
  const v = el && typeof el.value === 'string' ? el.value : (drafts.value[key] ?? '');
  drafts.value[key] = v;
  void commitField(key, v);
}
function linkBlur(ev: FocusEvent) {
  const el = ev.target as HTMLInputElement | null;
  const v = el && typeof el.value === 'string' ? el.value : (drafts.value.link ?? '');
  drafts.value.link = v;
  void commitLink(v);
}
function offsetEnter(ev: KeyboardEvent) {
  const v = enterValue(ev, 'offsetMs');
  if (v !== null) void commitOffset(v);
}
function offsetBlur(ev: FocusEvent) {
  const el = ev.target as HTMLInputElement | null;
  const v = el && typeof el.value === 'string' ? el.value : (drafts.value.offsetMs ?? '');
  drafts.value.offsetMs = v;
  void commitOffset(v);
}

async function addVersion() {
  const rec = await api.recording.save({
    trackId: props.trackId,
    isDefault: props.recordings.length === 0,
  } as any);
  emit('changed');
  if (rec?.id) selectedId.value = rec.id;
}

async function pickLocal() {
  if (!current.value) return;
  const rec = await api.recording.pick(props.trackId, current.value.id);
  if (rec) emit('changed', { files: true });
}

/** 同一演奏版本追加一个音质 / 转码文件：只登记文件，演奏信息仍归父版本 */
async function addVariant() {
  if (!current.value) return;
  const rec = await api.recording.pickVariant(current.value.id);
  if (rec) emit('changed', { files: true });
}

async function replaceVariant(v: any) {
  if (!current.value) return;
  const rec = await api.recording.pick(props.trackId, v.id);
  if (rec) emit('changed', { files: true });
}

async function removeVariant(v: any) {
  if (!v?.id) return;
  await api.recording.remove(v.id);
  emit('changed', { files: true });
}

/** 把当前版本并到另一个版本下面：仅用于「这两条其实是同一演奏的不同转码」 */
async function mergeInto() {
  const target = mergeTarget.value;
  const cur = current.value;
  if (!target || !cur) return;
  mergeError.value = '';
  const rec = await api.recording.mergeInto(cur.id, target);
  if (!rec) {
    mergeError.value = t('rec.mergeFailed');
    return;
  }
  mergeTarget.value = '';
  selectedId.value = target;
  emit('changed', { files: true });
}

watch(selectedId, () => {
  mergeTarget.value = '';
  mergeError.value = '';
});

function fileName(p: string): string {
  return String(p ?? '').split(/[\\/]/).pop() || '';
}

async function clearAudio() {
  const r = current.value;
  if (!r?.filePath) return;
  await patch(
    { filePath: '', durationMs: null, format: null, sampleRate: null, channels: null, bits: null },
    { files: true }
  );
}

/** 删版本会连带改 track.file_path（顺序里下一条顶上），不可撤销 —— 父级负责弹确认框 */
const confirmingRemove = ref(false);
async function removeVersion() {
  if (!current.value) return;
  if (!confirmingRemove.value) {
    confirmingRemove.value = true;
    return;
  }
  enforcingDelete();
}
function enforcingDelete() {
  const r = current.value;
  if (!r) return;
  confirmingRemove.value = false;
  api.recording.remove(r.id).then(() => emit('changed', { files: true }));
}

async function openLink() {
  const u = current.value?.link;
  if (u) await api.link.open(u);
}

function onKey(ev: KeyboardEvent) {
  if (ev.key === 'Escape') {
    ev.preventDefault();
    ev.stopPropagation();
    emit('close');
  }
  // 模态必须挡住背景的 Space（否则空格会把播放条按下去）
  if (ev.code === 'Space') ev.stopPropagation();
}
onMounted(() => window.addEventListener('keydown', onKey, true));
onBeforeUnmount(() => window.removeEventListener('keydown', onKey, true));

/* ---- 输入框失焦提交：每行一个本地草稿，不改 props ---- */
const drafts = ref<Record<string, string>>({});
watch(
  current,
  async (r) => {
    confirmingRemove.value = false;
    linkError.value = '';
    const next: Record<string, string> = {};
    if (r) {
      for (const f of FIELDS) next[f.key] = fieldText(r, f.key);
      next.link = r.link ?? '';
      next.offsetMs = String(Number(r.audioOffsetMs) || 0);
    }
    drafts.value = next;
    await nextTick();
  },
  { immediate: true }
);
</script>

<template>
  <div class="modal-mask" @click.self="emit('close')">
    <div class="modal rm" role="dialog" aria-modal="true">
      <header class="rm-head">
        <h3>{{ t('rec.managerTitle') }}</h3>
        <span class="faint tiny">{{ t('rec.count', { n: recordings.length }) }}</span>
        <span class="grow" />
        <button class="chip" @click="emit('close')">{{ t('rec.close') }}</button>
      </header>

      <div class="rm-body">
        <!-- 左：版本清单 -->
        <aside class="rm-list">
          <button
            v-for="r in recordings"
            :key="r.id"
            class="rm-item"
            :class="{ on: r.id === selectedId }"
            :data-id="r.id"
            @click="selectedId = r.id"
          >
            <span class="rm-dot" :class="{ on: r.isDefault }" />
            <span class="rm-name" :title="recName(r)">
              {{ recName(r) }}
              <em v-if="r.variants?.length" class="rm-varcount">+{{ r.variants.length }}</em>
            </span>
            <span class="rm-src" :class="sourceKind(r)">{{ sourceLabel(r) }}</span>
          </button>

          <p v-if="!recordings.length" class="rm-empty faint tiny">{{ t('rec.empty') }}</p>

          <button class="chip rm-add" @click="addVersion">+ {{ t('rec.addVersion') }}</button>
        </aside>

        <!-- 右：当前版本的字段 -->
        <section v-if="current" class="rm-form">
          <div class="rm-sect">
            <span class="rm-sect-h">{{ t('rec.source') }}</span>
            <div class="rm-audio">
              <span class="rm-audio-k">{{ t('rec.primaryFile') }}</span>
              <template v-if="current.filePath">
                <span class="rm-file" :title="current.filePath">
                  {{ fileName(current.filePath) }}
                </span>
                <span class="faint tiny">
                  {{ current.format ?? '' }}
                  <template v-if="current.durationMs"> · {{ formatMsShort(current.durationMs) }}</template>
                </span>
                <span v-if="!current.fileExists" class="rm-miss tiny">{{ t('rec.missingFile') }}</span>
                <span class="grow" />
                <button class="chip tiny" @click="pickLocal">{{ t('rec.replaceAudio') }}</button>
                <button class="chip tiny" @click="clearAudio">{{ t('rec.clearAudio') }}</button>
              </template>
              <template v-else>
                <span class="faint tiny">
                  {{ variants.length ? t('rec.primaryMissing') : t('rec.noAudio') }}
                </span>
                <span class="grow" />
                <button class="chip tiny" @click="pickLocal">{{ t('rec.pickLocal') }}</button>
              </template>
            </div>

            <!-- 同一演奏版本的不同转码 / 音质。它们不占独立版本行，播放时按顺序取第一个可用文件 -->
            <div class="rm-variants">
              <div class="rm-vars-head">
                <span class="k">{{ t('rec.qualities') }}</span>
                <span class="faint tiny">{{ t('rec.qualityCount', { n: variants.length }) }}</span>
                <span class="grow" />
                <button class="chip tiny" @click="addVariant">+ {{ t('rec.addQuality') }}</button>
              </div>
              <div v-for="v in variants" :key="v.id" class="rm-var">
                <span class="rm-var-file" :title="v.filePath">{{ fileName(v.filePath) }}</span>
                <span class="faint tiny">
                  {{ v.format ?? '' }}<template v-if="v.durationMs"> · {{ formatMsShort(v.durationMs) }}</template>
                  <template v-if="v.sampleRate"> · {{ Math.round(v.sampleRate / 100) / 10 }} kHz</template>
                  <template v-if="v.bits"> · {{ v.bits }} bit</template>
                </span>
                <span v-if="!v.fileExists" class="rm-miss tiny">{{ t('rec.missingFile') }}</span>
                <span class="grow" />
                <button class="chip tiny" @click="replaceVariant(v)">{{ t('rec.replaceAudio') }}</button>
                <button class="chip tiny" @click="removeVariant(v)">{{ t('rec.removeFile') }}</button>
              </div>
              <p v-if="!variants.length" class="faint tiny">{{ t('rec.qualityHint') }}</p>
            </div>

            <div v-if="canMerge" class="rm-merge">
              <span class="k">{{ t('rec.mergeInto') }}</span>
              <select v-model="mergeTarget" :title="t('rec.mergeHint')">
                <option value="">{{ t('rec.mergePick') }}</option>
                <option v-for="r in otherVersions" :key="r.id" :value="r.id">{{ recName(r) }}</option>
              </select>
              <button class="chip tiny" :disabled="!mergeTarget" @click="mergeInto">
                {{ t('common.confirm') }}
              </button>
            </div>
            <p v-if="canMerge" class="faint tiny">{{ t('rec.mergeHint') }}</p>
            <p v-if="mergeError" class="rm-err tiny">{{ mergeError }}</p>

            <label class="rm-link">
              <span class="k">{{ t('rec.link') }}</span>
              <input
                v-model="drafts.link"
                :placeholder="t('rec.linkPlaceholder')"
                :class="{ bad: !!linkError }"
                @keydown.enter.prevent="linkEnter($event)"
                @blur="linkBlur($event)"
              />
              <button class="chip tiny" :disabled="!current.link" @click="openLink">
                {{ t('rec.openLink') }}
              </button>
            </label>
            <p v-if="linkError" class="rm-err tiny">{{ linkError }}</p>
            <p class="faint tiny">{{ t('rec.linkHint') }}</p>
          </div>

          <!-- 时间线：原点偏移是逐版本的，换一版听就要能单独对一次 -->
          <div class="rm-sect">
            <span class="rm-sect-h">{{ t('rec.timeline') }}</span>
            <div class="rm-offset">
              <span class="k">{{ t('rec.offset') }}</span>
              <button class="chip tiny" :title="t('rec.offsetEarlier')" @click="nudgeOffset(-10)">−</button>
              <input
                v-model="drafts.offsetMs"
                class="num"
                type="number"
                step="1"
                @keydown.enter.prevent="offsetEnter($event)"
                @blur="offsetBlur($event)"
              />
              <span class="faint tiny">ms</span>
              <button class="chip tiny" :title="t('rec.offsetLater')" @click="nudgeOffset(10)">＋</button>
            </div>
            <p class="faint tiny">{{ t('rec.offsetNote') }}</p>
          </div>

          <div class="rm-grid">
            <label v-for="f in FIELDS" :key="f.key">
              <span class="k">{{ t(f.labelKey) }}</span>
              <input
                v-model="drafts[f.key]"
                :type="f.num ? 'number' : 'text'"
                :placeholder="t('rec.unset')"
                @keydown.enter.prevent="fieldEnter($event, f.key)"
                @blur="fieldBlur($event, f.key)"
              />
            </label>
          </div>

          <p class="faint tiny">{{ t('rec.unsavedHint') }}</p>
        </section>

        <section v-else class="rm-form rm-empty-form">
          <p class="faint">{{ t('rec.empty') }}</p>
        </section>
      </div>

      <footer class="rm-foot">
        <!-- 顺序就是播放优先级：点作品播放先播第一条。
             所以这里不是「设默认」，而是把某条往上/往下挪。 -->
        <template v-if="current">
          <button class="chip tiny" :disabled="isFirst" :title="t('rec.moveUp')" @click="move(-1)">
            ↑ {{ t('rec.moveUp') }}
          </button>
          <button class="chip tiny" :disabled="isLast" :title="t('rec.moveDown')" @click="move(1)">
            ↓ {{ t('rec.moveDown') }}
          </button>
          <span class="faint tiny rm-order-hint">{{ t('rec.orderHint') }}</span>
        </template>
        <span class="grow" />
        <span v-if="current && confirmingRemove && variants.length" class="faint tiny">
          {{ t('rec.removeCascade', { n: variants.length }) }}
        </span>
        <button
          v-if="current"
          class="chip danger"
          :class="{ armed: confirmingRemove }"
          @click="removeVersion"
        >
          {{ confirmingRemove ? t('common.confirm') : t('rec.remove') }}
        </button>
        <button v-if="confirmingRemove" class="chip" @click="confirmingRemove = false">
          {{ t('common.cancel') }}
        </button>
      </footer>
    </div>
  </div>
</template>

<style scoped>
.modal-mask {
  position: fixed;
  inset: 0;
  z-index: 60;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.45);
}
.modal.rm {
  display: flex;
  flex-direction: column;
  width: 780px;
  max-width: calc(100vw - 60px);
  height: min(600px, 84vh);
  background: var(--surface);
  border: 1px solid var(--line-strong);
  border-radius: 5px;
  box-shadow: var(--shadow);
  /* 圆角外的溢出要兜住，否则头像/输入框会从角上漏出来 */
  overflow: hidden;
}

.rm-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 14px;
  border-bottom: 1px solid var(--line);
}
.rm-head h3 {
  margin: 0;
  font-size: 13px;
  font-weight: 500;
  color: var(--text);
}
.grow { flex: 1; }

.rm-body {
  display: grid;
  /* 行必须显式 minmax(0,1fr)：隐式 auto 行会让长列表把面板顶出窗口 */
  grid-template-columns: 236px minmax(0, 1fr);
  grid-template-rows: minmax(0, 1fr);
  min-height: 0;
  flex: 1;
}

/* ---- 左：版本清单 ---- */
.rm-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-height: 0;
  padding: 8px;
  overflow: auto;
  border-right: 1px solid var(--line);
  background: var(--surface-2);
}
.rm-item {
  display: grid;
  grid-template-columns: 8px minmax(0, 1fr) auto;
  align-items: center;
  gap: 7px;
  padding: 6px 7px;
  text-align: left;
  border: 1px solid transparent;
  border-radius: 3px;
  background: transparent;
  color: var(--text-dim);
  font-size: 11.5px;
}
.rm-item:hover { background: var(--surface); color: var(--text); }
.rm-item.on {
  background: var(--sel-bg);
  border-color: var(--line-strong);
  color: var(--text);
}
.rm-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  border: 1px solid var(--line-strong);
}
.rm-dot.on { background: var(--accent); border-color: var(--accent); }
.rm-name {
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.rm-src {
  font-size: 9.5px;
  padding: 0 4px;
  border-radius: 2px;
  border: 1px solid var(--line);
  color: var(--text-faint);
}
.rm-src.local { color: var(--accent); border-color: color-mix(in srgb, var(--accent) 45%, transparent); }
.rm-src.none { opacity: 0.6; }

.rm-add {
  margin-top: 8px;
  height: 26px;
  color: var(--accent);
  border-style: dashed;
  border-color: color-mix(in srgb, var(--accent) 45%, transparent);
  background: transparent;
}
.rm-add:hover { background: var(--sel-bg); border-color: var(--accent); }

.rm-empty { padding: 10px 4px; line-height: 1.6; }

/* ---- 右：字段 ---- */
.rm-form {
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-height: 0;
  padding: 12px 14px;
  overflow: auto;
}

.rm-sect { display: flex; flex-direction: column; gap: 6px; }
.rm-sect-h {
  font-size: 10px;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--text-faint);
}
.rm-audio {
  display: flex;
  align-items: center;
  gap: 7px;
  flex-wrap: wrap;
  min-height: 24px;
}
.rm-audio-k { width: 64px; flex: none; color: var(--text-faint); font-size: 11px; }
.rm-file {
  font-family: var(--font-mono, monospace);
  font-size: 11px;
  color: var(--accent);
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  max-width: 320px;
}
.rm-miss { color: var(--danger, #d9534f); }

/* ---- 同版音质：挂在演奏版本下面的一排文件，不占独立版本行 ---- */
.rm-varcount {
  margin-left: 5px;
  padding: 0 4px;
  border-radius: 2px;
  border: 1px solid var(--line);
  color: var(--text-faint);
  font-size: 9px;
  font-style: normal;
}
.rm-variants {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 6px 0 0 64px;
}
.rm-vars-head {
  display: flex;
  align-items: center;
  gap: 7px;
}
.rm-var {
  display: flex;
  align-items: center;
  gap: 7px;
  min-height: 22px;
}
.rm-var-file {
  font-family: var(--font-mono, monospace);
  font-size: 11px;
  color: var(--accent);
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  max-width: 260px;
}
.rm-merge {
  display: flex;
  align-items: center;
  gap: 7px;
  padding-top: 4px;
}
.rm-merge select {
  height: 24px;
  min-width: 180px;
  max-width: 300px;
  font-size: 11.5px;
}

.rm-link {
  display: grid;
  grid-template-columns: 64px minmax(0, 1fr) auto;
  align-items: center;
  gap: 7px;
}
.rm-link input {
  height: 24px;
  font-size: 11.5px;
}
.rm-link input.bad { border-color: var(--danger, #d9534f); }
.rm-err { color: var(--danger, #d9534f); }

/* 列数必须等于子元素数（k / − / input / ms / ＋）；
   少写一列，多出来的 ＋ 会掉到下一行第 1 列，看起来像按钮掉下去了 */
.rm-offset {
  display: grid;
  grid-template-columns: 64px auto 92px auto auto;
  align-items: center;
  gap: 7px;
}
.rm-offset input {
  height: 24px;
  font-size: 11.5px;
  text-align: right;
}

.rm-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 6px 14px;
}
.rm-grid label {
  display: grid;
  grid-template-columns: 64px minmax(0, 1fr);
  align-items: center;
  gap: 7px;
}
.rm-grid input {
  height: 24px;
  font-size: 11.5px;
}
.k { color: var(--text-faint); font-size: 11px; }

.rm-empty-form { align-items: center; justify-content: center; }

.rm-foot {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 9px 14px;
  border-top: 1px solid var(--line);
}
.rec-tag {
  font-size: 9.5px;
  padding: 1px 5px;
  border-radius: 2px;
  color: var(--accent);
  border: 1px solid color-mix(in srgb, var(--accent) 45%, transparent);
}
/* 二次确认：删版本不可撤销，第二下才真删 */
.chip.danger.armed {
  color: #fff;
  background: var(--danger, #d9534f);
  border-color: var(--danger, #d9534f);
}
.chip {
  height: 24px;
  padding: 0 11px;
  font-size: 11.5px;
  color: var(--text-dim);
  border: 1px solid var(--line);
  border-radius: 3px;
  background: var(--surface-2);
}
.chip:hover { color: var(--text); border-color: var(--line-strong); }
.chip.tiny { height: 20px; padding: 0 7px; font-size: 10.5px; }
.chip.danger { color: var(--danger, #d9534f); }
.chip:disabled { opacity: 0.45; cursor: default; }
</style>