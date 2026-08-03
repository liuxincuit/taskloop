const { test } = require('node:test');
const assert = require('node:assert');
const { filterTasks } = require('../src/filter.js');

test('AND 语义：缺少任一 label 不入选', () => {
  const tasks = [
    { id: '1', idReadable: 'CS-1', labels: ['readyed', 'clearly'] },
    { id: '2', idReadable: 'CS-2', labels: ['readyed'] },
  ];
  const result = filterTasks(tasks, ['readyed', 'clearly'], []);
  assert.deepStrictEqual(result.map((t) => t.idReadable), ['CS-1']);
});

test('notLabel：含任一排除标签即剔除', () => {
  const tasks = [
    { id: '1', idReadable: 'CS-1', labels: ['readyed', 'clearly'] },
    { id: '2', idReadable: 'CS-2', labels: ['readyed', 'clearly', 'done'] },
  ];
  const result = filterTasks(tasks, ['readyed', 'clearly'], ['done']);
  assert.deepStrictEqual(result.map((t) => t.idReadable), ['CS-1']);
});

test('空任务列表返回空数组', () => {
  assert.deepStrictEqual(filterTasks([], ['a'], []), []);
});

test('标签匹配大小写敏感', () => {
  const tasks = [{ id: '1', idReadable: 'CS-1', labels: ['Readyed'] }];
  assert.deepStrictEqual(filterTasks(tasks, ['readyed'], []), []);
});

test('labels 为空时不因标签排除任务', () => {
  const tasks = [{ id: '1', idReadable: 'CS-1', labels: [] }];
  assert.deepStrictEqual(filterTasks(tasks, [], ['done']), tasks);
});
