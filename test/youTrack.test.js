const { test } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { buildQuery, createHttpClient, fetchTasks } = require('../src/youTrack.js');

test('buildQuery：多个 labels 生成 hashtag 查询', () => {
  assert.strictEqual(buildQuery({ labels: ['readyed', 'clearly'] }),
    '#readyed #clearly');
});

test('buildQuery：assignee 为 me', () => {
  assert.strictEqual(
    buildQuery({ labels: ['readyed'], assignee: 'me' }),
    '#readyed assignee: me'
  );
});

test('buildQuery：assignee 为 login', () => {
  assert.strictEqual(
    buildQuery({ labels: ['readyed'], assignee: 'liuxin' }),
    '#readyed assignee: {liuxin}'
  );
});

test('buildQuery：无 assignee', () => {
  assert.strictEqual(buildQuery({ labels: ['readyed'] }), '#readyed');
});

test('fetchTasks：请求 URL 与返回结构映射', async () => {
  const calls = [];
  const httpClient = async (url) => {
    calls.push(url);
    return [
      { id: '1-1', idReadable: 'CS-5599', tags: [{ name: 'readyed' }, { name: 'clearly' }] },
      { id: '1-2', idReadable: 'CS-5601', tags: [] },
    ];
  };
  const result = await fetchTasks(
    { labels: ['readyed'], assignee: 'me' },
    { httpClient, url: 'http://yt.ispeco.com:8099', token: 't' }
  );
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].pathname, '/api/issues');
  assert.strictEqual(calls[0].searchParams.get('query'), '#readyed assignee: me');
  assert.strictEqual(calls[0].searchParams.get('fields'), 'id,idReadable,tags(id,name)');
  assert.strictEqual(calls[0].searchParams.get('$top'), '-1');
  assert.deepStrictEqual(result, [
    { id: '1-1', idReadable: 'CS-5599', labels: ['readyed', 'clearly'] },
    { id: '1-2', idReadable: 'CS-5601', labels: [] },
  ]);
});

test('fetchTasks：无 tags 时 labels 为空数组', async () => {
  const httpClient = async () => [{ id: '1', idReadable: 'CS-1' }];
  const result = await fetchTasks(
    { labels: ['a'] },
    { httpClient, url: 'http://yt.ispeco.com:8099', token: 't' }
  );
  assert.deepStrictEqual(result, [{ id: '1', idReadable: 'CS-1', labels: [] }]);
});

test('fetchTasks：httpClient 抛 401 认证错误', async () => {
  const httpClient = async () => { throw new Error('认证失败，请检查 SUPERMAP_YOUTRACK_TOKEN'); };
  await assert.rejects(
    fetchTasks({ labels: ['a'] }, { httpClient, url: 'http://yt.ispeco.com:8099', token: 't' }),
    /认证失败/
  );
});

test('fetchTasks：网络错误向上传播', async () => {
  const httpClient = async () => { throw new Error('网络错误: ECONNREFUSED'); };
  await assert.rejects(
    fetchTasks({ labels: ['a'] }, { httpClient, url: 'http://yt.ispeco.com:8099', token: 't' }),
    /网络错误/
  );
});

function startServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

const closeServer = (server) => new Promise((resolve) => server.close(resolve));

test('createHttpClient：200 返回 JSON', async () => {
  const server = await startServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('[{"id":"1"}]');
  });
  try {
    const client = createHttpClient();
    const url = new URL(`http://127.0.0.1:${server.address().port}/api/issues`);
    const data = await client(url, { token: 't' });
    assert.deepStrictEqual(data, [{ id: '1' }]);
  } finally {
    await closeServer(server);
  }
});

test('createHttpClient：401 抛认证失败', async () => {
  const server = await startServer((req, res) => {
    res.writeHead(401);
    res.end();
  });
  try {
    const client = createHttpClient();
    const url = new URL(`http://127.0.0.1:${server.address().port}/`);
    await assert.rejects(client(url, { token: 't' }), /认证失败/);
  } finally {
    await closeServer(server);
  }
});

test('createHttpClient：非 2xx 抛 HTTP 状态错误', async () => {
  const server = await startServer((req, res) => {
    res.writeHead(500);
    res.end();
  });
  try {
    const client = createHttpClient();
    const url = new URL(`http://127.0.0.1:${server.address().port}/`);
    await assert.rejects(client(url, { token: 't' }), /HTTP 500/);
  } finally {
    await closeServer(server);
  }
});

test('createHttpClient：超时抛请求超时', async () => {
  const server = await startServer((req, res) => {
    const timer = setTimeout(() => res.end(), 1000);
    res.on('close', () => clearTimeout(timer));
  });
  try {
    const client = createHttpClient();
    const url = new URL(`http://127.0.0.1:${server.address().port}/`);
    await assert.rejects(client(url, { token: 't', timeoutMs: 200 }), /请求超时/);
  } finally {
    await closeServer(server);
  }
});

test('createHttpClient：401 消息使用 tokenEnvName 参数', async () => {
  const server = await startServer((req, res) => {
    res.writeHead(401);
    res.end();
  });
  try {
    const client = createHttpClient('SUPERMAP_WIKI_TOKEN');
    const url = new URL(`http://127.0.0.1:${server.address().port}/`);
    await assert.rejects(client(url, { token: 't' }), /SUPERMAP_WIKI_TOKEN/);
  } finally {
    await closeServer(server);
  }
});

test('createHttpClient：400 提示查询语法错误（spec 错误处理表）', async () => {
  const server = await startServer((req, res) => {
    res.writeHead(400);
    res.end();
  });
  try {
    const client = createHttpClient();
    const url = new URL(`http://127.0.0.1:${server.address().port}/`);
    await assert.rejects(client(url, { token: 't' }), /查询语法错误/);
  } finally {
    await closeServer(server);
  }
});
