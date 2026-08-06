function renderTemplate(content, { youtrackId, wikiUrl, labels, notLabels } = {}) {
  let result = content;
  if (youtrackId !== undefined && youtrackId !== null) {
    result = result.replaceAll('{youtrack_id}', youtrackId);
  }
  if (wikiUrl !== undefined && wikiUrl !== null) {
    result = result.replaceAll('{wiki_url}', wikiUrl);
  }
  if (labels !== undefined && labels !== null) {
    result = result.replaceAll('{labels}', labels);
  }
  if (notLabels !== undefined && notLabels !== null) {
    result = result.replaceAll('{not_labels}', notLabels);
  }
  return result;
}

module.exports = { renderTemplate };
