const { test } = require('node:test');
const assert = require('node:assert');
const { toKebabCase, buildMappedArgs } = require('../src/args.js');

test('toKebabCase：camelCase 转 kebab-case', () => {
  assert.strictEqual(toKebabCase('sessionDir'), 'session-dir');
  assert.strictEqual(toKebabCase('permissionMode'), 'permission-mode');
  assert.strictEqual(toKebabCase('model'), 'model');
});

test('buildMappedArgs：字符串与数字生成 --key value', () => {
  assert.deepStrictEqual(
    buildMappedArgs({ model: 'deepseek-v4-flash', maxTurns: 5 }),
    ['--model', 'deepseek-v4-flash', '--max-turns', '5']
  );
});

test('buildMappedArgs：true 生成纯 flag，false 与 null 跳过', () => {
  assert.deepStrictEqual(
    buildMappedArgs({ verbose: true, quiet: false, nothing: null }),
    ['--verbose']
  );
});

test('buildMappedArgs：按对象书写顺序展开', () => {
  assert.deepStrictEqual(
    buildMappedArgs({ thinking: 'max', model: 'x', verbose: true }),
    ['--thinking', 'max', '--model', 'x', '--verbose']
  );
});

test('buildMappedArgs：跳过 path 与 args 保留字段', () => {
  assert.deepStrictEqual(
    buildMappedArgs({ path: 'pi', args: ['--x'], sessionDir: '/s' }),
    ['--session-dir', '/s']
  );
});

test('buildMappedArgs：数组值报错提示改用 args', () => {
  assert.throws(() => buildMappedArgs({ tags: ['a', 'b'] }), /不能是数组，请改用 args/);
});

test('buildMappedArgs：对象值报错', () => {
  assert.throws(() => buildMappedArgs({ nested: { a: 1 } }), /必须是字符串、数字或布尔值/);
});

test('buildMappedArgs：空配置返回空数组', () => {
  assert.deepStrictEqual(buildMappedArgs({}), []);
});

test('buildMappedArgs：null/undefined 输入返回空数组', () => {
  assert.deepStrictEqual(buildMappedArgs(null), []);
  assert.deepStrictEqual(buildMappedArgs(undefined), []);
});

test('buildMappedArgs：值为 undefined 的字段跳过，0 正常生成', () => {
  assert.deepStrictEqual(buildMappedArgs({ a: undefined, b: 0 }), ['--b', '0']);
});
