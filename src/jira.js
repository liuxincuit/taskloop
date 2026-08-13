const { createHttpClient } = require('./youTrack.js');

function escapeJql(value) {
  return value.replace(/"/g, '\\"');
}

function buildJql(rule) {
  const parts = [`labels IN (${rule.labels.map((l) => `"${escapeJql(l)}"`).join(', ')})`];
  if (rule.notLabels && rule.notLabels.length > 0) {
    parts.push(`labels NOT IN (${rule.notLabels.map((l) => `"${escapeJql(l)}"`).join(', ')})`);
  }
  if (rule.assignee) {
    parts.push(rule.assignee === 'me' ? 'assignee = currentUser()' : `assignee = "${escapeJql(rule.assignee)}"`);
  }
  return parts.join(' AND ');
}

async function fetchTasks(rule, { httpClient = createHttpClient('SUPERMAP_JIRA_TOKEN'), url, token }) {
  const searchUrl = new URL('/rest/api/2/search', url);
  searchUrl.searchParams.set('jql', buildJql(rule));
  searchUrl.searchParams.set('fields', 'key,summary,labels');
  searchUrl.searchParams.set('maxResults', '100');
  const data = await httpClient(searchUrl, { token });
  return (data?.issues || []).map((issue) => ({
    id: issue.id,
    idReadable: issue.key,
    title: issue.fields?.summary,
    url: `${searchUrl.origin}/browse/${issue.key}`,
    labels: issue.fields?.labels || [],
  }));
}

module.exports = { buildJql, fetchTasks };
