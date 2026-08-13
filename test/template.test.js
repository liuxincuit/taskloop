const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { renderTemplate, expandIncludes, renderTemplateFile } = require('../src/template.js');

test('替换 {youtrack_id} 为 idReadable', () => {
  assert.strictEqual(
    renderTemplate('请处理任务 {youtrack_id}', { youtrack_id: 'CS-1234' }),
    '请处理任务 CS-1234'
  );
});

test('替换 {youtrack_url}', () => {
  assert.strictEqual(
    renderTemplate('任务链接 {youtrack_url}', { youtrack_url: 'http://yt/issue/CS-1' }),
    '任务链接 http://yt/issue/CS-1'
  );
});

test('替换 {wiki_id}', () => {
  assert.strictEqual(
    renderTemplate('页面 id {wiki_id}', { wiki_id: '123' }),
    '页面 id 123'
  );
});

test('多处占位符全部替换', () => {
  assert.strictEqual(
    renderTemplate('{youtrack_id} 和 {youtrack_id}', { youtrack_id: 'CS-1' }),
    'CS-1 和 CS-1'
  );
});

test('无占位符时原样返回', () => {
  const content = '没有占位符的文本';
  assert.strictEqual(renderTemplate(content, { youtrack_id: 'CS-1' }), content);
});

test('入参内容不被修改', () => {
  const content = '任务 {youtrack_id}';
  renderTemplate(content, { youtrack_id: 'CS-1' });
  assert.strictEqual(content, '任务 {youtrack_id}');
});

test('替换 {wiki_url} 为页面 URL', () => {
  assert.strictEqual(
    renderTemplate('读取页面 {wiki_url}', { wiki_url: 'https://wiki.ispeco.com/pages/viewpage.action?pageId=111' }),
    '读取页面 https://wiki.ispeco.com/pages/viewpage.action?pageId=111'
  );
});

test('多种占位符同时替换', () => {
  assert.strictEqual(
    renderTemplate('任务 {youtrack_id} 页面 {wiki_url}', { youtrack_id: 'CS-1', wiki_url: 'http://w' }),
    '任务 CS-1 页面 http://w'
  );
});

test('wikiUrl 未提供时不替换 {wiki_url}', () => {
  assert.strictEqual(renderTemplate('{wiki_url}', { youtrack_id: 'CS-1' }), '{wiki_url}');
});

test('youtrackId 未提供时不替换 {youtrack_id}', () => {
  assert.strictEqual(renderTemplate('{youtrack_id}', { wiki_url: 'http://w' }), '{youtrack_id}');
});

test('未提供的占位符原样保留（通用机制）', () => {
  assert.strictEqual(renderTemplate('{jira_id}', {}), '{jira_id}');
});

test('通用占位符替换', () => {
  assert.strictEqual(renderTemplate('{a} 和 {b}', { a: '1', b: '2' }), '1 和 2');
});

test('替换 {labels} 为逗号连接后的字符串', () => {
  assert.strictEqual(
    renderTemplate('任务须满足标签 {labels}', { labels: 'ready, explorer' }),
    '任务须满足标签 ready, explorer'
  );
});

test('替换 {not_labels}', () => {
  assert.strictEqual(
    renderTemplate('完成后打上 {not_labels} 标签', { not_labels: 'explored' }),
    '完成后打上 explored 标签'
  );
});

test('显式传 null 时不替换', () => {
  assert.strictEqual(renderTemplate('{a}', { a: null }), '{a}');
});

test('labels 为空字符串时替换为空', () => {
  assert.strictEqual(renderTemplate('标记 {labels}', { labels: '' }), '标记 ');
});

test('未提供时 {not_labels} 与 {labels} 原样保留', () => {
  assert.strictEqual(renderTemplate('打上 {not_labels} 与 {labels}', { youtrack_id: 'CS-1' }), '打上 {not_labels} 与 {labels}');
});

let tmpDir;
before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'template-test-'));
});
after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('expandIncludes：无 include 指令时原样返回', () => {
  const content = '没有 include 的文本';
  assert.strictEqual(expandIncludes(content, tmpDir), content);
});

test('expandIncludes：基础替换为片段文件内容', () => {
  fs.writeFileSync(path.join(tmpDir, 'part.md'), '片段内容', 'utf8');
  assert.strictEqual(
    expandIncludes('行1 {{include:part.md}} 行2', tmpDir),
    '行1 片段内容 行2'
  );
});

test('expandIncludes：相对 baseDir 解析子目录片段', () => {
  fs.mkdirSync(path.join(tmpDir, 'sub'), { recursive: true });
  fs.writeFileSync(path.join(tmpDir, 'sub', 'part.md'), '子目录片段', 'utf8');
  assert.strictEqual(
    expandIncludes('{{include:sub/part.md}}', tmpDir),
    '子目录片段'
  );
});

test('expandIncludes：嵌套 include 相对片段自身目录解析', () => {
  fs.mkdirSync(path.join(tmpDir, 'nested', 'deep'), { recursive: true });
  fs.writeFileSync(path.join(tmpDir, 'nested', 'deep', 'leaf.md'), '叶子', 'utf8');
  fs.writeFileSync(path.join(tmpDir, 'nested', 'b.md'), '[[{{include:deep/leaf.md}}]]', 'utf8');
  assert.strictEqual(
    expandIncludes('{{include:nested/b.md}}', tmpDir),
    '[[叶子]]'
  );
});

test('expandIncludes：循环引用报错', () => {
  fs.writeFileSync(path.join(tmpDir, 'cycle-a.md'), '{{include:cycle-b.md}}', 'utf8');
  fs.writeFileSync(path.join(tmpDir, 'cycle-b.md'), '{{include:cycle-a.md}}', 'utf8');
  assert.throws(
    () => expandIncludes('{{include:cycle-a.md}}', tmpDir),
    /include 循环引用/
  );
});

test('expandIncludes：片段文件不存在报错', () => {
  assert.throws(
    () => expandIncludes('{{include:not-exist.md}}', tmpDir),
    /include 片段读取失败/
  );
});

test('expandIncludes：绝对路径报错', () => {
  assert.throws(
    () => expandIncludes('{{include:D:\\x.md}}', tmpDir),
    /include 只支持相对路径/
  );
});

test('expandIncludes：空白路径报错', () => {
  assert.throws(
    () => expandIncludes('{{include:   }}', tmpDir),
    /include 路径不能为空/
  );
});

test('expandIncludes：同一片段可被多次 include（非循环）', () => {
  assert.strictEqual(
    expandIncludes('{{include:part.md}}+{{include:part.md}}', tmpDir),
    '片段内容+片段内容'
  );
});

test('expandIncludes：展开后片段内占位符可被 renderTemplate 替换', () => {
  fs.writeFileSync(path.join(tmpDir, 'placeholder-part.md'), '打上 {not_labels} 标签', 'utf8');
  const expanded = expandIncludes('{{include:placeholder-part.md}}', tmpDir);
  assert.strictEqual(
    renderTemplate(expanded, { not_labels: 'explored' }),
    '打上 explored 标签'
  );
});

test('renderTemplateFile：读文件 + include + 占位符全链路', () => {
  const tmpl = path.join(tmpDir, 'full.md');
  fs.writeFileSync(path.join(tmpDir, 'output-part.md'), '输出到评论区打上 {not_labels}', 'utf8');
  fs.writeFileSync(tmpl, '任务 {youtrack_id}\n{{include:output-part.md}}', 'utf8');
  assert.strictEqual(
    renderTemplateFile(tmpl, { youtrack_id: 'CS-1', not_labels: 'explored' }),
    '任务 CS-1\n输出到评论区打上 explored'
  );
});

test('renderTemplateFile：模板文件缺失报错', () => {
  assert.throws(
    () => renderTemplateFile(path.join(tmpDir, 'no-such.md'), {}),
    /模板读取失败/
  );
});
