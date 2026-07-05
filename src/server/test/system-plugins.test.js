/**
 * Integration tests for the system-plugins overlay.
 *
 * Verifies:
 *  1. init() loads plugins from src/plugins AND vendor/plugins.
 *  2. getSystemPluginDir() returns the correct rootDir per plugin id.
 *  3. tryGetSystemFilePath() resolves files from both directories.
 *  4. Duplicate id: src/plugins wins (first-wins precedence).
 *  5. ENOENT on vendor/plugins is handled gracefully (warn + continue).
 *  6. Path-traversal is blocked.
 */

import assert from 'assert/strict';
import fs from 'fs';
const fsp = fs.promises;
import os from 'os';
import path from 'path';
import { test } from 'node:test';

import {
  getSystemPluginIds,
  getSystemPluginDir,
  tryGetSystemFilePath,
  _initFromDirs,
} from '../system-plugins.js';

// Build a minimal plugin fixture: <dir>/<id>/manifest.json + a main.js
async function makePlugin(dir, id) {
  const pluginDir = path.join(dir, id);
  await fsp.mkdir(pluginDir, { recursive: true });
  await fsp.writeFile(
    path.join(pluginDir, 'manifest.json'),
    JSON.stringify({ id, name: id, version: '0.0.1', minAppVersion: '0.15.0', author: 'test' }),
  );
  await fsp.writeFile(path.join(pluginDir, 'main.js'), `// ${id} plugin`);
  return pluginDir;
}

// Helper to reset state and init with fixture dirs
function initWithDirs(srcDir, vendorDir) {
  _initFromDirs(srcDir, vendorDir);
}

// ─── tests ──────────────────────────────────────────────────────────────────

test('init loads plugins from src/plugins and vendor/plugins', async (t) => {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'sp-test-'));
  t.after(async () => fsp.rm(tmp, { recursive: true, force: true }));

  const srcDir    = path.join(tmp, 'src', 'plugins');
  const vendorDir = path.join(tmp, 'vendor', 'plugins');
  await fsp.mkdir(srcDir,    { recursive: true });
  await fsp.mkdir(vendorDir, { recursive: true });

  await makePlugin(srcDir,    'obsidian-web-layout');
  await makePlugin(vendorDir, 'obsidian-livesync');

  initWithDirs(srcDir, vendorDir);

  const ids = getSystemPluginIds();
  assert.ok(ids.includes('obsidian-web-layout'), 'src plugin loaded');
  assert.ok(ids.includes('obsidian-livesync'),   'vendor plugin loaded');
  assert.equal(ids.length, 2, 'exactly 2 plugins');
});

test('getSystemPluginDir returns correct rootDir per id', async (t) => {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'sp-test-'));
  t.after(async () => fsp.rm(tmp, { recursive: true, force: true }));

  const srcDir    = path.join(tmp, 'src', 'plugins');
  const vendorDir = path.join(tmp, 'vendor', 'plugins');
  await fsp.mkdir(srcDir,    { recursive: true });
  await fsp.mkdir(vendorDir, { recursive: true });

  const srcPluginDir    = await makePlugin(srcDir,    'obsidian-web-layout');
  const vendorPluginDir = await makePlugin(vendorDir, 'obsidian-livesync');

  initWithDirs(srcDir, vendorDir);

  assert.equal(getSystemPluginDir('obsidian-web-layout'), srcPluginDir,    'src plugin dir correct');
  assert.equal(getSystemPluginDir('obsidian-livesync'),   vendorPluginDir, 'vendor plugin dir correct');
  assert.equal(getSystemPluginDir('nonexistent'),         null,            'unknown id returns null');
});

test('tryGetSystemFilePath resolves files from both src and vendor', async (t) => {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'sp-test-'));
  t.after(async () => fsp.rm(tmp, { recursive: true, force: true }));

  const srcDir    = path.join(tmp, 'src', 'plugins');
  const vendorDir = path.join(tmp, 'vendor', 'plugins');
  await fsp.mkdir(srcDir,    { recursive: true });
  await fsp.mkdir(vendorDir, { recursive: true });

  const srcPluginDir    = await makePlugin(srcDir,    'obsidian-web-layout');
  const vendorPluginDir = await makePlugin(vendorDir, 'obsidian-livesync');

  initWithDirs(srcDir, vendorDir);

  const srcResolved = tryGetSystemFilePath('.obsidian/plugins/obsidian-web-layout/main.js');
  assert.equal(srcResolved, path.join(srcPluginDir, 'main.js'), 'src file resolves');

  const vendorResolved = tryGetSystemFilePath('.obsidian/plugins/obsidian-livesync/main.js');
  assert.equal(vendorResolved, path.join(vendorPluginDir, 'main.js'), 'vendor file resolves');

  const noFile = tryGetSystemFilePath('.obsidian/plugins/obsidian-livesync/nonexistent.js');
  assert.equal(noFile, null, 'missing file returns null');
});

test('duplicate id: src/plugins wins over vendor/plugins', async (t) => {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'sp-test-'));
  t.after(async () => fsp.rm(tmp, { recursive: true, force: true }));

  const srcDir    = path.join(tmp, 'src', 'plugins');
  const vendorDir = path.join(tmp, 'vendor', 'plugins');
  await fsp.mkdir(srcDir,    { recursive: true });
  await fsp.mkdir(vendorDir, { recursive: true });

  // Same id in both directories.
  const srcPluginDir = await makePlugin(srcDir,    'shared-plugin');
  await makePlugin(vendorDir, 'shared-plugin');

  // Write a unique marker file only in the src copy.
  await fsp.writeFile(path.join(srcPluginDir, 'src-marker.txt'), 'from src');

  initWithDirs(srcDir, vendorDir);

  const ids = getSystemPluginIds();
  assert.equal(ids.filter(id => id === 'shared-plugin').length, 1, 'id appears once');

  const dir = getSystemPluginDir('shared-plugin');
  assert.equal(dir, srcPluginDir, 'src/plugins wins');

  // File that only exists in src copy should resolve.
  const marker = tryGetSystemFilePath('.obsidian/plugins/shared-plugin/src-marker.txt');
  assert.ok(marker && marker.endsWith('src-marker.txt'), 'marker from src resolves');
});

test('ENOENT on vendor/plugins is handled gracefully', async (t) => {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'sp-test-'));
  t.after(async () => fsp.rm(tmp, { recursive: true, force: true }));

  const srcDir    = path.join(tmp, 'src', 'plugins');
  // Intentionally do NOT create vendor/plugins.
  const vendorDir = path.join(tmp, 'vendor', 'plugins');
  await fsp.mkdir(srcDir, { recursive: true });

  await makePlugin(srcDir, 'obsidian-web-layout');

  // Must not throw even though vendor/plugins doesn't exist.
  assert.doesNotThrow(() => initWithDirs(srcDir, vendorDir), 'init does not throw on missing vendor/plugins');

  const ids = getSystemPluginIds();
  assert.ok(ids.includes('obsidian-web-layout'), 'src plugin still loaded');
  assert.equal(ids.length, 1, 'exactly 1 plugin');
});

test('path traversal is blocked', async (t) => {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'sp-test-'));
  t.after(async () => fsp.rm(tmp, { recursive: true, force: true }));

  const srcDir    = path.join(tmp, 'src', 'plugins');
  const vendorDir = path.join(tmp, 'vendor', 'plugins');
  await fsp.mkdir(srcDir,    { recursive: true });
  await fsp.mkdir(vendorDir, { recursive: true });

  await makePlugin(srcDir, 'my-plugin');

  initWithDirs(srcDir, vendorDir);

  // Attempt path traversal.
  const result = tryGetSystemFilePath('.obsidian/plugins/my-plugin/../../etc/passwd');
  assert.equal(result, null, 'path traversal blocked');
});
