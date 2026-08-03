const { test } = require('node:test');
const assert = require('node:assert');
const { buildCql, fetchWikiTasks } = require('../src/wiki.js');

test('buildCql：assignee 缺省用 currentUser', () => {
  assert.strictEqual(
    buildCql({ labels: ['ready'] }),
    'creator = currentUser() AND type = page AND label in ("ready")'
  );
});

test('buildCql：assignee 为 me 且多标签', () => {
  assert.strictEqual(
    buildCql({ labels: ['ready', 'explorer'], assignee: 'me' }),
    'creator = currentUser() AND type = page AND label in ("ready", "explorer")'
  );
});

test('buildCql：assignee 为具体用户名', () => {
  assert.strictEqual(
    buildCql({ labels: ['ready'], assignee: 'liuxin1' }),
    'creator = "liuxin1" AND type = page AND label in ("ready")'
  );
});

test('buildCql：标签含双引号时转义', () => {
  assert.strictEqual(
    buildCql({ labels: ['a"b'] }),
    'creator = currentUser() AND type = page AND label in ("a\\"b")'
  );
});

test('fetchWikiTasks：搜索后逐页获取标签并归一化', async () => {
  const calls = [];
  const httpClient = async (url) => {
    calls.push(url);
    if (url.pathname === '/rest/api/search') {
      return {
        results: [
          { content: { id: '111', title: '页面A', _links: { webui: '/pages/viewpage.action?pageId=111' } } },
          { content: { id: '222', title: '页面B' } },
        ],
      };
    }
    if (url.pathname === '/rest/api/content/111') {
      return { id: '111', metadata: { labels: { results: [{ name: 'ready' }, { name: 'explored' }] } } };
    }
    if (url.pathname === '/rest/api/content/222') {
      return { id: '222', metadata: { labels: { results: [] } } };
    }
    throw new Error(`unexpected pathname: ${url.pathname}`);
  };
  const result = await fetchWikiTasks(
    { labels: ['ready'], assignee: 'me' },
    { httpClient, url: 'https://wiki.ispeco.com', token: 't' }
  );
  assert.strictEqual(calls.length, 3);
  assert.strictEqual(calls[0].pathname, '/rest/api/search');
  assert.strictEqual(
    calls[0].searchParams.get('cql'),
    'creator = currentUser() AND type = page AND label in ("ready")'
  );
  assert.strictEqual(calls[0].searchParams.get('limit'), '100');
  assert.strictEqual(calls[1].pathname, '/rest/api/content/111');
  assert.strictEqual(calls[1].searchParams.get('expand'), 'metadata.labels');
  assert.deepStrictEqual(result, [
    { id: '111', idReadable: '111', title: '页面A', url: 'https://wiki.ispeco.com/pages/viewpage.action?pageId=111', labels: ['ready', 'explored'] },
    { id: '222', idReadable: '222', title: '页面B', url: 'https://wiki.ispeco.com/pages/viewpage.action?pageId=222', labels: [] },
  ]);
});

test('fetchWikiTasks：搜索结果为空', async () => {
  const httpClient = async () => ({ results: [] });
  const result = await fetchWikiTasks(
    { labels: ['ready'] },
    { httpClient, url: 'https://wiki.ispeco.com', token: 't' }
  );
  assert.deepStrictEqual(result, []);
});

test('fetchWikiTasks：搜索失败向上传播', async () => {
  const httpClient = async () => { throw new Error('HTTP 400'); };
  await assert.rejects(
    fetchWikiTasks({ labels: ['ready'] }, { httpClient, url: 'https://wiki.ispeco.com', token: 't' }),
    /HTTP 400/
  );
});

test('fetchWikiTasks：页面 URL 使用 url.origin 保留协议与端口', async () => {
  const httpClient = async (url) => {
    if (url.pathname === '/rest/api/search') {
      return { results: [{ content: { id: '111', title: 'A' } }] };
    }
    return { id: '111', metadata: { labels: { results: [] } } };
  };
  const result = await fetchWikiTasks(
    { labels: ['ready'] },
    { httpClient, url: 'http://wiki.ispeco.com:8080', token: 't' }
  );
  assert.strictEqual(result[0].url, 'http://wiki.ispeco.com:8080/pages/viewpage.action?pageId=111');
});

test('fetchWikiTasks：expand 生效时直接带出标签（不逐页）', async () => {
  const calls = [];
  const httpClient = async (url) => {
    calls.push(url);
    return {
      results: [
        { content: { id: '111', title: '页面A', metadata: { labels: { results: [{ name: 'ready' }, { name: 'explored' }] } } } },
      ],
    };
  };
  const result = await fetchWikiTasks(
    { labels: ['ready'] },
    { httpClient, url: 'https://wiki.ispeco.com', token: 't' }
  );
  assert.strictEqual(calls.length, 1); // 只调 search，expand 带出标签，不逐页
  assert.deepStrictEqual(result, [
    { id: '111', idReadable: '111', title: '页面A', url: 'https://wiki.ispeco.com/pages/viewpage.action?pageId=111', labels: ['ready', 'explored'] },
  ]);
});
