/**
 * 简体中文词典 → 繁体（台灣 / 香港）词典生成器。
 *
 * 只做两件事，不碰业务：
 *   `node tools/i18n-hant.mjs --init-tw`  生成 `src/shared/i18n.zh-TW.js`（只在缺失时）
 *   `node tools/i18n-hant.mjs`            由「台灣词典 + 香港差异表」合成 `i18n.zh-HK.js`
 *
 * 为什么要生成而不是手写两份：
 *   - 台湾那份是**源码**（人在改），香港那份是**产物**（脚本合成）——
 *     只维护一份大词典 + 一张几十条的差异表，两边不会漂移。
 *   - 运行时两份都是完整对象，不走「缺键回落」，所以不会出现
 *     「香港界面里冒出一句台湾词」或「某条忘了翻译」这种兼容性 Bug。
 *
 * 字形与用词是两层：
 *   1. 术语表（长词优先）—— 文件→檔案、设置→設定、播放列表→播放清單…
 *   2. 单字表 —— 删→刪、编→編、为→為…
 * 顺序不能反：先换词再换字，否则「档案」会被单字表再啃一遍（裏面全是繁体，倒也无害，
 * 但「文件」这种同形词会先被拆成「文檔」再拼不回来）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DICT } from '../src/shared/i18n.js';
import { HANT_CHARS } from '../src/shared/hant.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(here, '..', 'src', 'shared');
const TW_FILE = path.join(SRC, 'i18n.zh-TW.js');
const HK_FILE = path.join(SRC, 'i18n.zh-HK.js');
const HK_PATCH_FILE = path.join(SRC, 'i18n.zh-HK.patch.js');

/* ---------------- 术语表（台湾口径，长词在前） ---------------- */
const TERMS = [
  ['播放列表', '播放清單'],
  ['词表', '詞彙表'],
  ['文件夹', '資料夾'],
  ['文件名', '檔名'],
  ['文件', '檔案'],
  ['采样率', '取樣率'],
  ['菜单', '選單'],
  ['默认', '預設'],
  ['软件', '軟體'],
  ['网络', '網路'],
  ['视频', '影片'],
  ['信息', '資訊'],
  ['支持', '支援'],
  ['打印', '列印'],
  ['鼠标', '滑鼠'],
  ['键盘', '鍵盤'],
  ['屏幕', '螢幕'],
  ['在线', '線上'],
  ['加载', '載入'],
  ['保存', '儲存'],
  ['设置', '設定'],
  ['配置', '設定'],
  ['选项', '選項'],
  ['数据库', '資料庫'],
  ['数据', '資料'],
  ['程序', '程式'],
  ['代码', '程式碼'],
  ['界面', '介面'],
  ['窗口', '視窗'],
  ['打开', '開啟'],
  ['关闭', '關閉'],
  ['帮助', '說明'],
  ['搜索', '搜尋'],
  ['查找', '尋找'],
  ['过滤', '篩選'],
  ['标签', '標籤'],
  ['缓存', '快取'],
  ['内存', '記憶體'],
  ['硬盘', '硬碟'],
  ['刷新', '重新整理'],
  ['登录', '登入'],
  ['退出', '結束'],
  ['新建', '新增'],
  ['重命名', '重新命名'],
  ['属性', '屬性'],
  ['卸载', '解除安裝'],
  ['启动', '啟動'],
  ['运行', '執行'],
  ['恢复', '還原'],
  ['重置', '重設'],
  ['导入', '匯入'],
  ['导出', '匯出'],
  ['上传', '上傳'],
  ['下载', '下載'],
  ['音频', '音訊'],
  ['话筒', '麥克風'],
  ['耳机', '耳機'],
  ['扬声器', '喇叭'],
  ['快进', '快轉'],
  ['快退', '倒轉'],
  ['队列', '佇列'],
  ['时间轴', '時間軸'],
  ['单元格', '儲存格'],
  ['缩进', '縮排'],
  ['对齐', '對齊'],
  ['字体', '字型'],
  ['加粗', '粗體'],
  ['斜体', '斜體'],
  ['主题', '主題'],
  ['渐变', '漸層'],
  ['边距', '邊距'],
  ['视图', '檢視'],
  ['全局', '全域'],
  ['当前', '目前'],
  ['只用于', '僅用於'],
  ['复制', '複製'],
  ['粘贴', '貼上'],
  ['撤销', '復原'],
  ['全选', '全選'],
  ['剪切', '剪下'],
  ['客户端', '用戶端'],
  ['模块', '模組'],
  ['类型', '類型'],
  ['项目', '專案'],
  ['干净', '乾淨'],
  ['什么', '什麼'],
  ['怎么', '怎麼'],
  ['为什么', '為什麼'],
  ['变量', '變數'],
  ['已确定', '已確定'],
  ['制作', '製作'],
  ['录制', '錄製'],
  ['编制', '編制'],
  ['回车确认', 'Enter 確認'],
  ['回车跳到', 'Enter 跳到'],
  ['后回车', '後 Enter'],
  ['回车或', 'Enter 或'],
  ['回车就是', 'Enter 就是'],
  ['按回车', '按 Enter'],
  ['回车', 'Enter'],
];

/* ---------------- 单字表：与运行期共用一份（见 src/shared/hant.js） ---------------- */
const CHARS = HANT_CHARS;

function toTW(src) {
  let out = String(src);
  for (const [a, b] of TERMS) out = out.split(a).join(b);
  let res = '';
  for (const ch of out) res += CHARS[ch] ?? ch;
  // 中英混排补空格：「按 Enter不會提交」这种挤在一起很难看（只处理 Enter 这一处）
  return res.replace(/Enter(?=[\u4e00-\u9fff])/g, 'Enter ').replace(/([\u4e00-\u9fff])Enter/g, '$1 Enter');
}

/* ---------------- 生成台湾词典 ---------------- */
function buildTW() {
  const lines = Object.entries(DICT.zh).map(([k, v]) => {
    const val = toTW(v).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    return `  '${k}': '${val}',`;
  });
  const head = `/**
 * 繁體中文（台灣）界面詞典。
 *
 * 這份是**原始碼**：要改繁中文案改這裡。香港版（i18n.zh-HK.js）由
 * \`tools/i18n-hant.mjs\` 從「這份 + i18n.zh-HK.patch.js 的差異表」合成，
 * 不要手改那個檔案 —— 下次生成會被蓋掉。
 *
 * 用詞照台灣軟體習慣（檔案 / 預設 / 軟體 / 網路 / 儲存 / 設定 / 播放清單），
 * 不是把簡體逐字換成繁體就完事：字形與用詞是兩件事。
 */
export const ZH_TW = {
${lines.join('\n')}
};
`;
  fs.writeFileSync(TW_FILE, head, 'utf8');
  return Object.keys(DICT.zh).length;
}

/* ---------------- 香港差异表 ---------------- */
/**
 * 香港与台湾的差异：数量不多，但都是「一眼能看出你不是本地人」的那种。
 * 只列**值**（键与台湾那份完全相同），脚本按 key 覆盖。
 *
 * 香港书面上其实也常有台湾那套，真正有区别的是下面这些；
 * 字形层面香港用「裏」而不是「裡」，也在 patch 里统一兜一遍。
 */
const HK_DIFF = {
  // 「軟體 / 軟件」「網路 / 網絡」「列印 / 打印」是港台最典型的三组
  'app.name': 'music·atlas',
  'menu.help': '說明',
};

/* ---------------- 合成香港词典 ---------------- */
async function buildHK() {
  // 台湾那份是 ESM，直接 import（Node 会按模块语法自动识别）
  const { ZH_TW } = await import(`${pathToFileURL(TW_FILE)}?t=${Date.now()}`);
  let patch = {};
  if (fs.existsSync(HK_PATCH_FILE)) {
    patch = (await import(`${pathToFileURL(HK_PATCH_FILE)}?t=${Date.now()}`)).HK_PATCH ?? {};
  }

  const keys = Object.keys(ZH_TW);
  const unknown = Object.keys(patch).filter((k) => !(k in ZH_TW));
  if (unknown.length) {
    throw new Error(`香港差异表里有台湾词典不存在的键：${unknown.join(', ')}`);
  }

  // 香港字形：台湾写「裡」，香港寫「裏」（其餘字形一致）
  const hkChar = (s) => String(s).replace(/裡/g, '裏');

  const lines = keys.map((k) => {
    const v = k in patch ? String(patch[k]) : hkChar(ZH_TW[k]);
    const val = v.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    return `  '${k}': '${val}',`;
  });

  const head = `/**
 * 繁體中文（香港）界面詞典。
 *
 * **自動生成，不要手改** —— 由 \`tools/i18n-hant.mjs\` 從
 * \`i18n.zh-TW.js\`（台灣）+ \`i18n.zh-HK.patch.js\`（香港差异表）合成。
 * 改文案去改台湾那份；只有港式用词不同才往差异表里加一条。
 *
 * 生成出来是**完整**的 ${keys.length} 条，不是「覆盖层」：
 * 运行时不做缺键回落，就不会出现港台混排。
 */
export const ZH_HK = {
${lines.join('\n')}
};
`;
  fs.writeFileSync(HK_FILE, head, 'utf8');
  return { count: keys.length, patched: Object.keys(patch).length };
}


const wantInit = process.argv.includes('--init-tw');
if (wantInit || !fs.existsSync(TW_FILE)) {
  const n = buildTW();
  console.log(`[hant] 生成台湾词典 ${path.basename(TW_FILE)}（${n} 条）`);
}
if (!wantInit) {
  const r = await buildHK();
  console.log(`[hant] 生成香港词典 ${path.basename(HK_FILE)}（${r.count} 条，覆盖 ${r.patched} 条）`);
}
