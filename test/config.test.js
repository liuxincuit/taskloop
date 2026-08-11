const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadConfig } = require('../src/config.js');

function makeFixture(overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'config-test-'));
  const templatePath = path.join(dir, 'templates', 'analyze.md');
  fs.mkdirSync(path.dirname(templatePath), { recursive: true });
  fs.writeFileSync(templatePath, '处理 {youtrack_id}', 'utf8');
  const config = {
    intervalSeconds: 60,
    agent: 'pi',
    pi: { sessionDir: './.pi-sessions' },
    rules: [
      {
        labels: ['readyed', 'clearly'],
        notLabels: ['done'],
        assignee: 'me',
        promptTemplate: 'templates/analyze.md',
      },
    ],
    ...overrides,
  };
  const configPath = path.join(dir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify(config), 'utf8');
  return { dir, configPath, templatePath };
}

test('解析合法配置：路径解析与缺省值', () => {
  const { dir, configPath } = makeFixture();
  const result = loadConfig(configPath);
  assert.strictEqual(result.intervalSeconds, 60);
  assert.strictEqual(result.agent, 'pi');
  assert.strictEqual(result.agentConfig.sessionDir, path.join(dir, '.pi-sessions'));
  assert.strictEqual(result.agentConfig.path, 'pi');
  assert.strictEqual(result.rules.length, 1);
  assert.deepStrictEqual(result.rules[0].labels, ['readyed', 'clearly']);
  assert.deepStrictEqual(result.rules[0].notLabels, ['done']);
  assert.strictEqual(result.rules[0].assignee, 'me');
  assert.strictEqual(result.rules[0].promptTemplate, path.join(dir, 'templates', 'analyze.md'));
});

test('缺省值：intervalSeconds 缺省 60，agent 缺省 pi，sessionDir 缺省 config 所在目录', () => {
  const { dir, configPath } = makeFixture();
  const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  delete raw.intervalSeconds;
  delete raw.agent;
  delete raw.pi;
  fs.writeFileSync(configPath, JSON.stringify(raw), 'utf8');
  const result = loadConfig(configPath);
  assert.strictEqual(result.intervalSeconds, 60);
  assert.strictEqual(result.agent, 'pi');
  assert.strictEqual(result.agentConfig.sessionDir, dir);
  assert.strictEqual(result.agentConfig.path, 'pi');
});

test('配置文件不是 JSON 对象时报错', () => {
  const { dir, configPath } = makeFixture();
  fs.writeFileSync(configPath, '[1,2]', 'utf8');
  assert.throws(() => loadConfig(configPath), /JSON 对象/);
});

test('intervalSeconds 非正整数时报错', () => {
  const { configPath } = makeFixture({ intervalSeconds: -1 });
  assert.throws(() => loadConfig(configPath), /intervalSeconds/);
});

test('rules 为空数组时报错', () => {
  const { configPath } = makeFixture({ rules: [] });
  assert.throws(() => loadConfig(configPath), /rules/);
});

test('labels 缺失时报错', () => {
  const { configPath } = makeFixture({
    rules: [{ notLabels: [], promptTemplate: 'templates/analyze.md' }],
  });
  assert.throws(() => loadConfig(configPath), /labels/);
});

test('notLabels 非数组时报错', () => {
  const { configPath } = makeFixture({
    rules: [{ labels: ['a'], notLabels: 'done', promptTemplate: 'templates/analyze.md' }],
  });
  assert.throws(() => loadConfig(configPath), /notLabels/);
});

test('assignee 非字符串时报错', () => {
  const { configPath } = makeFixture({
    rules: [{ labels: ['a'], assignee: 123, promptTemplate: 'templates/analyze.md' }],
  });
  assert.throws(() => loadConfig(configPath), /assignee/);
});

test('promptTemplate 文件不存在时报错', () => {
  const { configPath } = makeFixture({
    rules: [{ labels: ['a'], promptTemplate: 'templates/missing.md' }],
  });
  assert.throws(() => loadConfig(configPath), /文件不存在/);
});

test('notLabels 缺省为空数组', () => {
  const { configPath } = makeFixture({
    rules: [{ labels: ['a'], promptTemplate: 'templates/analyze.md' }],
  });
  const result = loadConfig(configPath);
  assert.deepStrictEqual(result.rules[0].notLabels, []);
  assert.strictEqual(result.rules[0].assignee, undefined);
});

test('source 缺省为 youtrack', () => {
  const { configPath } = makeFixture();
  const result = loadConfig(configPath);
  assert.strictEqual(result.rules[0].source, 'youtrack');
});

test('source 为合法值 wiki', () => {
  const { configPath } = makeFixture({
    rules: [
      { source: 'wiki', labels: ['ready'], notLabels: ['explored'], promptTemplate: 'templates/analyze.md' },
    ],
  });
  const result = loadConfig(configPath);
  assert.strictEqual(result.rules[0].source, 'wiki');
  assert.deepStrictEqual(result.rules[0].labels, ['ready']);
  assert.deepStrictEqual(result.rules[0].notLabels, ['explored']);
});

test('source 为非法值时报错', () => {
  const { configPath } = makeFixture({
    rules: [
      { source: 'jira', labels: ['a'], promptTemplate: 'templates/analyze.md' },
    ],
  });
  assert.throws(() => loadConfig(configPath), /source/);
});

test('agent 为非法值时报错并列出合法值', () => {
  const { configPath } = makeFixture({ agent: 'opencode' });
  assert.throws(() => loadConfig(configPath), /agent 必须是 "pi"/);
});

test('agent 为非字符串时报错', () => {
  const { configPath } = makeFixture({ agent: 123 });
  assert.throws(() => loadConfig(configPath), /agent/);
});

test('agent 配置块为数组时报错', () => {
  const { configPath } = makeFixture({ pi: [] });
  assert.throws(() => loadConfig(configPath), /配置块必须是对象/);
});

test('agent 配置块出现未声明 key 时报错并列出允许值', () => {
  const { configPath } = makeFixture({ pi: { sessionDir: './.pi-sessions', model: 'x' } });
  assert.throws(() => loadConfig(configPath), /不允许字段 "model"，允许: sessionDir, path/);
});

test('agent 配置块 sessionDir 非字符串时报错', () => {
  const { configPath } = makeFixture({ pi: { sessionDir: 123 } });
  assert.throws(() => loadConfig(configPath), /sessionDir 必须是字符串/);
});

test('agent 配置块 path 非字符串时报错', () => {
  const { configPath } = makeFixture({ pi: { path: 123 } });
  assert.throws(() => loadConfig(configPath), /path 必须是字符串/);
});

test('agent 配置块缺省时 agentConfig 用默认值', () => {
  const { dir, configPath } = makeFixture();
  const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  delete raw.agent;
  delete raw.pi;
  fs.writeFileSync(configPath, JSON.stringify(raw), 'utf8');
  const result = loadConfig(configPath);
  assert.strictEqual(result.agent, 'pi');
  assert.strictEqual(result.agentConfig.sessionDir, dir);
  assert.strictEqual(result.agentConfig.path, 'pi');
});

test('claude 配置块缺省时 agentConfig.path 为 claude', () => {
  const { dir, configPath } = makeFixture({ agent: 'claude' });
  const result = loadConfig(configPath);
  assert.strictEqual(result.agent, 'claude');
  assert.strictEqual(result.agentConfig.path, 'claude');
  assert.strictEqual(result.agentConfig.sessionDir, dir);
});

test('claude 配置块 path 自定义', () => {
  const { configPath } = makeFixture({ agent: 'claude', claude: { path: '/opt/claude/bin/claude' } });
  const result = loadConfig(configPath);
  assert.strictEqual(result.agentConfig.path, '/opt/claude/bin/claude');
});

test('claude 配置块出现未声明 key 时报错并列出允许值', () => {
  const { configPath } = makeFixture({ agent: 'claude', claude: { model: 'x' } });
  assert.throws(() => loadConfig(configPath), /不允许字段 "model"，允许: path/);
});
