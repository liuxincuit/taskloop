const { test } = require('node:test');
const assert = require('node:assert');
const { sources, SOURCE_KEYS, buildPlaceholders } = require('../src/sources.js');

test('注册表包含 youtrack、wiki、jira 三个来源', () => {
  assert.deepStrictEqual(SOURCE_KEYS, ['youtrack', 'wiki', 'jira']);
  assert.strictEqual(typeof sources.youtrack.fetchTasks, 'function');
  assert.strictEqual(typeof sources.wiki.fetchTasks, 'function');
  assert.strictEqual(typeof sources.jira.fetchTasks, 'function');
  assert.strictEqual(sources.youtrack.tokenEnv, 'SUPERMAP_YOUTRACK_TOKEN');
  assert.strictEqual(sources.youtrack.defaultUrl, 'http://yt.ispeco.com:8099');
  assert.strictEqual(sources.wiki.tokenEnv, 'SUPERMAP_WIKI_TOKEN');
  assert.strictEqual(sources.wiki.defaultUrl, 'https://wiki.ispeco.com');
  assert.strictEqual(sources.jira.tokenEnv, 'SUPERMAP_JIRA_TOKEN');
  assert.strictEqual(sources.jira.urlEnv, 'JIRA_URL');
  assert.strictEqual(sources.jira.defaultUrl, 'https://jira.supermap.work');
});

test('占位符声明：youtrack 提供 id 与 url', () => {
  const task = { idReadable: 'CS-1', url: 'http://yt' };
  assert.strictEqual(sources.youtrack.placeholders.youtrack_id(task), 'CS-1');
  assert.strictEqual(sources.youtrack.placeholders.youtrack_url(task), 'http://yt');
});

test('占位符声明：wiki 提供 id 与 url', () => {
  const task = { idReadable: '123', url: 'http://w' };
  assert.strictEqual(sources.wiki.placeholders.wiki_id(task), '123');
  assert.strictEqual(sources.wiki.placeholders.wiki_url(task), 'http://w');
});

test('占位符声明：jira 提供 id 与 url', () => {
  const task = { idReadable: 'ISVJ-1', url: 'http://j' };
  assert.strictEqual(sources.jira.placeholders.jira_id(task), 'ISVJ-1');
  assert.strictEqual(sources.jira.placeholders.jira_url(task), 'http://j');
});

test('buildPlaceholders：来源占位符 + 规则级占位符', () => {
  const rule = { labels: ['a', 'b'], notLabels: ['c'] };
  const task = { idReadable: 'ISVJ-1', url: 'http://j' };
  assert.deepStrictEqual(buildPlaceholders('jira', task, rule), {
    jira_id: 'ISVJ-1',
    jira_url: 'http://j',
    labels: 'a, b',
    not_labels: 'c',
  });
});

test('buildPlaceholders：notLabels 为空时 not_labels 为空字符串', () => {
  const rule = { labels: ['a'], notLabels: [] };
  const task = { idReadable: 'CS-1', url: 'http://yt' };
  assert.deepStrictEqual(buildPlaceholders('youtrack', task, rule), {
    youtrack_id: 'CS-1',
    youtrack_url: 'http://yt',
    labels: 'a',
    not_labels: '',
  });
});
