const { buildPiArgs } = require('./piRunner.js');
const { buildClaudeArgs } = require('./claudeRunner.js');

// 新增 agent：创建 src/<name>.js 导出 build<Name>Args(prompt, { tmpFile, cwd, agentConfig }) → { cmd, args, stdin? }，
// 然后在此注册一行（buildArgs 实现 + pathKeys 路径类 key 声明——值由 config.js 相对 config 目录解析为绝对路径），
// 自动获得：config 的 agent 校验、[agent] 块校验、main 的分发、通用执行层（临时文件/SIGINT/退出码）。
// 适配器只拼固定结构性参数（如 -p @tmpfile），其余参数由 args.js 的 buildMappedArgs 从 agentConfig 按约定映射生成。
const agents = {
  pi: {
    buildArgs: buildPiArgs,
    pathKeys: ['sessionDir'],
  },
  claude: {
    buildArgs: buildClaudeArgs,
    pathKeys: [],
  },
};

const AGENT_KEYS = Object.keys(agents);

module.exports = { agents, AGENT_KEYS };
