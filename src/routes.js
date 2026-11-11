const fs = require('node:fs');
const path = require('node:path');
const { readRawConfig, validateConfig, THINKING_LEVELS } = require('./config.js');
const { sources, SOURCE_KEYS } = require('./sources.js');

const MAX_BODY_BYTES = 1024 * 1024;
const UI_DIR = path.join(__dirname, 'ui');

// 静态资源白名单：不做通用目录遍历，避免路径穿越
const STATIC_FILES = {
  '/': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/index.html': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/style.css': { file: 'style.css', type: 'text/css; charset=utf-8' },
  '/app.js': { file: 'app.js', type: 'text/javascript; charset=utf-8' },
};

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function sendText(res, status, text, type = 'text/plain; charset=utf-8') {
  res.writeHead(status, {
    'Content-Type': type,
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store',
  });
  res.end(text);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text.trim()) return resolve(undefined);
      try {
        resolve(JSON.parse(text));
      } catch (err) {
        reject(new Error(`请求体不是合法 JSON: ${err.message}`));
      }
    });
    req.on('error', reject);
  });
}

/** 服务器推送事件：单向、浏览器自带重连，够用且零依赖 */
function createEventHub() {
  const clients = new Set();

  function write(res, event, payload) {
    try {
      res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
    } catch {
      clients.delete(res);
    }
  }

  return {
    add(res) {
      clients.add(res);
      res.on('close', () => clients.delete(res));
    },
    broadcast(event, payload) {
      for (const res of clients) write(res, event, payload);
    },
    get size() {
      return clients.size;
    },
    closeAll() {
      for (const res of clients) {
        try {
          res.end();
        } catch {
          // 连接可能已断开
        }
      }
      clients.clear();
    },
  };
}

/** 扫描配置目录下的模板文件，供表单下拉使用 */
function listTemplates(configDir) {
  const dir = path.join(configDir, 'templates');
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
      .map((entry) => path.posix.join('templates', entry.name))
      .sort();
  } catch {
    return [];
  }
}

/**
 * 表单选项集合。
 * 来源相关的一切都从注册表读取——新增来源后页面自动出现该选项，不需要改前端。
 */
function describeOptions(configDir) {
  const sourceMeta = {};
  for (const name of SOURCE_KEYS) {
    sourceMeta[name] = {
      tokenEnv: sources[name].tokenEnv,
      urlEnv: sources[name].urlEnv,
      defaultUrl: sources[name].defaultUrl,
    };
  }
  return {
    sources: SOURCE_KEYS,
    sourceMeta,
    thinkingLevels: THINKING_LEVELS,
    templates: listTemplates(configDir),
  };
}

/** 把 worker 事件映射到浏览器端的事件名 */
function eventChannel(type) {
  if (type === 'text' || type === 'tool' || type === 'turn') return 'agent';
  if (type === 'state' || type === 'round' || type === 'rule' || type === 'task' || type === 'log') return type;
  return null;
}

/**
 * 请求处理器。
 *
 * 依赖全部通过 ctx 注入，测试可以不带 HTTP 服务器直接验证路由行为。
 */
function createRequestHandler(ctx) {
  const { worker, configPath, events, recentEvents } = ctx;
  const configDir = path.dirname(configPath);

  return async function handle(req, res) {
    const url = new URL(req.url, 'http://127.0.0.1');
    const route = `${req.method} ${url.pathname}`;

    try {
      if (route === 'GET /api/state') {
        return sendJson(res, 200, worker.snapshot());
      }

      if (route === 'GET /api/events') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no',
        });
        res.write('retry: 2000\n\n');
        // 先补一份完整快照，再回放最近的事件：刷新或断线重连后不会丢掉当前轮的进度
        res.write(`event: state\ndata: ${JSON.stringify(worker.snapshot())}\n\n`);
        for (const event of recentEvents ?? []) {
          const channel = eventChannel(event.type);
          if (!channel) continue;
          res.write(`event: ${channel}\ndata: ${JSON.stringify(event)}\n\n`);
        }
        events.add(res);
        return undefined;
      }

      if (route === 'POST /api/start') {
        try {
          const snapshot = await worker.start();
          return sendJson(res, 200, { ok: true, state: snapshot });
        } catch (err) {
          return sendJson(res, 409, { ok: false, error: err.message });
        }
      }

      if (route === 'POST /api/stop') {
        try {
          const snapshot = await worker.stop();
          return sendJson(res, 200, { ok: true, state: snapshot });
        } catch (err) {
          return sendJson(res, 409, { ok: false, error: err.message });
        }
      }

      if (route === 'POST /api/wake') {
        try {
          worker.wake();
          return sendJson(res, 200, { ok: true, state: worker.snapshot() });
        } catch (err) {
          return sendJson(res, 409, { ok: false, error: err.message });
        }
      }

      if (route === 'GET /api/config') {
        try {
          const raw = readRawConfig(configPath);
          return sendJson(res, 200, { ok: true, config: raw, options: describeOptions(configDir) });
        } catch (err) {
          return sendJson(res, 500, { ok: false, error: err.message });
        }
      }

      if (route === 'PUT /api/config') {
        let body;
        try {
          body = await readJsonBody(req);
        } catch (err) {
          return sendJson(res, 400, { ok: false, error: err.message });
        }
        if (!body || typeof body !== 'object' || Array.isArray(body)) {
          return sendJson(res, 400, { ok: false, error: '配置必须是 JSON 对象' });
        }

        // 先校验再落盘：校验失败时不写文件，避免把坏配置留在磁盘上
        try {
          validateConfig(body, configDir, { createDirs: false });
        } catch (err) {
          return sendJson(res, 400, { ok: false, error: err.message });
        }

        try {
          fs.writeFileSync(configPath, `${JSON.stringify(body, null, 2)}\n`, 'utf8');
        } catch (err) {
          return sendJson(res, 500, { ok: false, error: `配置写入失败: ${err.message}` });
        }

        return sendJson(res, 200, {
          ok: true,
          restartRequired: worker.snapshot().state !== 'stopped',
        });
      }

      if (STATIC_FILES[url.pathname]) {
        const entry = STATIC_FILES[url.pathname];
        const filePath = path.join(UI_DIR, entry.file);
        let content;
        try {
          content = fs.readFileSync(filePath);
        } catch {
          return sendText(res, 404, '页面资源尚未生成');
        }
        res.writeHead(200, {
          'Content-Type': entry.type,
          'Content-Length': content.length,
          'Cache-Control': 'no-store',
        });
        return res.end(content);
      }

      return sendJson(res, 404, { ok: false, error: `未知路径 ${url.pathname}` });
    } catch (err) {
      return sendJson(res, 500, { ok: false, error: String(err?.message ?? err) });
    }
  };
}

module.exports = {
  createRequestHandler,
  createEventHub,
  describeOptions,
  listTemplates,
  eventChannel,
  STATIC_FILES,
  UI_DIR,
};
