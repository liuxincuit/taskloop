// 约定映射：agentConfig 中除保留字段（path 命令名、args 原样数组）外的字段 → CLI 参数。
// pathKeys 声明的路径值已由 config.js 相对 config 目录解析为绝对路径，此处与其他字段同等对待。
function toKebabCase(key) {
  return key.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase());
}

function buildMappedArgs(agentBlock) {
  const mapped = [];
  for (const [key, value] of Object.entries(agentBlock ?? {})) {
    if (key === 'path' || key === 'args') continue;
    if (Array.isArray(value)) {
      throw new Error(`配置块字段 "${key}" 不能是数组，请改用 args`);
    }
    if (value !== null && typeof value === 'object') {
      throw new Error(`配置块字段 "${key}" 必须是字符串、数字或布尔值`);
    }
    if (value === false || value === null || value === undefined) continue;
    const flag = '--' + toKebabCase(key);
    if (value === true) mapped.push(flag);
    else mapped.push(flag, String(value));
  }
  return mapped;
}

module.exports = { toKebabCase, buildMappedArgs };
