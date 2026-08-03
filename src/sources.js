const { fetchTasks } = require('./youTrack.js');
const { fetchWikiTasks } = require('./wiki.js');

// 新增来源：创建 src/<name>.js 导出 fetchTasks(rule, {httpClient, url, token})，
// 然后在此注册一行（fetch 实现 + token 环境变量名 + URL 环境变量名 + 默认 URL）
const sources = {
  youtrack: {
    fetchTasks,
    tokenEnv: 'SUPERMAP_YOUTRACK_TOKEN',
    urlEnv: 'YOUTRACK_URL',
    defaultUrl: 'http://yt.ispeco.com:8099',
  },
  wiki: {
    fetchTasks: fetchWikiTasks,
    tokenEnv: 'SUPERMAP_WIKI_TOKEN',
    urlEnv: 'WIKI_URL',
    defaultUrl: 'https://wiki.ispeco.com',
  },
};

const SOURCE_KEYS = Object.keys(sources);

module.exports = { sources, SOURCE_KEYS };
