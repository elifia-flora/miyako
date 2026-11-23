/**
 * 把截图按区域放大，用来肉眼检查像素级排版（卡片间距 / 字形 / 对齐）。
 *
 *   npx electron tools/zoom-shot.cjs <图片> <x> <y> <宽> <高> <倍数> <输出>
 *
 * 背景：冒烟会存一堆 `shots/*.png`，但整窗截图缩到 1000px 宽以后，
 * 10px 的字形细节根本看不清。这个脚本把指定区域裁出来放大，判断「降号是不是还沉在
 * 基线下面」「chevron 是不是真的转了」这类断言证明不了的事。
 *
 * 变换顺序是 `scale(S) translate(-x,-y)`（css 从右往左应用）：先平移再放大，
 * 所以左上角正好落在 (x, y)。写成先 scale 再 translate 会连偏移量一起放大。
 */
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

const [img, x, y, w, h, s, out] = process.argv.slice(2);
if (!img || !out) {
  console.log('用法：electron tools/zoom-shot.cjs <图片> <x> <y> <宽> <高> <倍数> <输出>');
  process.exit(2);
}
const scale = Number(s || 4);
const htmlPath = path.join(os.tmpdir(), 'zoom-shot.html');
fs.writeFileSync(
  htmlPath,
  `<html><body style="margin:0;overflow:hidden;background:#000">
<img src="file:///${String(img).replace(/\\/g, '/')}"
     style="position:absolute;left:0;top:0;transform-origin:0 0;image-rendering:pixelated;
            transform:scale(${scale}) translate(${-Number(x)}px,${-Number(y)}px)">
</body></html>`,
  'utf8'
);

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false,
    width: Math.round(Number(w) * scale),
    height: Math.round(Number(h) * scale),
    useContentSize: true,
  });
  await win.loadFile(htmlPath);
  await new Promise((r) => setTimeout(r, 400));
  fs.writeFileSync(out, (await win.webContents.capturePage()).toPNG());
  console.log('saved', out);
  app.quit();
});
