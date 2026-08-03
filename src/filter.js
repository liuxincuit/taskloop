function filterTasks(tasks, labels, notLabels) {
  return tasks.filter((task) => {
    const taskLabels = new Set(task.labels);
    const hasAll = labels.every((label) => taskLabels.has(label));
    const hasExcluded = notLabels.some((label) => taskLabels.has(label));
    return hasAll && !hasExcluded;
  });
}

module.exports = { filterTasks };
