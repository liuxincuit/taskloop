const { fetchTasks } = require('./youTrack.js');
const { fetchWikiTasks } = require('./wiki.js');
const { fetchTasks: fetchJiraTasks } = require('./jira.js');

// 新增来源：创建 src/<name>.js 导出 fetchTasks(rule, {httpClient, url, token})，
// 然后在此注册一行（fetch 实现 + token 环境变量名 + URL 环境变量名 + 默认 URL + placeholders）
const sources = {
  youtrack: {
    fetchTasks,
    tokenEnv: 'SUPERMAP_YOUTRACK_TOKEN',
    urlEnv: 'YOUTRACK_URL',
    defaultUrl: 'http://yt.ispeco.com:8099',
    placeholders: {
      youtrack_id: (task) => task.idReadable,
      youtrack_url: (task) => task.url,
    },
  },
  wiki: {
    fetchTasks: fetchWikiTasks,
    tokenEnv: 'SUPERMAP_WIKI_TOKEN',
    urlEnv: 'WIKI_URL',
    defaultUrl: 'https://wiki.ispeco.com',
    placeholders: {
      wiki_id: (task) => task.idReadable,
      wiki_url: (task) => task.url,
    },
  },
  jira: {
    fetchTasks: fetchJiraTasks,
    tokenEnv: 'SUPERMAP_JIRA_TOKEN',
    urlEnv: 'JIRA_URL',
    defaultUrl: 'https://jira.supermap.work',
    placeholders: {
      jira_id: (task) => task.idReadable,
      jira_url: (task) => task.url,
    },
  },
};

const SOURCE_KEYS = Object.keys(sources);

// 按来源组装占位符值表：来源占位符 + 规则级占位符（labels / not_labels）
function buildPlaceholders(sourceName, task, rule) {
  const map = {};
  for (const [name, fn] of Object.entries(sources[sourceName].placeholders)) {
    map[name] = fn(task);
  }
  map.labels = rule.labels.join(', ');
  map.not_labels = rule.notLabels.join(', ');
  return map;
}

module.exports = { sources, SOURCE_KEYS, buildPlaceholders };
