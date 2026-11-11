const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ensureConfigFile, DEFAULT_CONFIG_PATH } = require('../src/main.js');

test('DEFAULT_CONFIG_PATH：指向用户目录下的 .taskloop/config.json', () => {
  assert.strictEqual(DEFAULT_CONFIG_PATH, path.join(os.homedir(), '.taskloop', 'config.json'));
});

test('ensureConfigFile：配置不存在时生成默认配置与内置模板', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'taskloop-main-'));
  const configPath = path.join(dir, '.taskloop', 'config.json');

  assert.strictEqual(ensureConfigFile(configPath), true);
  assert.ok(fs.existsSync(configPath));
  assert.ok(fs.existsSync(path.join(dir, '.taskloop', 'templates', 'analyze.md')), '应复制内置模板');

  const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  assert.deepStrictEqual(Object.keys(raw).sort(), [
    'intervalSeconds', 'rules', 'sessionDir', 'thinking', 'workdir',
  ]);
  assert.strictEqual(raw.rules.length, 1);
  assert.strictEqual(raw.rules[0].source, 'youtrack');
  // 新版结构不应再出现 agent 字段
  assert.strictEqual(raw.agent, undefined);
});

test('ensureConfigFile：配置已存在时不覆盖并返回 false', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'taskloop-main-'));
  const configPath = path.join(dir, 'config.json');
  fs.writeFileSync(configPath, '{"custom":true}');

  assert.strictEqual(ensureConfigFile(configPath), false);
  assert.strictEqual(fs.readFileSync(configPath, 'utf8'), '{"custom":true}');
});

test('ensureConfigFile：生成的配置能被 validateConfig 通过', () => {
  const { validateConfig } = require('../src/config.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'taskloop-main-'));
  const configPath = path.join(dir, '.taskloop', 'config.json');
  ensureConfigFile(configPath);

  const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const config = validateConfig(raw, path.dirname(configPath), { createDirs: false });

  assert.strictEqual(config.intervalSeconds, 60);
  assert.strictEqual(config.rules.length, 1);
});
