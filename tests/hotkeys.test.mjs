import test from 'node:test';
import assert from 'node:assert/strict';
import { HOTKEY, matchHotkey, needsSurface } from '../src/shared/hotkeys.js';

/**
 * 这份白名单决定了「子窗口里哪些键会被主进程截走」。
 *
 * 两类错误都很贵：
 *  - 漏掉 → 焦点在歌词窗口时快捷键失效（就是这次要修的问题）；
 *  - 多拦 → 子窗口自己要用这个键，或者用户正在输入框里打字，按键被吞掉。
 */

const key = (k, mods = {}) => ({ key: k, ...mods });
const ctrl = (k, mods = {}) => ({ key: k, control: true, ...mods });

test('Ctrl+R 登记作品、Ctrl+Shift+R 不抢', () => {
  assert.equal(matchHotkey(ctrl('r')), HOTKEY.REGISTER);
  assert.equal(matchHotkey(ctrl('R')), HOTKEY.REGISTER);
  assert.equal(matchHotkey(ctrl('r', { shift: true })), null);
});

test('Ctrl+F 搜索、Ctrl+Shift+F 清空搜索', () => {
  assert.equal(matchHotkey(ctrl('f')), HOTKEY.SEARCH);
  assert.equal(matchHotkey(ctrl('F', { shift: true })), HOTKEY.SEARCH_CLEAR);
});

test('Ctrl+, 偏好、Ctrl+J 面板', () => {
  assert.equal(matchHotkey(ctrl(',')), HOTKEY.PREFS);
  assert.equal(matchHotkey(ctrl('j')), HOTKEY.PANEL);
});

test('缩放三键：= / + / - / 0', () => {
  assert.equal(matchHotkey(ctrl('=')), HOTKEY.ZOOM_IN);
  assert.equal(matchHotkey(ctrl('+')), HOTKEY.ZOOM_IN);
  assert.equal(matchHotkey(ctrl('-')), HOTKEY.ZOOM_OUT);
  assert.equal(matchHotkey(ctrl('0')), HOTKEY.ZOOM_RESET);
});

test('网格窗口自己有缩放 → 传 zoom:false 时不转缩放键，其余照转', () => {
  assert.equal(matchHotkey(ctrl('='), { zoom: false }), null);
  assert.equal(matchHotkey(ctrl('0'), { zoom: false }), null);
  assert.equal(matchHotkey(ctrl('r'), { zoom: false }), HOTKEY.REGISTER);
});

test('F1 帮助，带修饰键的 F1 不管', () => {
  assert.equal(matchHotkey(key('F1')), HOTKEY.HELP);
  assert.equal(matchHotkey(ctrl('F1')), null);
  assert.equal(matchHotkey(key('F1', { shift: true })), null);
});

test('Alt+字母 = 菜单；Alt+F4 / Ctrl+Alt 组合不拦', () => {
  assert.equal(matchHotkey(key('f', { alt: true })), HOTKEY.MENU);
  assert.equal(matchHotkey(key('V', { alt: true })), HOTKEY.MENU);
  // F4 是两个字符，不是菜单助记符
  assert.equal(matchHotkey(key('F4', { alt: true })), null);
  assert.equal(matchHotkey(key('f', { alt: true, control: true })), null);
});

test('空格播放 / Home 停止；带 Shift 或 Alt 都不抢', () => {
  assert.equal(matchHotkey(key(' ')), HOTKEY.PLAY_TOGGLE);
  assert.equal(matchHotkey({ key: 'Space', code: 'Space' }), HOTKEY.PLAY_TOGGLE);
  // 只给 code 也要认（Electron 对空格的 key 表示不总是 ' '）
  assert.equal(matchHotkey({ key: '', code: 'Space' }), HOTKEY.PLAY_TOGGLE);
  assert.equal(matchHotkey(key(' ', { shift: true })), null);
  assert.equal(matchHotkey(key(' ', { alt: true })), null);
  assert.equal(matchHotkey(key('Home')), HOTKEY.STOP);
  assert.equal(matchHotkey(key('Home', { shift: true })), null);
});

test('子窗口自己用的键一个都不能拦', () => {
  for (const k of ['Delete', 'Backspace', 'Enter', 'Escape', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Tab']) {
    assert.equal(matchHotkey(key(k)), null, `${k} 不该被拦`);
  }
  // 网格编辑器的撤销 / 重做
  assert.equal(matchHotkey(ctrl('z')), null);
  assert.equal(matchHotkey(ctrl('z', { shift: true })), null);
  // 普通打字
  for (const k of ['a', 'r', 'f', '1', '中']) assert.equal(matchHotkey(key(k)), null, `${k} 不该被拦`);
});

test('界面类动作抬窗，播放类不抬窗', () => {
  for (const a of [HOTKEY.REGISTER, HOTKEY.SEARCH, HOTKEY.PREFS, HOTKEY.HELP, HOTKEY.MENU, HOTKEY.PANEL]) {
    assert.equal(needsSurface(a), true, `${a} 应该把主窗口抬到前台`);
  }
  for (const a of [HOTKEY.PLAY_TOGGLE, HOTKEY.STOP]) {
    assert.equal(needsSurface(a), false, `${a} 不该抢主窗口焦点`);
  }
});

test('空输入不炸', () => {
  assert.equal(matchHotkey(null), null);
  assert.equal(matchHotkey(undefined), null);
  assert.equal(matchHotkey({}), null);
});
