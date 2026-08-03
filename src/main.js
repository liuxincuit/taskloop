const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { filterTasks } = require('./filter.js');
const { renderTemplate } = require('./template.js');
const { createHttpClient } = require('./youTrack.js');
const { sources, SOURCE_KEYS } = require('./sources.js');
const { runPi } = require('./piRunner.js');
const { loadConfig } = require('./config.js');

function timestamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function log(msg) {
  console.log(`[${timestamp()}] ${msg}`);
}

function sleep(ms, shouldStop) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      clearInterval(interval);
      resolve();
    }, ms);
    const interval = setInterval(() => {
      if (shouldStop?.()) {
        clearTimeout(timer);
        clearInterval(interval);
        resolve();
      }
    }, 200);
    interval.unref?.();
  });
}

function resolveEnv(config, env = process.env) {
  const usedSources = new Set(config.rules.map((rule) => rule.source ?? 'youtrack')); // 与 runCycle 的兜底一致
  const urls = {};
  const tokens = {};
  for (const name of SOURCE_KEYS) {
    urls[name] = env[sources[name].urlEnv] || sources[name].defaultUrl;
    if (usedSources.has(name)) {
      const token = env[sources[name].tokenEnv];
      if (!token) {
        throw new Error(`未设置 ${sources[name].tokenEnv} 环境变量`);
      }
      tokens[name] = token;
    }
  }
  return { urls, tokens };
}

async function runCycle({ config, deps, round }) {
  log(`轮次 ${round} 开始`);
  const processed = new Set();
  for (const rule of config.rules) {
    if (deps.shouldStop?.()) return;
    const labelDesc = rule.labels.join(',');
    const sourceName = rule.source ?? 'youtrack'; // loadConfig 已保证存在；兜底缺省兼容直接构造 config 的调用（测试）
    const source = deps.sources[sourceName];
    let tasks;
    try {
      tasks = await source.fetchTasks(rule, {
        httpClient: deps.httpClient?.[sourceName], // 按来源取 client：401/400 消息指向对应来源的 tokenEnv；可选链使 mock 传 null 得 undefined、各来源 fetch 默认参数生效
        url: deps.urls[sourceName],
        token: deps.tokens[sourceName],
      });
    } catch (err) {
      log(`[${labelDesc}] 抓取失败: ${err.message}`);
      continue;
    }
    const candidates = filterTasks(tasks, rule.labels, rule.notLabels);
    if (candidates.length === 0) {
      log(`[${labelDesc}] 无候选任务`);
      continue;
    }
    log(`[${labelDesc}] 抓取到 ${candidates.length} 个候选任务`);
    for (const task of candidates) {
      if (deps.shouldStop?.()) return;
      if (processed.has(task.idReadable)) continue;
      processed.add(task.idReadable);
      let template;
      try {
        template = fs.readFileSync(rule.promptTemplate, 'utf8');
      } catch (err) {
        log(`[${task.idReadable}] 模板读取失败: ${err.message}`);
        continue;
      }
      const prompt = renderTemplate(template, {
        youtrackId: task.idReadable,
        wikiUrl: task.url,
      });
      log(`[${task.idReadable}] 开始执行（模板: ${rule.promptTemplate}）`);
      const { exitCode } = await deps.runPi(prompt, {
        cwd: deps.cwd,
        piPath: deps.piPath,
        sessionDir: config.sessionDir,
        onChild: deps.onChild,
      });
      log(`[${task.idReadable}] 完成（退出码 ${exitCode}）`);
    }
  }
  log(`轮次 ${round} 结束，等待 ${config.intervalSeconds} 秒`);
}

async function main(argv = process.argv) {
  const configPath = path.resolve(argv[2] || 'config.json');
  let config;
  try {
    config = loadConfig(configPath);
  } catch (err) {
    console.error(`配置错误: ${err.message}`);
    process.exit(1);
  }
  let env;
  try {
    env = resolveEnv(config);
  } catch (err) {
    console.error(`环境错误: ${err.message}`);
    process.exit(1);
  }
  let running = true;
  let currentChild = null;
  let sigintTimer = null;
  const deps = {
    // 按来源创建 client：401/400 消息指向对应来源的 token 环境变量（spec 错误处理表：wiki 401 提示检查 SUPERMAP_WIKI_TOKEN）。
    // 不能用共享单一 client——那会覆盖 wiki.js 默认参数，导致生产路径 wiki 401 误导指向 YOUTRACK_TOKEN
    httpClient: Object.fromEntries(
      SOURCE_KEYS.map((name) => [name, createHttpClient(sources[name].tokenEnv)])
    ),
    sources,
    runPi,
    urls: env.urls,
    tokens: env.tokens,
    cwd: path.resolve(__dirname, '..'),
    piPath: 'pi',
    onChild: (child) => { currentChild = child; },
    shouldStop: () => !running,
  };
  process.on('SIGINT', () => {
    log('收到 Ctrl+C，正在退出...');
    running = false;
    if (currentChild) {
      currentChild.kill();
      if (process.platform === 'win32' && currentChild.pid) {
        spawnSync('taskkill', ['/pid', String(currentChild.pid), '/T', '/F']);
      }
    }
    sigintTimer = setTimeout(() => process.exit(0), 3000);
    sigintTimer.unref();
  });
  let round = 1;
  while (running) {
    try {
      await runCycle({ config, deps, round });
    } catch (err) {
      log(`本轮异常: ${err.message}`);
    }
    if (!running) break;
    await sleep(config.intervalSeconds * 1000, () => !running);
    round += 1;
  }
  clearTimeout(sigintTimer);
  log('已退出');
  process.exit(0);
}

module.exports = { timestamp, log, sleep, runCycle, resolveEnv, main };

if (require.main === module) {
  main();
}
