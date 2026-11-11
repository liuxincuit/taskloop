const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Worker } = require('./worker.js');
const { StateStore } = require('./state.js');
const { createDefaultConfig } = require('./config.js');

const DEFAULT_CONFIG_PATH = path.join(os.homedir(), '.taskloop', 'config.json');

/** 首次启动且默认位置没有配置时，生成一份可直接运行的配置（含模板文件） */
function ensureConfigFile(configPath) {
  if (fs.existsSync(configPath)) return false;

  const configDir = path.dirname(configPath);
  fs.mkdirSync(configDir, { recursive: true });

  const templateDir = path.join(configDir, 'templates');
  fs.mkdirSync(templateDir, { recursive: true });
  const bundledTemplate = path.join(__dirname, '..', 'templates', 'analyze.md');
  const targetTemplate = path.join(templateDir, 'analyze.md');
  if (!fs.existsSync(targetTemplate) && fs.existsSync(bundledTemplate)) {
    fs.copyFileSync(bundledTemplate, targetTemplate);
  }

  fs.writeFileSync(configPath, `${JSON.stringify(createDefaultConfig(), null, 2)}\n`, 'utf8');
  return true;
}

/** CLI 模式也落盘：重启后能恢复历史，被硬杀时能标出中断的任务 */
function createStateStore(configPath) {
  const store = new StateStore({
    file: path.join(path.dirname(configPath), 'state.json'),
    onError: (message) => process.stderr.write(`[state] ${message}\n`),
  });
  store.load();
  return store;
}

/**
 * CLI 入口：只跑循环，不起页面。
 * 页面模式见 src/server.js，两者共用同一个 Worker。
 */
async function main(argv = process.argv) {
  const configPath = path.resolve(argv[2] || DEFAULT_CONFIG_PATH);

  let created = false;
  try {
    created = ensureConfigFile(configPath);
  } catch (err) {
    console.error(`配置初始化失败: ${err.message}`);
    process.exit(1);
  }
  if (created) {
    console.log(`已生成默认配置: ${configPath}`);
  }

  const worker = new Worker({ configPath, cwd: process.cwd(), stateStore: createStateStore(configPath) });

  try {
    await worker.start();
  } catch (err) {
    console.error(`启动失败: ${err.message}`);
    process.exit(1);
  }

  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    worker.log(`收到 ${signal}，正在停止...`);
    await worker.stop();
    worker.log('已退出');
    process.exit(0);
  };

  process.on('SIGINT', () => { shutdown('Ctrl+C'); });
  process.on('SIGTERM', () => { shutdown('SIGTERM'); });

  // start() 已经把循环挂在后台，这里等待它自然结束
  await worker.loopPromise;
  if (!shuttingDown) {
    await worker.stop();
    process.exit(0);
  }
}

module.exports = { main, ensureConfigFile, createStateStore, DEFAULT_CONFIG_PATH };

if (require.main === module) {
  main();
}
