const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  readRawConfig,
  validateConfig,
  loadConfig,
  createDefaultConfig,
  THINKING_LEVELS,
} = require('../src/config.js');

function makeFixture(raw, { templates = ['templates/analyze.md'] } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'taskloop-config-'));
  for (const tpl of templates) {
    const p = path.join(dir, tpl);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, 'prompt body');
  }
  const configPath = path.join(dir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify(raw, null, 2));
  return { dir, configPath };
}

const baseRule = { source: 'youtrack', labels: ['ready'], promptTemplate: 'templates/analyze.md' };
const baseConfig = (patch = {}) => ({ rules: [baseRule], ...patch });

test('readRawConfig：非法 JSON 报中文错误', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'taskloop-raw-'));
  const p = path.join(dir, 'config.json');
  fs.writeFileSync(p, '{ not json');
  assert.throws(() => readRawConfig(p), /不是合法 JSON/);
});

test('readRawConfig：顶层不是对象时报错', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'taskloop-raw-'));
  const p = path.join(dir, 'config.json');
  fs.writeFileSync(p, '[1,2,3]');
  assert.throws(() => readRawConfig(p), /必须是 JSON 对象/);
});

test('readRawConfig：文件不存在时报错并带上路径', () => {
  assert.throws(() => readRawConfig('/nonexistent/config.json'), /无法读取配置文件/);
});

test('readRawConfig：保留原始内容（相对路径不被解析成绝对路径）', () => {
  const { configPath } = makeFixture(baseConfig({
    workdir: './my-work',
    sessionDir: './my-sessions',
    rules: [{ ...baseRule, promptTemplate: './templates/analyze.md' }],
  }));

  const raw = readRawConfig(configPath);
  assert.strictEqual(raw.workdir, './my-work');
  assert.strictEqual(raw.sessionDir, './my-sessions');
  assert.strictEqual(raw.rules[0].promptTemplate, './templates/analyze.md');
});

test('readRawConfig：表单不认识的未知字段被保留', () => {
  const { configPath } = makeFixture(baseConfig({ customNote: '手写的备注' }));
  const raw = readRawConfig(configPath);
  assert.strictEqual(raw.customNote, '手写的备注');
});

test('validateConfig：拍平结构的完整配置被正确解析', () => {
  const { dir, configPath } = makeFixture(baseConfig({
    intervalSeconds: 30,
    model: 'p/m',
    thinking: 'high',
    workdir: './work',
    sessionDir: './sessions',
  }));

  const result = loadConfig(configPath, { createDirs: true });
  assert.strictEqual(result.intervalSeconds, 30);
  assert.strictEqual(result.model, 'p/m');
  assert.strictEqual(result.thinking, 'high');
  assert.strictEqual(result.workdir, path.join(dir, 'work'));
  assert.strictEqual(result.sessionDir, path.join(dir, 'sessions'));
  assert.ok(fs.existsSync(path.join(dir, 'work')), 'workdir 应被自动创建');
  assert.ok(fs.existsSync(path.join(dir, 'sessions')), 'sessionDir 应被自动创建');
});

test('validateConfig：缺省值 intervalSeconds=60，model/thinking 为空', () => {
  const { configPath } = makeFixture(baseConfig());
  const result = loadConfig(configPath, { createDirs: false });

  assert.strictEqual(result.intervalSeconds, 60);
  assert.strictEqual(result.model, undefined);
  assert.strictEqual(result.thinking, undefined);
  assert.strictEqual(result.rules[0].source, 'youtrack');
  assert.deepStrictEqual(result.rules[0].notLabels, []);
});

test('validateConfig：intervalSeconds 非正整数报错', () => {
  for (const bad of [0, -1, 1.5, '60']) {
    const { configPath } = makeFixture(baseConfig({ intervalSeconds: bad }));
    assert.throws(() => loadConfig(configPath, { createDirs: false }), /intervalSeconds 必须是正整数/);
  }
});

test('validateConfig：model 非字符串报错', () => {
  const { configPath } = makeFixture(baseConfig({ model: 123 }));
  assert.throws(() => loadConfig(configPath, { createDirs: false }), /model 必须是字符串/);
});

test('validateConfig：thinking 非法值报错并列出合法值', () => {
  const { configPath } = makeFixture(baseConfig({ thinking: 'turbo' }));
  assert.throws(
    () => loadConfig(configPath, { createDirs: false }),
    (err) => {
      assert.match(err.message, /thinking 必须是/);
      for (const level of THINKING_LEVELS) assert.ok(err.message.includes(`"${level}"`), `应列出 ${level}`);
      return true;
    }
  );
});

test('validateConfig：thinking 全部合法枚举都能通过', () => {
  for (const level of THINKING_LEVELS) {
    const { configPath } = makeFixture(baseConfig({ thinking: level }));
    assert.strictEqual(loadConfig(configPath, { createDirs: false }).thinking, level);
  }
});

test('validateConfig：遗留 agent 字段报错并给出迁移指引', () => {
  const { configPath } = makeFixture(baseConfig({ agent: 'pi' }));
  assert.throws(
    () => loadConfig(configPath, { createDirs: false }),
    (err) => {
      assert.match(err.message, /"agent" 字段已移除/);
      assert.match(err.message, /model/);
      assert.match(err.message, /thinking/);
      return true;
    }
  );
});

test('validateConfig：遗留 pi / claude 配置块报错', () => {
  for (const key of ['pi', 'claude']) {
    const { configPath } = makeFixture(baseConfig({ [key]: { thinking: 'max' } }));
    assert.throws(() => loadConfig(configPath, { createDirs: false }), new RegExp(`"${key}" 配置块已移除`));
  }
});

test('validateConfig：workdir 缺省为 ~/.taskloop/workdir', () => {
  const { configPath } = makeFixture(baseConfig());
  const result = loadConfig(configPath, { createDirs: false });
  assert.strictEqual(result.workdir, path.join(os.homedir(), '.taskloop', 'workdir'));
});

test('validateConfig：workdir 支持 ~ 展开', () => {
  const { configPath } = makeFixture(baseConfig({ workdir: '~/custom-work' }));
  const result = loadConfig(configPath, { createDirs: false });
  assert.strictEqual(result.workdir, path.join(os.homedir(), 'custom-work'));
});

test('validateConfig：workdir 相对 config 目录解析为绝对路径', () => {
  const { dir, configPath } = makeFixture(baseConfig({ workdir: 'sub/work' }));
  const result = loadConfig(configPath, { createDirs: false });
  assert.strictEqual(result.workdir, path.join(dir, 'sub', 'work'));
});

test('validateConfig：workdir 不存在时自动创建', () => {
  const { dir } = makeFixture(baseConfig());
  const target = path.join(dir, 'deep', 'nested', 'work');
  const { configPath } = makeFixture(baseConfig({ workdir: target }));
  const result = loadConfig(configPath, { createDirs: true });

  assert.strictEqual(result.workdir, target);
  assert.ok(fs.existsSync(target));
});

test('validateConfig：workdir 无法创建时返回中文错误并指出路径', () => {
  const { dir } = makeFixture(baseConfig());
  // 用一个普通文件占住路径，mkdir 会失败
  const blocker = path.join(dir, 'blocked');
  fs.writeFileSync(blocker, 'x');
  const { configPath } = makeFixture(baseConfig({ workdir: path.join(blocker, 'child') }));

  assert.throws(
    () => loadConfig(configPath, { createDirs: true }),
    (err) => {
      assert.match(err.message, /workdir 目录创建失败/);
      return true;
    }
  );
});

test('validateConfig：workdir 非字符串报错', () => {
  const { configPath } = makeFixture(baseConfig({ workdir: 42 }));
  assert.throws(() => loadConfig(configPath, { createDirs: false }), /workdir 必须是字符串/);
});

test('validateConfig：sessionDir 缺省为 ~/.taskloop/sessions', () => {
  const { configPath } = makeFixture(baseConfig());
  const result = loadConfig(configPath, { createDirs: false });
  assert.strictEqual(result.sessionDir, path.join(os.homedir(), '.taskloop', 'sessions'));
});

test('validateConfig：envFile 支持 ~ 与相对路径', () => {
  const { dir, configPath } = makeFixture(baseConfig({ envFile: './env.txt' }));
  assert.strictEqual(loadConfig(configPath, { createDirs: false }).envFile, path.join(dir, 'env.txt'));

  const tilde = makeFixture(baseConfig({ envFile: '~/e.txt' }));
  assert.strictEqual(loadConfig(tilde.configPath, { createDirs: false }).envFile, path.join(os.homedir(), 'e.txt'));
});

test('validateConfig：envFile 非字符串或空串报错', () => {
  for (const bad of ['', 1]) {
    const { configPath } = makeFixture(baseConfig({ envFile: bad }));
    assert.throws(() => loadConfig(configPath, { createDirs: false }), /envFile 必须是非空字符串/);
  }
});

test('validateConfig：rules 必须是非空数组', () => {
  for (const bad of [undefined, [], {}]) {
    const { configPath } = makeFixture({ rules: bad });
    assert.throws(() => loadConfig(configPath, { createDirs: false }), /rules 必须是非空数组/);
  }
});

test('validateConfig：source 非法时报错并列出注册表支持的来源', () => {
  const { configPath } = makeFixture(baseConfig({ rules: [{ ...baseRule, source: 'github' }] }));
  assert.throws(
    () => loadConfig(configPath, { createDirs: false }),
    (err) => {
      assert.match(err.message, /rules\[0\]\.source 必须是/);
      for (const s of ['youtrack', 'wiki', 'jira', 'scrum']) assert.ok(err.message.includes(`"${s}"`));
      return true;
    }
  );
});

test('validateConfig：rule 各字段的类型校验', () => {
  const cases = [
    [{ labels: [] }, /labels 必须是非空字符串数组/],
    [{ labels: [1] }, /labels 必须是非空字符串数组/],
    [{ notLabels: [null] }, /notLabels 必须是字符串数组/],
    [{ assignee: '' }, /assignee 必须是非空字符串/],
    [{ promptTemplate: '' }, /promptTemplate 必须是非空字符串/],
  ];
  for (const [patch, re] of cases) {
    const { configPath } = makeFixture(baseConfig({ rules: [{ ...baseRule, ...patch }] }));
    assert.throws(() => loadConfig(configPath, { createDirs: false }), re);
  }
});

test('validateConfig：promptTemplate 文件不存在时报错并给出绝对路径', () => {
  const { dir, configPath } = makeFixture(baseConfig({ rules: [{ ...baseRule, promptTemplate: 'templates/missing.md' }] }));
  assert.throws(
    () => loadConfig(configPath, { createDirs: false }),
    (err) => {
      assert.match(err.message, /promptTemplate 文件不存在/);
      assert.ok(err.message.includes(path.join(dir, 'templates', 'missing.md')));
      return true;
    }
  );
});

test('validateConfig：规则顺序与字段原样保留', () => {
  const rules = [
    { ...baseRule, source: 'jira', labels: ['a', 'b'], notLabels: ['c'], assignee: 'me' },
    { ...baseRule, source: 'wiki', labels: ['d'] },
  ];
  const { configPath } = makeFixture(baseConfig({ rules }));
  const result = loadConfig(configPath, { createDirs: false });

  assert.deepStrictEqual(result.rules.map((r) => r.source), ['jira', 'wiki']);
  assert.deepStrictEqual(result.rules[0].labels, ['a', 'b']);
  assert.deepStrictEqual(result.rules[0].notLabels, ['c']);
  assert.strictEqual(result.rules[0].assignee, 'me');
  assert.deepStrictEqual(result.rules[1].notLabels, []);
});

test('createDefaultConfig：生成的默认配置能被 validateConfig 通过', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'taskloop-default-'));
  fs.mkdirSync(path.join(dir, 'templates'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'templates', 'analyze.md'), 'body');

  const config = validateConfig(createDefaultConfig(), dir, { createDirs: false });
  assert.strictEqual(config.intervalSeconds, 60);
  assert.strictEqual(config.rules.length, 1);
  assert.ok(config.workdir.endsWith(path.join('.taskloop', 'workdir')));
});

test('validateConfig：config.example.json 中的示例配置能直接通过校验', () => {
  const repoRoot = path.join(__dirname, '..');
  const raw = readRawConfig(path.join(repoRoot, 'config.example.json'));
  const config = validateConfig(raw, repoRoot, { createDirs: false });

  assert.ok(Array.isArray(config.rules) && config.rules.length > 0);
  for (const rule of config.rules) {
    assert.ok(rule.promptTemplate.endsWith('.md'));
  }
});

test('validateConfig：README 中的配置示例符合各自预期（新结构通过、迁移示例被拒）', () => {
  const repoRoot = path.join(__dirname, '..');
  const readme = fs.readFileSync(path.join(repoRoot, 'README.md'), 'utf8');
  const blocks = [...readme.matchAll(/```json\n([\s\S]*?)```/g)].map((m) => m[1]);

  let accepted = 0;
  let rejected = 0;
  for (const block of blocks) {
    let raw;
    try {
      raw = JSON.parse(block);
    } catch {
      // 文档里可能有不带 rules 的片段式示例，跳过
      continue;
    }
    if (!raw.rules) continue;

    if (raw.agent !== undefined || raw.pi !== undefined || raw.claude !== undefined) {
      // 「从 0.4.x 迁移」一节里的旧结构对照示例：必须被拒绝，否则迁移指引与实现不一致
      assert.throws(
        () => validateConfig(raw, repoRoot, { createDirs: false }),
        /已移除/,
        'README 里的旧结构示例应当被校验拒绝'
      );
      rejected += 1;
      continue;
    }

    validateConfig(raw, repoRoot, { createDirs: false });
    accepted += 1;
  }

  assert.ok(accepted >= 1, 'README 中应至少有一个新结构的完整配置示例且能通过校验');
  assert.ok(rejected >= 1, 'README 中应至少有一个旧结构对照示例且能被拒绝');
});
