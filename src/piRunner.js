const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

async function runPi(prompt, { cwd, piPath = 'pi', sessionDir, spawnFn = spawn, onChild }) {
  const tmpFile = path.join(
    os.tmpdir(),
    `pi-task-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.md`
  );
  try {
    fs.writeFileSync(tmpFile, prompt, 'utf8');
    const isWin = process.platform === 'win32';
    const args = isWin
      ? ['-p', `"@${tmpFile}"`, '--session-dir', `"${sessionDir}"`]
      : ['-p', `@${tmpFile}`, '--session-dir', sessionDir];
    const exitCode = await new Promise((resolve, reject) => {
      const child = spawnFn(piPath, args, {
        cwd,
        stdio: 'inherit',
        ...(isWin ? { shell: true } : {}),
      });
      try {
        onChild?.(child);
      } catch (err) {
        child.kill();
        reject(err);
        return;
      }
      child.on('error', reject);
      child.on('exit', (code) => resolve(code ?? 1));
    });
    return { exitCode };
  } finally {
    fs.rmSync(tmpFile, { force: true });
  }
}

module.exports = { runPi };
