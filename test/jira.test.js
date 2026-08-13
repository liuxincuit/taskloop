const { test } = require('node:test');
const assert = require('node:assert');
const { buildJql, fetchTasks } = require('../src/jira.js');

test('buildJql：多标签生成 labels IN', () => {
  assert.strictEqual(
    buildJql({ labels: ['ready', 'explorer'] }),
    'labels IN ("ready", "explorer")'
  );
});

test('buildJql：notLabels 生成 labels NOT IN', () => {
  assert.strictEqual(
    buildJql({ labels: ['ready'], notLabels: ['explored', 'done'] }),
    'labels IN ("ready") AND labels NOT IN ("explored", "done")'
  );
});

test('buildJql：assignee 为 me 映射 currentUser', () => {
  assert.strictEqual(
    buildJql({ labels: ['ready'], assignee: 'me' }),
    'labels IN ("ready") AND assignee = currentUser()'
  );
});

test('buildJql：具名 assignee', () => {
  assert.strictEqual(
    buildJql({ labels: ['ready'], assignee: 'zhangsan' }),
    'labels IN ("ready") AND assignee = "zhangsan"'
  );
});

test('buildJql：notLabels 为空或未提供时不生成 NOT IN 子句', () => {
  assert.strictEqual(buildJql({ labels: ['a'], notLabels: [] }), 'labels IN ("a")');
  assert.strictEqual(buildJql({ labels: ['a'] }), 'labels IN ("a")');
});

test('buildJql：assignee 为空或未提供时不生成 assignee 子句', () => {
  assert.strictEqual(buildJql({ labels: ['a'], assignee: '' }), 'labels IN ("a")');
  assert.strictEqual(buildJql({ labels: ['a'] }), 'labels IN ("a")');
});

test('buildJql：标签内双引号转义', () => {
  assert.strictEqual(
    buildJql({ labels: ['he said "hi"'] }),
    'labels IN ("he said \\"hi\\"")'
  );
});

test('fetchTasks：拼装 search URL 并映射任务', async () => {
  const calls = [];
  const httpClient = async (url, opts) => {
    calls.push({ url: url.toString(), opts });
    return {
      issues: [
        { id: '10001', key: 'ISVJ-12228', fields: { summary: '五星缺陷', labels: ['2026M8-1'] } },
      ],
    };
  };
  const tasks = await fetchTasks(
    { labels: ['2026M8-1'] },
    { httpClient, url: 'https://jira.supermap.work', token: 't' }
  );
  const u = new URL(calls[0].url);
  assert.strictEqual(u.pathname, '/rest/api/2/search');
  assert.strictEqual(u.searchParams.get('jql'), 'labels IN ("2026M8-1")');
  assert.strictEqual(u.searchParams.get('fields'), 'key,summary,labels');
  assert.strictEqual(u.searchParams.get('maxResults'), '100');
  assert.deepStrictEqual(tasks, [{
    id: '10001',
    idReadable: 'ISVJ-12228',
    title: '五星缺陷',
    url: 'https://jira.supermap.work/browse/ISVJ-12228',
    labels: ['2026M8-1'],
  }]);
});

test('fetchTasks：issue 缺 fields 时 title 为 undefined 且 labels 为空数组', async () => {
  const tasks = await fetchTasks(
    { labels: ['x'] },
    {
      httpClient: async () => ({ issues: [{ id: '1', key: 'K-1' }] }),
      url: 'https://jira.supermap.work',
      token: 't',
    }
  );
  assert.deepStrictEqual(tasks, [{
    id: '1',
    idReadable: 'K-1',
    title: undefined,
    url: 'https://jira.supermap.work/browse/K-1',
    labels: [],
  }]);
});

test('fetchTasks：空结果返回空数组', async () => {
  const tasks = await fetchTasks(
    { labels: ['x'] },
    { httpClient: async () => ({}), url: 'https://jira.supermap.work', token: 't' }
  );
  assert.deepStrictEqual(tasks, []);
});
