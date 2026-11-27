import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { prebuildFileName } = require('../tools/verify-native.cjs');

const root = path.resolve(import.meta.dirname, '..');
const yml = fs.readFileSync(path.join(root, 'electron-builder.yml'), 'utf8');
const workflow = fs.readFileSync(path.join(root, '.github', 'workflows', 'build.yml'), 'utf8');
/** 注释里会提到旧的排除写法，当作用法警告；断言只看真正生效的行。 */
const ymlRules = yml
  .split(/\r?\n/)
  .filter((line) => !line.trimStart().startsWith('#'))
  .join('\n');

test('预编译包文件名按目标平台，而不是写死 win32', () => {
  assert.equal(prebuildFileName('darwin', 3), 'darwin-arm64.node');
  assert.equal(prebuildFileName('darwin', 'x64'), 'darwin-x64.node');
  assert.equal(prebuildFileName('linux', 1), 'linux-x64.node');
  assert.equal(prebuildFileName('linux', 'arm64'), 'linux-arm64.node');
  assert.equal(prebuildFileName('win32', 'x64'), 'win32-x64.node');
  assert.equal(prebuildFileName('mas', 'arm64'), 'darwin-arm64.node');
});

test('打包配置不再整段排除 darwin / linux 预编译包', () => {
  assert.match(ymlRules, /node_modules\/better-sqlite3\/prebuilds\/\$\{platform\}-\$\{arch\}\.node/);
  assert.doesNotMatch(ymlRules, /prebuilds\/darwin-\*/);
  assert.doesNotMatch(ymlRules, /prebuilds\/linux\*/);
  assert.match(ymlRules, /afterPack:\s*tools\/verify-native\.cjs/);
});

test('mac 显式 ad-hoc，避免 CSC_IDENTITY_AUTO_DISCOVERY=false 时连签名都不打', () => {
  assert.match(yml, /identity:\s*"-"/);
  assert.match(yml, /hardenedRuntime:\s*true/);
  assert.match(yml, /gatekeeperAssess:\s*false/);
  assert.match(workflow, /CSC_IDENTITY_AUTO_DISCOVERY:\s*'false'/);
  assert.ok(fs.existsSync(path.join(root, 'build', 'entitlements.mac.plist')));
  assert.ok(fs.existsSync(path.join(root, 'build', 'entitlements.mac.inherit.plist')));
  const entitlements = fs.readFileSync(path.join(root, 'build', 'entitlements.mac.plist'), 'utf8');
  assert.match(entitlements, /com\.apple\.security\.cs\.disable-library-validation/);
  assert.match(entitlements, /com\.apple\.security\.cs\.allow-jit/);
});

test('Windows 强制签名，证书主体留给 elifia-flora 的 pfx', () => {
  assert.match(yml, /forceCodeSigning:\s*true/);
  assert.match(yml, /signingHashAlgorithms:\s*\[sha256\]/);
  const ps1 = fs.readFileSync(path.join(root, 'tools', 'win-sign-cert.ps1'), 'utf8');
  assert.match(ps1, /CN=elifia-flora/);
  const dist = fs.readFileSync(path.join(root, 'tools', 'dist-win.mjs'), 'utf8');
  assert.match(dist, /WIN_CSC_LINK/);
});
