const path = require('node:path');
const { EventEmitter } = require('node:events');
const { filterTasks } = require('./filter.js');
const { renderTemplateFile } = require('./template.js');
const { createHttpClient } = require('./youTrack.js');
const { loadEnv } = require('./env.js');
const { sources, SOURCE_KEYS, buildPlaceholders } = require('./sources.js');
const { runTask } = require('./sessionRunner.js');
const { loadConfig } = require('./config.js');

const STATE = {
  STOPPED: 'stopped',
  RUNNING: 'running',
  STOPPING: 'stopping',
};

function timestamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

// 只对配置里实际用到的来源要求 token；URL 缺省值来自注册表
function resolveEnv(config, env = process.env) {
  const usedSources = new Set(config.rules.map((rule) => rule.source ?? 'youtrack'));
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

/**
 * 轮询循环。生命周期与宿主进程解耦：同一个实例可以被反复 start / stop。
 *
 * 对任务来源保持无感知：来源相关的全部信息都从 sources 注册表读取，
 * 新增来源只需改注册表，这里不需要改动。
 */
class Worker extends EventEmitter {
  constructor(options = {}) {
    super();
    this.configPath = options.configPath;
    this.cwd = options.cwd ?? process.cwd();
    // 测试时传 null 静默 stdout
    this.output = options.output === undefined ? process.stdout : options.output;
    this.deps = {
      sources: options.sources ?? sources,
      createHttpClient: options.createHttpClient ?? createHttpClient,
      loadConfig: options.loadConfig ?? loadConfig,
      loadEnv: options.loadEnv ?? loadEnv,
      renderTemplate: options.renderTemplate ?? renderTemplateFile,
      runTask: options.runTask ?? runTask,
      filterTasks: options.filterTasks ?? filterTasks,
      resolveEnv: options.resolveEnv ?? resolveEnv,
    };

    this.state = STATE.STOPPED;
    this.round = 0;
    this.nextWakeAt = null;
    this.currentTask = null;
    this.ruleStatus = [];
    this.lastRun = null;
    this.startedAt = null;
    // 传入后由 worker 负责写入（读取与目录创建由入口完成）
    this.stateStore = options.stateStore ?? null;

    this.abortController = null;
    this.loopPromise = null;
    this.wakeResolve = null;
    this.httpClients = null;
    this.urls = null;
    this.tokens = null;
    this.config = null;
  }

  log(message) {
    const line = `[${timestamp()}] ${message}`;
    // CLI 模式靠 stdout；页面模式靠事件
    this.output?.write?.(`${line}\n`);
    const at = Date.now();
    this.stateStore?.recordLog({ at, level: 'info', message });
    this.emit('event', { type: 'log', level: 'info', message, at });
  }

  emitEvent(event) {
    this.emit('event', event);
  }

  snapshot() {
    return {
      state: this.state,
      round: this.round,
      nextWakeAt: this.nextWakeAt,
      intervalSeconds: this.config?.intervalSeconds ?? null,
      currentTask: this.currentTask,
      rules: this.ruleStatus,
      lastRun: this.lastRun,
      startedAt: this.startedAt,
      history: this.stateStore?.snapshot().tasks ?? [],
    };
  }

  /**
   * 启动循环：加载配置与环境变量、建立按来源的 HTTP 客户端，然后进入循环。
   * 配置或 token 有误会在这里抛出，调用方负责把中文错误显示给用户。
   */
  async start() {
    if (this.state === STATE.RUNNING || this.state === STATE.STOPPING) {
      throw new Error('循环已在运行');
    }

    const config = this.deps.loadConfig(this.configPath);
    const env = this.deps.resolveEnv(config, {
      ...this.deps.loadEnv(config.envFile),
      ...process.env,
    });

    this.config = config;
    this.urls = env.urls;
    this.tokens = env.tokens;
    this.httpClients = Object.fromEntries(
      SOURCE_KEYS.map((name) => [name, this.deps.createHttpClient(sources[name].tokenEnv)])
    );

    this.state = STATE.RUNNING;
    this.round = 0;
    this.startedAt = Date.now();
    this.ruleStatus = config.rules.map((rule) => ({
      source: rule.source,
      labels: rule.labels,
      notLabels: rule.notLabels,
      candidates: 0,
      error: null,
    }));

    this.emitEvent({ type: 'state', ...this.snapshot() });
    this.loopPromise = this.runLoop();
    return this.snapshot();
  }

  /**
   * 停止循环：中止当前任务，等循环自然退出后置为 stopped。
   * 中止是协作式的——正在跑的任务可能停在某个工具调用之后，所以对外先报 stopping。
   */
  async stop() {
    if (this.state === STATE.STOPPED) return this.snapshot();

    this.state = STATE.STOPPING;
    this.emitEvent({ type: 'state', ...this.snapshot() });
    this.abortController?.abort();
    this.releaseWait();

    if (this.loopPromise) {
      try {
        await this.loopPromise;
      } catch {
        // 循环自身的异常已在内部记录，这里只负责等待收尾
      }
    }

    this.state = STATE.STOPPED;
    this.nextWakeAt = null;
    this.currentTask = null;
    this.abortController = null;
    this.emitEvent({ type: 'state', ...this.snapshot() });
    return this.snapshot();
  }

  /** 立即结束等待、开始下一轮 */
  wake() {
    if (this.state !== STATE.RUNNING) {
      throw new Error('循环未运行');
    }
    this.releaseWait();
  }

  releaseWait() {
    const resolve = this.wakeResolve;
    this.wakeResolve = null;
    if (resolve) resolve();
  }

  async runLoop() {
    while (this.state === STATE.RUNNING) {
      this.round += 1;
      const startedAt = Date.now();
      const record = { round: this.round, startedAt, tasks: [] };

      try {
        await this.runCycle(record);
      } catch (err) {
        this.log(`本轮异常: ${err.message}`);
      }

      this.lastRun = { ...record, endedAt: Date.now() };
      this.stateStore?.setMeta({ round: this.round, lastRun: this.lastRun, state: this.state });
      this.emitEvent({ type: 'round', phase: 'end', ...this.lastRun });

      if (this.state !== STATE.RUNNING) break;
      await this.wait(this.config.intervalSeconds);
    }
  }

  /** 等待下一次唤醒；stop() 或 wake() 都会提前结束等待 */
  wait(seconds) {
    return new Promise((resolve) => {
      const finish = () => {
        clearTimeout(timer);
        if (this.wakeResolve === finish) this.wakeResolve = null;
        resolve();
      };
      const timer = setTimeout(finish, seconds * 1000);
      timer.unref?.();
      this.wakeResolve = finish;
      this.nextWakeAt = Date.now() + seconds * 1000;
      this.emitEvent({ type: 'state', ...this.snapshot() });
    });
  }

  async runCycle(record) {
    this.emitEvent({ type: 'round', phase: 'start', round: this.round, startedAt: record.startedAt });
    const processed = new Set();

    for (let i = 0; i < this.config.rules.length; i += 1) {
      if (this.state !== STATE.RUNNING) return;

      const rule = this.config.rules[i];
      const status = this.ruleStatus[i];
      const sourceName = rule.source ?? 'youtrack';
      const source = this.deps.sources[sourceName];
      const labelDesc = rule.labels.join(',');

      let tasks;
      try {
        tasks = await source.fetchTasks(rule, {
          httpClient: this.httpClients[sourceName],
          url: this.urls[sourceName],
          token: this.tokens[sourceName],
        });
      } catch (err) {
        this.log(`[${labelDesc}] 抓取失败: ${err.message}`);
        status.error = err.message;
        status.candidates = 0;
        this.emitEvent({ type: 'rule', phase: 'fail', index: i, source: sourceName, error: err.message });
        continue;
      }

      const candidates = this.deps.filterTasks(tasks, rule.labels, rule.notLabels);
      status.error = null;
      status.candidates = candidates.length;

      if (candidates.length === 0) {
        this.log(`[${labelDesc}] 无候选任务`);
        this.emitEvent({ type: 'rule', phase: 'empty', index: i, source: sourceName, candidates: 0 });
        continue;
      }

      this.log(`[${labelDesc}] 抓取到 ${candidates.length} 个候选任务`);
      this.emitEvent({ type: 'rule', phase: 'fetch', index: i, source: sourceName, candidates: candidates.length });

      for (const task of candidates) {
        if (this.state !== STATE.RUNNING) return;
        if (processed.has(task.idReadable)) continue;
        processed.add(task.idReadable);

        const outcome = await this.runOneTask(task, rule, sourceName, i);
        record.tasks.push(outcome);
      }
    }
  }

  async runOneTask(task, rule, sourceName, ruleIndex) {
    const startedAt = Date.now();

    let prompt;
    try {
      prompt = this.deps.renderTemplate(rule.promptTemplate, buildPlaceholders(sourceName, task, rule));
    } catch (err) {
      this.log(`[${task.idReadable}] 模板渲染失败: ${err.message}`);
      this.stateStore?.recordTask({ id: task.idReadable, source: sourceName, status: 'failed', error: err.message, startedAt });
      this.emitEvent({ type: 'task', phase: 'end', taskId: task.idReadable, status: 'failed', error: err.message, durationMs: 0 });
      return { id: task.idReadable, source: sourceName, status: 'failed', error: err.message, durationMs: 0 };
    }

    this.log(`[${task.idReadable}] 开始执行（模板: ${path.basename(rule.promptTemplate)}）`);
    this.currentTask = { id: task.idReadable, source: sourceName, ruleIndex, startedAt };
    this.abortController = new AbortController();
    // 先落一条 running 记录：进程若在此期间被杀，重启后可以标为已中断
    this.stateStore?.recordTask({ id: task.idReadable, source: sourceName, status: 'running', startedAt });
    this.emitEvent({ type: 'task', phase: 'start', taskId: task.idReadable, source: sourceName, ruleIndex, startedAt });

    let result;
    try {
      result = await this.deps.runTask(prompt, {
        cwd: this.config.workdir,
        model: this.config.model,
        thinking: this.config.thinking,
        sessionDir: this.config.sessionDir,
        signal: this.abortController.signal,
        onEvent: (event) => {
          this.emitEvent({ ...event, taskId: task.idReadable });
        },
      });
    } catch (err) {
      result = { status: 'failed', text: '', error: err.message };
    }

    const durationMs = Date.now() - startedAt;
    this.currentTask = null;
    this.abortController = null;

    const statusText = result.status === 'success' ? '完成' : result.status === 'aborted' ? '已中止' : '失败';
    this.log(`[${task.idReadable}] ${statusText}（${Math.round(durationMs / 1000)} 秒）`);
    if (result.error) this.log(`[${task.idReadable}] 原因: ${result.error}`);

    const outcome = {
      id: task.idReadable,
      source: sourceName,
      status: result.status,
      error: result.error,
      sessionFile: result.sessionFile,
      startedAt,
      endedAt: Date.now(),
      durationMs,
    };

    this.stateStore?.recordTask(outcome);
    this.emitEvent({ type: 'task', phase: 'end', taskId: task.idReadable, ...outcome });
    return outcome;
  }
}

module.exports = { Worker, STATE, resolveEnv, timestamp };
