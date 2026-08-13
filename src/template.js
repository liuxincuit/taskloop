const fs = require('node:fs');
const path = require('node:path');

const INCLUDE_RE = /\{\{include:([^}]+)\}\}/g;

function expandIncludes(content, baseDir) {
  const seen = new Set();
  function expand(text, dir) {
    return text.replace(INCLUDE_RE, (match, rawPath) => {
      const incPath = rawPath.trim();
      if (incPath.length === 0) {
        throw new Error(`include 路径不能为空: ${match}`);
      }
      if (path.isAbsolute(incPath)) {
        throw new Error(`include 只支持相对路径: ${incPath}`);
      }
      const resolved = path.resolve(dir, incPath);
      if (seen.has(resolved)) {
        throw new Error(`include 循环引用: ${resolved}`);
      }
      seen.add(resolved);
      let part;
      try {
        part = fs.readFileSync(resolved, 'utf8');
      } catch (err) {
        seen.delete(resolved);
        throw new Error(`include 片段读取失败: ${resolved} (${err.message})`);
      }
      const expanded = expand(part, path.dirname(resolved));
      seen.delete(resolved);
      return expanded;
    });
  }
  return expand(content, baseDir);
}

function renderTemplateFile(templatePath, placeholders) {
  let content;
  try {
    content = fs.readFileSync(templatePath, 'utf8');
  } catch (err) {
    throw new Error(`模板读取失败: ${templatePath} (${err.message})`);
  }
  const expanded = expandIncludes(content, path.dirname(templatePath));
  return renderTemplate(expanded, placeholders);
}

function renderTemplate(content, values = {}) {
  let result = content;
  for (const [name, value] of Object.entries(values)) {
    if (value !== undefined && value !== null) {
      result = result.replaceAll(`{${name}}`, value);
    }
  }
  return result;
}

module.exports = { expandIncludes, renderTemplateFile, renderTemplate };
