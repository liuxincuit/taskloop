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
    sessionDir: './.pi-sessions',
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
  assert.strictEqual(result.sessionDir, path.join(dir, '.pi-sessions'));
  assert.strictEqual(result.rules.length, 1);
  assert.deepStrictEqual(result.rules[0].labels, ['readyed', 'clearly']);
  assert.deepStrictEqual(result.rules[0].notLabels, ['done']);
  assert.strictEqual(result.rules[0].assignee, 'me');
  assert.strictEqual(result.rules[0].promptTemplate, path.join(dir, 'templates', 'analyze.md'));
});

test('缺省值：intervalSeconds 缺省 60，sessionDir 缺省 config 所在目录', () => {
  const { dir, configPath } = makeFixture();
  const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  delete raw.intervalSeconds;
  delete raw.sessionDir;
  fs.writeFileSync(configPath, JSON.stringify(raw), 'utf8');
  const result = loadConfig(configPath);
  assert.strictEqual(result.intervalSeconds, 60);
  assert.strictEqual(result.sessionDir, dir);
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
