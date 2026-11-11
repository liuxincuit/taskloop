const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const STATE_VERSION = 1;
const DEFAULT_HISTORY_LIMIT = 200;
const DEFAULT_LOG_LIMIT = 1000;

const DEFAULT_STATE_DIR = path.join(os.homedir(), '.taskloop');
const DEFAULT_STATE_FILE = path.join(DEFAULT_STATE_DIR, 'state.json');

/**
 * 运行状态持久化。
 *
 * 只保存任务索引与元数据——agent 的完整对话由 SDK 的会话文件承担（记录里存路径），
 * 否则状态文件体积会随对话长度增长。
 */
class StateStore {
  constructor(options = {}) {
    this.file = options.file ?? DEFAULT_STATE_FILE;
    this.historyLimit = options.historyLimit ?? DEFAULT_HISTORY_LIMIT;
    this.logLimit = options.logLimit ?? DEFAULT_LOG_LIMIT;
    this.onError = options.onError ?? (() => {});
    this.data = emptyState();
  }

  /** 读取已有状态；文件不存在、损坏或结构不符时以空状态启动，且不改写原文件 */
  load() {
    let text;
    try {
      text = fs.readFileSync(this.file, 'utf8');
    } catch {
      // 首次运行：文件不存在是正常情况
      return this.snapshot();
    }

    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      this.onError(`状态文件不是合法 JSON，本次以空历史启动（原文件保留）: ${err.message}`);
      return this.snapshot();
    }

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      this.onError('状态文件结构不符，本次以空历史启动（原文件保留）');
      return this.snapshot();
    }

    this.data = {
      version: STATE_VERSION,
      updatedAt: Number(parsed.updatedAt) || 0,
      meta: parsed.meta && typeof parsed.meta === 'object' ? parsed.meta : {},
      tasks: Array.isArray(parsed.tasks) ? parsed.tasks : [],
      logs: Array.isArray(parsed.logs) ? parsed.logs : [],
    };

    this.markInterrupted();
    this.trim();
    return this.snapshot();
  }

  /** 上一次进程被杀时留下的"执行中"记录改为"已中断"，不能显示成还在跑 */
  markInterrupted() {
    let changed = false;
    for (const task of this.data.tasks) {
      if (task.status === 'running') {
        task.status = 'interrupted';
        task.endedAt = task.endedAt ?? Date.now();
        changed = true;
      }
    }
    if (changed) this.save();
    return changed;
  }

  /** 记录一条任务；同 id 且仍为 running 的记录会被就地更新 */
  recordTask(record) {
    if (!record || !record.id) return;

    const entry = {
      id: record.id,
      source: record.source,
      status: record.status,
      error: record.error,
      sessionFile: record.sessionFile,
      durationMs: record.durationMs,
      startedAt: record.startedAt ?? Date.now(),
      endedAt: record.endedAt,
    };

    const index = this.data.tasks.findIndex((t) => t.id === entry.id && t.status === 'running');
    if (index >= 0) {
      this.data.tasks[index] = { ...this.data.tasks[index], ...entry };
    } else {
      this.data.tasks.push(entry);
    }

    this.trim();
    this.save();
    return entry;
  }

  recordLog(entry) {
    if (!entry || !entry.message) return;
    this.data.logs.push({
      at: entry.at ?? Date.now(),
      level: entry.level ?? 'info',
      message: String(entry.message),
    });
    this.trim();
    this.save();
  }

  setMeta(patch) {
    if (!patch || typeof patch !== 'object') return;
    this.data.meta = { ...this.data.meta, ...patch };
    this.save();
  }

  trim() {
    if (this.data.tasks.length > this.historyLimit) {
      this.data.tasks = this.data.tasks.slice(this.data.tasks.length - this.historyLimit);
    }
    if (this.data.logs.length > this.logLimit) {
      this.data.logs = this.data.logs.slice(this.data.logs.length - this.logLimit);
    }
  }

  snapshot() {
    return {
      version: this.data.version,
      updatedAt: this.data.updatedAt,
      meta: { ...this.data.meta },
      tasks: this.data.tasks.slice(),
      logs: this.data.logs.slice(),
    };
  }

  /** 写盘失败只上报，不中断调用方（循环不能因为磁盘问题停摆） */
  save() {
    this.data.updatedAt = Date.now();
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, `${JSON.stringify(this.data, null, 2)}\n`, 'utf8');
      return true;
    } catch (err) {
      this.onError(`状态写盘失败: ${err.message}`);
      return false;
    }
  }
}

function emptyState() {
  return { version: STATE_VERSION, updatedAt: 0, meta: {}, tasks: [], logs: [] };
}

module.exports = {
  StateStore,
  DEFAULT_STATE_DIR,
  DEFAULT_STATE_FILE,
  DEFAULT_HISTORY_LIMIT,
  DEFAULT_LOG_LIMIT,
  STATE_VERSION,
};
