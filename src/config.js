const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { SOURCE_KEYS } = require('./sources.js');

// 与 pi SDK 的 ThinkingLevel 保持一致；这里硬编码是为了让 config 校验不依赖
// SDK 的 ESM 加载（校验需要同步完成，而 SDK 只能 await import）
const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

const DEFAULT_INTERVAL_SECONDS = 60;
// 切到 npm 包分发后，工作目录不能再用「包安装目录」，统一放到用户目录下
const DEFAULT_WORKDIR = path.join(os.homedir(), '.taskloop', 'workdir');
const DEFAULT_SESSION_DIR = path.join(os.homedir(), '.taskloop', 'sessions');

// 旧结构里的 agent 概念已整体移除，出现这些键时给出迁移指引而不是静默忽略
const LEGACY_AGENT_KEYS = ['agent', 'pi', 'claude'];

function expandTilde(value) {
  if (value === '~') return os.homedir();
  if (value.startsWith('~/') || value.startsWith('~\\')) {
    return path.join(os.homedir(), value.slice(2));
  }
  return value;
}

// 相对 config 所在目录解析为绝对路径
function resolveFromConfigDir(configDir, value) {
  return path.resolve(configDir, expandTilde(value));
}

function ensureDir(dir, label) {
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (err) {
    throw new Error(`${label} 目录创建失败 ${dir}: ${err.message}`);
  }
}

/**
 * 只读文件并解析 JSON，不做业务校验。
 * 表单编辑必须基于这个结果（而不是 validateConfig 的返回值），
 * 否则相对路径会被固化成绝对路径、未知字段会被丢弃。
 */
function readRawConfig(configPath) {
  let text;
  try {
    text = fs.readFileSync(configPath, 'utf8');
  } catch (err) {
    throw new Error(`无法读取配置文件 ${configPath}: ${err.message}`);
  }
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new Error(`配置文件不是合法 JSON (${configPath}): ${err.message}`);
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('配置文件必须是 JSON 对象');
  }
  return raw;
}

/**
 * 校验原始配置并解析路径。纯校验 + 路径解析，返回值供运行时使用。
 * 出现旧字段时直接报错（而不是忽略），避免用户以为配置生效了。
 */
function validateConfig(raw, configDir, options = {}) {
  const createDirs = options.createDirs !== false;

  if (raw.agent !== undefined) {
    throw new Error(
      '配置中的 "agent" 字段已移除：现在固定使用 pi SDK。请改为顶层 "model" 与 "thinking"，' +
      '并删除按 agent 命名的配置块'
    );
  }
  for (const key of LEGACY_AGENT_KEYS) {
    if (key !== 'agent' && raw[key] !== undefined) {
      throw new Error(
        `配置中的 "${key}" 配置块已移除：现在固定使用 pi SDK。` +
        '请把 model / thinking 移到配置顶层'
      );
    }
  }

  const intervalSeconds = raw.intervalSeconds ?? DEFAULT_INTERVAL_SECONDS;
  if (!Number.isInteger(intervalSeconds) || intervalSeconds <= 0) {
    throw new Error('intervalSeconds 必须是正整数');
  }

  let model;
  if (raw.model !== undefined && raw.model !== null && raw.model !== '') {
    if (typeof raw.model !== 'string') {
      throw new Error('model 必须是字符串（形如 provider/modelId）');
    }
    model = raw.model;
  }

  let thinking;
  if (raw.thinking !== undefined && raw.thinking !== null && raw.thinking !== '') {
    if (typeof raw.thinking !== 'string' || !THINKING_LEVELS.includes(raw.thinking)) {
      throw new Error(`thinking 必须是 ${THINKING_LEVELS.map((l) => `"${l}"`).join(' / ')}`);
    }
    thinking = raw.thinking;
  }

  let workdir;
  if (raw.workdir !== undefined && raw.workdir !== null && raw.workdir !== '') {
    if (typeof raw.workdir !== 'string') {
      throw new Error('workdir 必须是字符串');
    }
    workdir = resolveFromConfigDir(configDir, raw.workdir);
  } else {
    workdir = DEFAULT_WORKDIR;
  }
  if (createDirs) ensureDir(workdir, 'workdir');

  let sessionDir;
  if (raw.sessionDir !== undefined && raw.sessionDir !== null && raw.sessionDir !== '') {
    if (typeof raw.sessionDir !== 'string') {
      throw new Error('sessionDir 必须是字符串');
    }
    sessionDir = resolveFromConfigDir(configDir, raw.sessionDir);
  } else {
    sessionDir = DEFAULT_SESSION_DIR;
  }
  if (createDirs) ensureDir(sessionDir, 'sessionDir');

  const envFile = raw.envFile;
  if (envFile !== undefined && (typeof envFile !== 'string' || envFile.length === 0)) {
    throw new Error('envFile 必须是非空字符串');
  }

  if (!Array.isArray(raw.rules) || raw.rules.length === 0) {
    throw new Error('rules 必须是非空数组');
  }

  const rules = raw.rules.map((rule, i) => {
    if (typeof rule !== 'object' || rule === null || Array.isArray(rule)) {
      throw new Error(`rules[${i}] 必须是对象`);
    }
    if (rule.source !== undefined && !SOURCE_KEYS.includes(rule.source)) {
      throw new Error(`rules[${i}].source 必须是 ${SOURCE_KEYS.map((k) => `"${k}"`).join(' 或 ')}`);
    }
    if (!Array.isArray(rule.labels) || rule.labels.length === 0 ||
        rule.labels.some((l) => typeof l !== 'string' || l.length === 0)) {
      throw new Error(`rules[${i}].labels 必须是非空字符串数组`);
    }
    if (rule.notLabels !== undefined &&
        (!Array.isArray(rule.notLabels) ||
         rule.notLabels.some((l) => typeof l !== 'string' || l.length === 0))) {
      throw new Error(`rules[${i}].notLabels 必须是字符串数组`);
    }
    if (rule.assignee !== undefined &&
        (typeof rule.assignee !== 'string' || rule.assignee.length === 0)) {
      throw new Error(`rules[${i}].assignee 必须是非空字符串`);
    }
    if (typeof rule.promptTemplate !== 'string' || rule.promptTemplate.length === 0) {
      throw new Error(`rules[${i}].promptTemplate 必须是非空字符串`);
    }
    const templatePath = resolveFromConfigDir(configDir, rule.promptTemplate);
    if (!fs.existsSync(templatePath)) {
      throw new Error(`rules[${i}].promptTemplate 文件不存在: ${templatePath}`);
    }
    return {
      source: rule.source ?? 'youtrack',
      labels: rule.labels,
      notLabels: rule.notLabels ?? [],
      assignee: rule.assignee,
      promptTemplate: templatePath,
    };
  });

  return {
    intervalSeconds,
    model,
    thinking,
    workdir,
    sessionDir,
    envFile: envFile === undefined ? undefined : resolveFromConfigDir(configDir, envFile),
    rules,
  };
}

/**
 * 读取并校验配置文件。运行时入口用它；表单编辑走 readRawConfig + validateConfig 两段。
 */
function loadConfig(configPath, options) {
  const absolute = path.resolve(configPath);
  const raw = readRawConfig(absolute);
  return validateConfig(raw, path.dirname(absolute), options);
}

// 默认配置：首次启动且默认位置没有配置文件时生成
function createDefaultConfig() {
  return {
    intervalSeconds: DEFAULT_INTERVAL_SECONDS,
    thinking: 'medium',
    workdir: '~/.taskloop/workdir',
    sessionDir: '~/.taskloop/sessions',
    rules: [
      {
        source: 'youtrack',
        labels: ['ready'],
        notLabels: ['done'],
        assignee: 'me',
        promptTemplate: 'templates/analyze.md',
      },
    ],
  };
}

module.exports = {
  readRawConfig,
  validateConfig,
  loadConfig,
  createDefaultConfig,
  expandTilde,
  resolveFromConfigDir,
  THINKING_LEVELS,
  DEFAULT_INTERVAL_SECONDS,
  DEFAULT_WORKDIR,
  DEFAULT_SESSION_DIR,
};
