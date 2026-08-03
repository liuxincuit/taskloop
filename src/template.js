function renderTemplate(content, { youtrackId, wikiUrl } = {}) {
  let result = content;
  if (youtrackId !== undefined && youtrackId !== null) {
    result = result.replaceAll('{youtrack_id}', youtrackId);
  }
  if (wikiUrl !== undefined && wikiUrl !== null) {
    result = result.replaceAll('{wiki_url}', wikiUrl);
  }
  return result;
}

module.exports = { renderTemplate };
