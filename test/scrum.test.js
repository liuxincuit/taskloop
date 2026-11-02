const { test } = require('node:test');
const assert = require('node:assert');
const { buildJql, fetchTasks } = require('../src/scrum.js');

test('buildJql：与 jira 同构（标签 + 指派）', () => {
  assert.strictEqual(
    buildJql({ labels: ['taskloop'], notLabels: ['explored'], assignee: 'me' }),
    'labels IN ("taskloop") AND labels NOT IN ("explored") AND assignee = currentUser()'
  );
});

test('fetchTasks：拼装 search URL 并映射为 scrum browse 链接', async () => {
  const calls = [];
  const httpClient = async (url, opts) => {
    calls.push({ url: url.toString(), opts });
    return {
      issues: [
        { id: '20001', key: 'ISVS-1165', fields: { summary: '三维缓存优化', labels: ['taskloop'] } },
      ],
    };
  };
  const tasks = await fetchTasks(
    { labels: ['taskloop'] },
    { httpClient, url: 'https://scrum.supermap.work', token: 's' }
  );
  const u = new URL(calls[0].url);
  assert.strictEqual(u.origin, 'https://scrum.supermap.work');
  assert.strictEqual(u.pathname, '/rest/api/2/search');
  assert.strictEqual(u.searchParams.get('jql'), 'labels IN ("taskloop")');
  assert.strictEqual(u.searchParams.get('fields'), 'key,summary,labels');
  assert.deepStrictEqual(tasks, [{
    id: '20001',
    idReadable: 'ISVS-1165',
    title: '三维缓存优化',
    url: 'https://scrum.supermap.work/browse/ISVS-1165',
    labels: ['taskloop'],
  }]);
});

test('fetchTasks：空结果返回空数组', async () => {
  const tasks = await fetchTasks(
    { labels: ['x'] },
    { httpClient: async () => ({}), url: 'https://scrum.supermap.work', token: 's' }
  );
  assert.deepStrictEqual(tasks, []);
});
