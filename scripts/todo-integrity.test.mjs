import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import test from 'node:test';

const todoRoot = resolve(process.cwd(), 'todos');

function jsonFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return jsonFiles(path);
    return entry.isFile() && extname(entry.name) === '.json' ? [path] : [];
  });
}

const tracks = jsonFiles(todoRoot).filter((path) => {
  if (path.endsWith('todo.track.schema.json') || path.endsWith('todo.schema.json')) return false;
  const value = JSON.parse(readFileSync(path, 'utf8'));
  return String(value.$schema ?? '').endsWith('todo.track.schema.json');
});

for (const path of tracks) test(`track integrity: ${path.slice(todoRoot.length + 1)}`, () => {
  const value = JSON.parse(readFileSync(path, 'utf8'));
  assert.ok(Array.isArray(value.tasks));
  assert.ok(Array.isArray(value.milestones));
  const ids = value.tasks.map((task) => task.id);
  assert.equal(new Set(ids).size, ids.length, 'task IDs must be unique');
  const byId = new Map(value.tasks.map((task) => [task.id, task]));
  const statuses = new Set(value.status_scale);
  for (const task of value.tasks) {
    assert.ok(statuses.has(task.status), `${task.id}: unknown status`);
    assert.ok(Number.isFinite(task.progress_percent) && task.progress_percent >= 0 && task.progress_percent <= 100, `${task.id}: invalid progress`);
    if (task.status === 'done') assert.equal(task.progress_percent, 100, `${task.id}: done must be 100%`);
    if (task.status === 'todo') assert.equal(task.progress_percent, 0, `${task.id}: todo must be 0%`);
    if (task.status === 'partial') assert.ok(task.progress_percent > 0 && task.progress_percent < 100, `${task.id}: partial must be between 0 and 100%`);
    for (const dependency of task.dependencies ?? []) assert.ok(byId.has(dependency), `${task.id}: missing dependency ${dependency}`);
  }
  const milestoneStatuses = Object.fromEntries(
    Object.keys(value.tasks_status_summary.milestones).filter((key) => key !== 'total').map((key) => [key, 0])
  );
  for (const milestone of value.milestones) {
    assert.ok(statuses.has(milestone.status) && milestone.status in milestoneStatuses, `${milestone.id}: invalid milestone status`);
    milestoneStatuses[milestone.status] += 1;
    for (const id of milestone.task_ids) assert.ok(byId.has(id), `${milestone.id}: missing task ${id}`);
  }
  for (const id of value.critical_path_tasks ?? []) assert.ok(byId.has(id), `missing critical task ${id}`);
  const counts = Object.fromEntries([...statuses].map((status) => [status, value.tasks.filter((task) => task.status === status).length]));
  assert.equal(value.tasks_status_summary.total, value.tasks.length);
  for (const status of statuses) assert.equal(value.tasks_status_summary.by_status[status], counts[status], `summary mismatch: ${status}`);
  assert.deepEqual(value.tasks_status_summary.milestones, { total: value.milestones.length, ...milestoneStatuses });
  const average = Number((value.tasks.reduce((sum, task) => sum + task.progress_percent, 0) / Math.max(1, value.tasks.length)).toFixed(2));
  assert.equal(value.tasks_status_summary.progress_percent_done, average);
});
