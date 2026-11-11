#!/usr/bin/env node
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { Worker } = require('./worker.js');
const { StateStore } = require('./state.js');
const { createDefaultConfig } = require('./config.js');
const { createRequestHandler, createEventHub, eventChannel } = require('./routes.js');

const DEFAULT_CONFIG_PATH = path.join(os.homedir(), '.taskloop', 'config.json');
const DEFAULT_PORT = 4789;
// 这个页面等价于「启动任意 agent 命令」的入口，只能监听回环地址
const BIND_HOST = '127.0.0.1';

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

/** 组装依赖，便于测试直接创建不监听的服务 */
function createApp(options = {}) {
  const configPath = path.resolve(options.configPath ?? DEFAULT_CONFIG_PATH);
  const stateDir = path.dirname(configPath);

  const stateStore = options.stateStore ?? new StateStore({
    file: path.join(stateDir, 'state.json'),
    onError: (message) => process.stderr.write(`[state] ${message}\n`),
  });
  stateStore.load();

  const events = createEventHub();
  const worker = options.worker ?? new Worker({ configPath, stateStore });
  // 外部传入的 worker 也要落盘，否则页面会显示空历史
  worker.stateStore = stateStore;

  // 最近事件缓冲：页面刷新或断线重连时回放，避免只看到空白的执行流
  const recentEvents = [];
  const RECENT_LIMIT = 500;

  worker.on('event', (event) => {
    const channel = eventChannel(event.type);
    if (!channel) return;
    recentEvents.push(event);
    if (recentEvents.length > RECENT_LIMIT) recentEvents.shift();
    events.broadcast(channel, event);
  });

  const handler = createRequestHandler({ worker, configPath, events, recentEvents });
  const server = http.createServer(handler);

  return { server, worker, events, stateStore, configPath, recentEvents };
}

function listen(server, port, host = BIND_HOST) {
  return new Promise((resolve, reject) => {
    const onError = (err) => {
      server.removeListener('listening', onListening);
      if (err.code === 'EADDRINUSE') {
        reject(new Error(`端口 ${port} 已被占用，请先停掉占用该端口的进程或更换端口`));
        return;
      }
      reject(new Error(`服务启动失败: ${err.message}`));
    };
    const onListening = () => {
      server.removeListener('error', onError);
      resolve(server.address());
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
}

async function main(argv = process.argv) {
  const configPath = path.resolve(argv[2] || DEFAULT_CONFIG_PATH);
  const portArg = Number(process.env.TASKLOOP_PORT) || DEFAULT_PORT;

  let created = false;
  try {
    created = ensureConfigFile(configPath);
  } catch (err) {
    console.error(`配置初始化失败: ${err.message}`);
    process.exit(1);
  }
  if (created) console.log(`已生成默认配置: ${configPath}`);

  const app = createApp({ configPath });

  let address;
  try {
    address = await listen(app.server, portArg);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }

  const url = `http://${BIND_HOST}:${address.port}/`;
  console.log(`taskloop 页面已启动: ${url}`);
  console.log('循环处于停止状态，在页面上点击「启动」开始轮询。');

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    app.events.closeAll();
    await app.worker.stop();
    app.server.close();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

module.exports = { main, createApp, listen, ensureConfigFile, DEFAULT_CONFIG_PATH, DEFAULT_PORT, BIND_HOST };

if (require.main === module) {
  main();
}
