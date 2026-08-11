const { buildPiArgs } = require('./piRunner.js');
const { buildClaudeArgs } = require('./claudeRunner.js');

// 新增 agent：创建 src/<name>.js 导出 build<Name>Args(prompt, { tmpFile, cwd, agentConfig }) → { cmd, args, stdin? }，
// 然后在此注册一行（buildArgs 实现 + optionKeys 专属配置项声明），
// 自动获得：config 的 agent 校验、[agent] 块 key 校验、main 的分发、通用执行层（临时文件/SIGINT/退出码）
const agents = {
  pi: {
    buildArgs: buildPiArgs,
    optionKeys: ['sessionDir', 'path'],
  },
  claude: {
    buildArgs: buildClaudeArgs,
    optionKeys: ['path'],
  },
};

const AGENT_KEYS = Object.keys(agents);

module.exports = { agents, AGENT_KEYS };
