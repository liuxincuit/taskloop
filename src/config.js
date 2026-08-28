const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { agents, AGENT_KEYS } = require('./agents.js');
const { SOURCE_KEYS } = require('./sources.js');

// envFile 路径解析：~ 展开为 home 目录，其余相对 config 目录解析为绝对路径
function resolveEnvFile(configDir, envFile) {
  if (envFile === '~') return os.homedir();
  if (envFile.startsWith('~/') || envFile.startsWith('~\\')) {
    return path.join(os.homedir(), envFile.slice(2));
  }
  return path.resolve(configDir, envFile);
}

function loadConfig(configPath) {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (err) {
    throw new Error(`无法读取配置文件 ${configPath}: ${err.message}`);
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('配置文件必须是 JSON 对象');
  }
  const intervalSeconds = raw.intervalSeconds ?? 60;
  if (!Number.isInteger(intervalSeconds) || intervalSeconds <= 0) {
    throw new Error('intervalSeconds 必须是正整数');
  }
  if (!Array.isArray(raw.rules) || raw.rules.length === 0) {
    throw new Error('rules 必须是非空数组');
  }
  const configDir = path.dirname(path.resolve(configPath));
  const agent = raw.agent ?? 'pi';
  if (typeof agent !== 'string' || !AGENT_KEYS.includes(agent)) {
    throw new Error(`agent 必须是 ${AGENT_KEYS.map((k) => `"${k}"`).join(' 或 ')}`);
  }
  const envFile = raw.envFile;
  if (envFile !== undefined && (typeof envFile !== 'string' || envFile.length === 0)) {
    throw new Error('envFile 必须是非空字符串');
  }
  const agentBlock = raw[agent];
  if (agentBlock !== undefined &&
      (typeof agentBlock !== 'object' || agentBlock === null || Array.isArray(agentBlock))) {
    throw new Error(`${agent} 配置块必须是对象`);
  }
  const pathKeys = agents[agent].pathKeys;
  for (const [key, value] of Object.entries(agentBlock ?? {})) {
    if (key === 'path') {
      if (typeof value !== 'string') {
        throw new Error(`${agent} 配置块的 path 必须是字符串`);
      }
    } else if (key === 'args') {
      if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
        throw new Error(`${agent} 配置块字段 "args" 必须是字符串数组`);
      }
    } else if (pathKeys.includes(key)) {
      if (typeof value !== 'string') {
        throw new Error(`${agent} 配置块字段 "${key}" 必须是字符串`);
      }
    } else if (Array.isArray(value)) {
      throw new Error(`${agent} 配置块字段 "${key}" 不能是数组，请改用 args`);
    } else if (value !== null && typeof value === 'object') {
      throw new Error(`${agent} 配置块字段 "${key}" 必须是字符串、数字或布尔值`);
    }
  }
  const agentConfig = { path: agentBlock?.path ?? agent };
  for (const [key, value] of Object.entries(agentBlock ?? {})) {
    if (key === 'path') continue;
    agentConfig[key] = pathKeys.includes(key) ? path.resolve(configDir, value) : value;
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
    const templatePath = path.resolve(configDir, rule.promptTemplate);
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
    agent,
    agentConfig,
    envFile: envFile === undefined ? undefined : resolveEnvFile(configDir, envFile),
    rules,
  };
}

module.exports = { loadConfig };
