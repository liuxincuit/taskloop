const { createHttpClient } = require('./youTrack.js');

function escapeCql(value) {
  return value.replace(/"/g, '\\"');
}

function buildCql(rule) {
  const creator = !rule.assignee || rule.assignee === 'me'
    ? 'creator = currentUser()'
    : `creator = "${escapeCql(rule.assignee)}"`;
  const labels = rule.labels.map((label) => `"${escapeCql(label)}"`).join(', ');
  return `${creator} AND type = page AND label in (${labels})`;
}

async function fetchWikiTasks(rule, { httpClient = createHttpClient('SUPERMAP_WIKI_TOKEN'), url, token }) {
  const searchUrl = new URL('/rest/api/search', url);
  searchUrl.searchParams.set('cql', buildCql(rule));
  searchUrl.searchParams.set('limit', '100');
  searchUrl.searchParams.set('includeArchivedSpaces', 'false');
  searchUrl.searchParams.set('expand', 'content.metadata.labels');
  const data = await httpClient(searchUrl, { token });
  const pages = (data?.results || [])
    .map((result) => result?.content)
    .filter((content) => content && content.id);
  const expandWorks = pages.length > 0 && pages[0].metadata !== undefined;
  const tasks = [];
  for (const page of pages) {
    let labels = (page.metadata?.labels?.results || []).map((label) => label.name);
    if (!expandWorks) {
      // 回退：search expand 未生效（如其他实例无 content. 前缀支持）时逐页获取标签
      const detailUrl = new URL(`/rest/api/content/${page.id}`, url);
      detailUrl.searchParams.set('expand', 'metadata.labels');
      const detail = await httpClient(detailUrl, { token });
      labels = (detail?.metadata?.labels?.results || []).map((label) => label.name);
    }
    tasks.push({
      id: page.id,
      idReadable: page.id,
      title: page.title,
      url: `${searchUrl.origin}/pages/viewpage.action?pageId=${page.id}`,
      labels,
    });
  }
  return tasks;
}

module.exports = { buildCql, fetchWikiTasks };
