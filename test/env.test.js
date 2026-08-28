const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parseEnvFile, loadEnv } = require('../src/env.js');

test('parseEnvFile：解析 KEY=VALUE，忽略注释/空行/无等号行', () => {
  const out = parseEnvFile([
    '# comment',
    '',
    'A=1',
    'B = two',
    'noeq',
    '=leading',
    'C=',
  ].join('\n'));
  assert.deepStrictEqual(out, { A: '1', B: 'two', C: '' });
});

test('parseEnvFile：剥离首尾引号', () => {
  const out = parseEnvFile('A="x y"\nB=\'z\'');
  assert.deepStrictEqual(out, { A: 'x y', B: 'z' });
});

test('parseEnvFile：CRLF 行尾与重复 key 后者覆盖', () => {
  const out = parseEnvFile('A=1\r\nA=2\r\n');
  assert.deepStrictEqual(out, { A: '2' });
});

test('parseEnvFile：空内容返回 {}', () => {
  assert.deepStrictEqual(parseEnvFile(''), {});
});

test('loadEnv：未配置（undefined/null）返回 {}', () => {
  assert.deepStrictEqual(loadEnv(undefined), {});
  assert.deepStrictEqual(loadEnv(null), {});
});

test('loadEnv：读取文件并解析', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'env-test-'));
  const file = path.join(dir, '.env');
  fs.writeFileSync(file, 'TOKEN=abc\n# comment\n', 'utf8');
  assert.deepStrictEqual(loadEnv(file), { TOKEN: 'abc' });
});

test('loadEnv：文件不存在报中文错误', () => {
  const missing = path.join(os.tmpdir(), 'no-such-env-file-xyz');
  assert.throws(() => loadEnv(missing), /无法读取 env 文件/);
});
