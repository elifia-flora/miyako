import { createApp } from 'vue';
import App from './App.vue';
import GridStandalone from './GridStandalone.vue';
import LyricsPlayer from './LyricsPlayer.vue';
import OverlayLyrics from './OverlayLyrics.vue';
import ImageViewer from './ImageViewer.vue';
import ActionHelp from './ActionHelp.vue';
import HistoryWindow from './HistoryWindow.vue';
import { installHotkeyShield } from './hotkeyshield';
import { installInputMode } from './inputmode';
import { installSlimScroll } from './slimscroll';
import './styles/tokens.css';

// 焦点环的「鼠标 / 键盘」判定：所有窗口都要，别只装在主界面上
installInputMode();

// 细滚动条：每个窗口都装一次（同一个 index.html 服务所有窗口，滚动区各窗口自己算）
installSlimScroll();

// 同一个 index.html 服务多个窗口：默认是主界面，#grid / #lyrics / #overlay / #image / #help / #history 是子窗口
const hash = location.hash.replace(/^#/, '');
let root: any;
if (hash.startsWith('grid')) {
  root = GridStandalone;
} else if (hash.startsWith('lyrics')) {
  root = LyricsPlayer;
} else if (hash.startsWith('overlay')) {
  root = OverlayLyrics;
} else if (hash.startsWith('image')) {
  root = ImageViewer;
} else if (hash.startsWith('help')) {
  root = ActionHelp;
} else if (hash.startsWith('history')) {
  root = HistoryWindow;
} else {
  root = App;
}
createApp(root).mount('#app');

/**
 * 子窗口：输入框拿到焦点时告诉主进程「别拦我的按键」。
 * 主窗口不需要 —— 它自己就是快捷键的执行者。
 */
if (hash) installHotkeyShield((window as any).api);
