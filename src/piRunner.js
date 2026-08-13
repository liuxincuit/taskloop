// pi 适配器：仅负责把 prompt 映射为 spawn 参数，不 spawn、不碰文件系统。
// 临时文件由 agentRunner 写入并传入 tmpFile；win32 引号由 agentRunner 统一处理（args 不含引号）。
// -p @tmpfile 为固定结构性参数；其余参数由 buildMappedArgs 从 agentConfig 按约定映射生成，args 数组原样追加。
const { buildMappedArgs } = require('./args.js');

function buildPiArgs(prompt, { tmpFile, cwd, agentConfig }) {
  const cmd = agentConfig?.path ?? 'pi';
  const args = ['-p', '@' + tmpFile, ...buildMappedArgs(agentConfig)];
  if (Array.isArray(agentConfig?.args)) args.push(...agentConfig.args);
  return { cmd, args };
}

module.exports = { buildPiArgs };
