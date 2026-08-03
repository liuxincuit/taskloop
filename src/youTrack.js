const http = require('node:http');
const https = require('node:https');

function buildQuery(rule) {
  // YouTrack 标签查询用 hashtag 语法：`tags: {x}` 匹配的是 State 字段而非标签；
  // 多 hashtag 空格分隔是 OR 语义，AND 精确过滤由 filterTasks 本地兜底。
  const parts = rule.labels.map((label) => `#${label}`);
  if (rule.assignee) {
    parts.push(rule.assignee === 'me' ? 'assignee: me' : `assignee: {${rule.assignee}}`);
  }
  return parts.join(' ');
}

function createHttpClient(tokenEnvName = 'SUPERMAP_YOUTRACK_TOKEN') {
  return (url, { token, timeoutMs = 30000 }) =>
    new Promise((resolve, reject) => {
      const mod = url.protocol === 'https:' ? https : http;
      const req = mod.request(
        url,
        {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/json',
            'User-Agent': 'taskloop/1.0',
          },
          timeout: timeoutMs,
        },
        (res) => {
          let data = '';
          res.on('data', (chunk) => { data += chunk; });
          res.on('end', () => {
            if (res.statusCode >= 200 && res.statusCode < 300) {
              try {
                resolve(data ? JSON.parse(data) : null);
              } catch (err) {
                reject(new Error(`响应解析失败: ${err.message}`));
              }
            } else if (res.statusCode === 401) {
              reject(new Error(`认证失败，请检查 ${tokenEnvName}`));
            } else if (res.statusCode === 400) {
              reject(new Error(`HTTP 400: 查询语法错误，请检查规则配置与标签转义（${tokenEnvName}）`));
            } else {
              reject(new Error(`HTTP ${res.statusCode}`));
            }
          });
        }
      );
      req.on('error', (err) => reject(new Error(`网络错误: ${err.message}`)));
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('请求超时'));
      });
      req.end();
    });
}

async function fetchTasks(rule, { httpClient = createHttpClient(), url, token }) {
  const apiUrl = new URL('/api/issues', url);
  apiUrl.searchParams.set('$top', '-1');
  apiUrl.searchParams.set('fields', 'id,idReadable,tags(id,name)');
  apiUrl.searchParams.set('query', buildQuery(rule));
  const data = await httpClient(apiUrl, { token });
  return (data || []).map((issue) => ({
    id: issue.id,
    idReadable: issue.idReadable,
    labels: (issue.tags || []).map((tag) => tag.name),
  }));
}

module.exports = { buildQuery, createHttpClient, fetchTasks };
