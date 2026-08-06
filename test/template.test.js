const { test } = require('node:test');
const assert = require('node:assert');
const { renderTemplate } = require('../src/template.js');

test('替换 {youtrack_id} 为 idReadable', () => {
  assert.strictEqual(
    renderTemplate('请处理任务 {youtrack_id}', { youtrackId: 'CS-1234' }),
    '请处理任务 CS-1234'
  );
});

test('多处占位符全部替换', () => {
  assert.strictEqual(
    renderTemplate('{youtrack_id} 和 {youtrack_id}', { youtrackId: 'CS-1' }),
    'CS-1 和 CS-1'
  );
});

test('无占位符时原样返回', () => {
  const content = '没有占位符的文本';
  assert.strictEqual(renderTemplate(content, { youtrackId: 'CS-1' }), content);
});

test('入参内容不被修改', () => {
  const content = '任务 {youtrack_id}';
  renderTemplate(content, { youtrackId: 'CS-1' });
  assert.strictEqual(content, '任务 {youtrack_id}');
});

test('替换 {wiki_url} 为页面 URL', () => {
  assert.strictEqual(
    renderTemplate('读取页面 {wiki_url}', { wikiUrl: 'https://wiki.ispeco.com/pages/viewpage.action?pageId=111' }),
    '读取页面 https://wiki.ispeco.com/pages/viewpage.action?pageId=111'
  );
});

test('两种占位符同时替换', () => {
  assert.strictEqual(
    renderTemplate('任务 {youtrack_id} 页面 {wiki_url}', { youtrackId: 'CS-1', wikiUrl: 'http://w' }),
    '任务 CS-1 页面 http://w'
  );
});

test('wikiUrl 未提供时不替换 {wiki_url}', () => {
  assert.strictEqual(renderTemplate('{wiki_url}', { youtrackId: 'CS-1' }), '{wiki_url}');
});

test('youtrackId 未提供时不替换 {youtrack_id}', () => {
  assert.strictEqual(renderTemplate('{youtrack_id}', { wikiUrl: 'http://w' }), '{youtrack_id}');
});

test('替换 {labels} 为逗号连接后的字符串', () => {
  assert.strictEqual(
    renderTemplate('任务须满足标签 {labels}', { labels: 'ready, explorer' }),
    '任务须满足标签 ready, explorer'
  );
});

test('替换 {not_labels} 为逗号连接后的字符串', () => {
  assert.strictEqual(
    renderTemplate('完成后打上 {not_labels} 标签', { notLabels: 'explored' }),
    '完成后打上 explored 标签'
  );
});

test('labels 为空字符串时替换为空', () => {
  assert.strictEqual(renderTemplate('标记 {labels}', { labels: '' }), '标记 ');
});

test('未提供 labels/notLabels 时保留原样', () => {
  assert.strictEqual(
    renderTemplate('打上 {not_labels} 与 {labels}', { youtrackId: 'CS-1' }),
    '打上 {not_labels} 与 {labels}'
  );
});
