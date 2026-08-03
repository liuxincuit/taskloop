const { test } = require('node:test');
const assert = require('node:assert');
const { sources, SOURCE_KEYS } = require('../src/sources.js');

test('注册表包含 youtrack 与 wiki 两个来源', () => {
  assert.deepStrictEqual(SOURCE_KEYS, ['youtrack', 'wiki']);
  assert.strictEqual(typeof sources.youtrack.fetchTasks, 'function');
  assert.strictEqual(typeof sources.wiki.fetchTasks, 'function');
  assert.strictEqual(sources.youtrack.tokenEnv, 'SUPERMAP_YOUTRACK_TOKEN');
  assert.strictEqual(sources.youtrack.defaultUrl, 'http://yt.ispeco.com:8099');
  assert.strictEqual(sources.wiki.tokenEnv, 'SUPERMAP_WIKI_TOKEN');
  assert.strictEqual(sources.wiki.defaultUrl, 'https://wiki.ispeco.com');
});
