'use strict';

/**
 * electron-builder afterPack：目标平台的 better-sqlite3 预编译包必须在
 * app.asar.unpacked 里。没有它，openDb() 会在窗口出现之前把进程打退出去。
 *
 * 也导出 prebuildFileName，给单测锁住「平台-架构」文件名，避免再把 darwin / linux 排除掉。
 */

const fs = require('node:fs');
const path = require('node:path');

const ARCH_NAME = {
  0: 'ia32',
  1: 'x64',
  2: 'armv7l',
  3: 'arm64',
  4: 'universal',
  ia32: 'ia32',
  x64: 'x64',
  armv7l: 'armv7l',
  arm64: 'arm64',
  universal: 'universal',
};

function prebuildFileName(electronPlatformName, arch) {
  const archName = ARCH_NAME[arch];
  if (!archName) {
    throw new Error(`无法识别的 arch：${arch}`);
  }
  if (archName === 'universal') {
    throw new Error('universal 包里 better-sqlite3 没有单独的预编译文件，请按 arm64 / x64 分开打');
  }
  const platform = electronPlatformName === 'mas' ? 'darwin' : electronPlatformName;
  if (platform !== 'darwin' && platform !== 'linux' && platform !== 'win32') {
    throw new Error(`不支持的平台：${electronPlatformName}`);
  }
  return `${platform}-${archName}.node`;
}

function resourcesDir(context) {
  if (context.electronPlatformName === 'darwin' || context.electronPlatformName === 'mas') {
    const product = context.packager.appInfo.productFilename;
    return path.join(context.appOutDir, `${product}.app`, 'Contents', 'Resources');
  }
  return path.join(context.appOutDir, 'resources');
}

async function afterPack(context) {
  const fileName = prebuildFileName(context.electronPlatformName, context.arch);
  const unpacked = path.join(
    resourcesDir(context),
    'app.asar.unpacked',
    'node_modules',
    'better-sqlite3',
    'prebuilds',
    fileName,
  );
  if (!fs.existsSync(unpacked)) {
    throw new Error(
      `better-sqlite3 预编译包不在安装包里：${unpacked}\n` +
        `运行时会先找 prebuilds/${fileName}，再找 build/Release/better_sqlite3.node；` +
        '两处都没有的话，openDb() 在开窗口之前就退出。',
    );
  }
}

module.exports = afterPack;
module.exports.prebuildFileName = prebuildFileName;
module.exports.resourcesDir = resourcesDir;
