const { createHttpClient } = require('./youTrack.js');
const { buildJql, fetchTasks: fetchJiraTasks } = require('./jira.js');

// Scrum（scrum.supermap.work）是 Jira Server 内核：任务 key 形如 ISVS-1165，
// 查询与 browse 链接格式与 jira 来源一致，因此复用 buildJql 与映射逻辑，
// 仅默认 httpClient 指向 SCRUM 的 token 环境变量。
async function fetchTasks(rule, { httpClient = createHttpClient('SUPERMAP_SCRUM_TOKEN'), url, token }) {
  return fetchJiraTasks(rule, { httpClient, url, token });
}

module.exports = { buildJql, fetchTasks };
