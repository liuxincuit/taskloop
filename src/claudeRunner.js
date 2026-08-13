// claude 适配器：仅负责把 prompt 映射为 spawn 参数，不 spawn、不碰文件系统。
// prompt 走 stdin（stdin: true 声明，由 agentRunner 写入子进程 stdin）：
// claude -p 不带 prompt 参数时从 stdin 读；不用内联 argv，避免 win32 shell:true
// 下 prompt 含引号/反引号/$()/换行被 cmd.exe 拆坏，也绕开 Linux 单参数 128KB 上限。
// -p 为固定结构性参数；其余参数由 buildMappedArgs 从 agentConfig 按约定映射生成
// （如 permissionMode: "bypassPermissions" → --permission-mode bypassPermissions），args 数组原样追加。
const { buildMappedArgs } = require('./args.js');

function buildClaudeArgs(prompt, { agentConfig }) {
  const cmd = agentConfig?.path ?? 'claude';
  const args = ['-p', ...buildMappedArgs(agentConfig)];
  if (Array.isArray(agentConfig?.args)) args.push(...agentConfig.args);
  return { cmd, args, stdin: true };
}

module.exports = { buildClaudeArgs };
