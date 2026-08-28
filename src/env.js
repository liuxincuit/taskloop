const fs = require('node:fs');

// 解析 KEY=VALUE 格式，支持 # 注释、空行、引号；空内容返回 {}
function parseEnvFile(content) {
  const out = {};
  for (const line of content.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq <= 0) continue;
    const key = t.slice(0, eq).trim();
    let value = t.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

// 读取 env 文件并解析；未配置（file 为空）时返回 {}；文件不存在或读取失败报中文错误
function loadEnv(file) {
  if (!file) return {};
  let content;
  try {
    content = fs.readFileSync(file, 'utf8');
  } catch (err) {
    throw new Error(`无法读取 env 文件 ${file}: ${err.message}`);
  }
  return parseEnvFile(content);
}

module.exports = { parseEnvFile, loadEnv };
