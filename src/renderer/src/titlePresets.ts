import { computed, ref } from 'vue';

export type TemplateScope = 'title' | 'movement';

export interface TitlePreset {
  id: string;
  name: string;
  scope: TemplateScope;
  template: string;
  builtin?: boolean;
}

/**
 * 官方预设。名字（而不是 id）就是输入框里敲的那个词：
 * `for_Classical_Opus` / `default_movement` 都是用户点名要的，别翻译。
 */
export const BUILTIN_PRESETS: TitlePreset[] = [
  {
    id: 'builtin:for_Classical_Opus',
    name: 'for_Classical_Opus',
    scope: 'title',
    template: '%Composer} - %form} %Number of the form} in %Key}, %Opus Number}',
    builtin: true,
  },
  {
    id: 'builtin:default_movement',
    name: 'default_movement',
    scope: 'movement',
    template: '%Movement Number} %Sub-Type} - %Tempo Term}',
    builtin: true,
  },
];

const STORE_KEY = 'ma-title-presets';

/** 旧变量名 → 新名字。旧预设还能用，但界面上统一显示 %Sub-Type}。 */
function canonicalTemplate(text: string): string {
  return String(text ?? '').replace(/%sub[\s_-]*form}/gi, '%Sub-Type}');
}

function readUser(): TitlePreset[] {
  try {
    const raw = JSON.parse(localStorage.getItem(STORE_KEY) || '[]');
    if (!Array.isArray(raw)) return [];
    return raw
      .filter((p: any) => p && typeof p.name === 'string' && typeof p.template === 'string')
      .map((p: any) => ({
        id: String(p.id || `user:${p.name}`),
        name: String(p.name),
        scope: p.scope === 'movement' ? 'movement' : 'title',
        template: canonicalTemplate(String(p.template)),
      }));
  } catch {
    return [];
  }
}

export const userPresets = ref<TitlePreset[]>(readUser());
export const allPresets = computed<TitlePreset[]>(() => [...BUILTIN_PRESETS, ...userPresets.value]);

function persist() {
  try {
    localStorage.setItem(
      STORE_KEY,
      JSON.stringify(userPresets.value.map(({ id, name, scope, template }) => ({ id, name, scope, template })))
    );
  } catch {
    /* 隐私模式写不进去：预设只在本次会话生效，和其它首选项同一套取舍 */
  }
}

export function isPresetNameTaken(name: string, exceptId: string | null = null): boolean {
  const k = String(name ?? '').trim().toLowerCase();
  if (!k) return false;
  return allPresets.value.some((p) => p.id !== exceptId && p.name.toLowerCase() === k);
}

export function saveUserPreset(input: { id?: string | null; name: string; scope: TemplateScope; template: string }): TitlePreset {
  const name = String(input.name ?? '').trim();
  const template = canonicalTemplate(String(input.template ?? ''));
  const old = input.id ? userPresets.value.find((p) => p.id === input.id) : null;
  const next: TitlePreset = old
    ? { ...old, name, scope: input.scope, template }
    : { id: `user:${Date.now().toString(36)}`, name, scope: input.scope, template };
  userPresets.value = old
    ? userPresets.value.map((p) => (p.id === next.id ? next : p))
    : [...userPresets.value, next];
  persist();
  return next;
}

export function deleteUserPreset(id: string) {
  userPresets.value = userPresets.value.filter((p) => p.id !== id);
  persist();
}

/**
 * 按预设名匹配。名字本身是 `for_Classical_Opus` 这种标识符，
 * 大小写不敏感；只认**从头开始**的输入 —— 曲名里出现一个 `for` 不该弹预设候选。
 */
export function matchPresets(fragment: string, scope: TemplateScope): TitlePreset[] {
  const q = String(fragment ?? '').trim().toLowerCase();
  if (!q) return [];
  const scored: { score: number; order: number; preset: TitlePreset }[] = [];
  allPresets.value.forEach((preset, order) => {
    if (preset.scope !== scope) return;
    const name = preset.name.toLowerCase();
    let score = 99;
    if (name === q) score = 0;
    else if (name.startsWith(q)) score = 1;
    if (score < 99) scored.push({ score, order, preset });
  });
  return scored.sort((a, b) => a.score - b.score || a.order - b.order).map((x) => x.preset);
}
