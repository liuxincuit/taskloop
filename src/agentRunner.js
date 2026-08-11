const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { agents } = require('./agents.js');

async function runAgent(prompt, { agent, cwd, agentConfig, spawnFn = spawn, onChild, isWin = process.platform === 'win32' }) {
  const tmpFile = path.join(
    os.tmpdir(),
    `agent-task-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.md`
  );
  try {
    fs.writeFileSync(tmpFile, prompt, 'utf8');
    const { cmd, args, stdin } = agents[agent].buildArgs(prompt, { tmpFile, cwd, agentConfig });
    // win32 shell:true 下含空格的路径会被拆分，统一对非 flag 参数（不以 - 开头）包引号；
    // 适配器返回的 args 一律不带引号
    const finalArgs = isWin ? args.map((a) => (a.startsWith('-') ? a : `"${a}"`)) : args;
    const exitCode = await new Promise((resolve, reject) => {
      const child = spawnFn(cmd, finalArgs, {
        cwd,
        stdio: stdin ? ['pipe', 'inherit', 'inherit'] : 'inherit',
        ...(isWin ? { shell: true } : {}),
      });
      child.on('error', reject);
      child.on('exit', (code) => resolve(code ?? 1));
      try {
        onChild?.(child);
      } catch (err) {
        // 先 reject 再 kill：kill 可能同步触发 exit 事件，先 kill 会让 exit 的 resolve 吞掉 onChild 的错误
        reject(err);
        child.kill();
      }
      if (stdin) {
        // EPIPE：子进程提前退出时忽略，避免 unhandled 'error' 崩溃
        child.stdin.on('error', () => {});
        child.stdin.write(prompt);
        child.stdin.end();
      }
    });
    return { exitCode };
  } finally {
    fs.rmSync(tmpFile, { force: true });
  }
}

module.exports = { runAgent };
