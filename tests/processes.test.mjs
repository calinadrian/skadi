// Programs started from Skadi are found at shutdown, orphans included.
import test from 'node:test';
import assert from 'node:assert/strict';

import { trackedDescendants } from '../src/processes.mjs';

test('finds descendants of a recorded shell, even after the shell exited', () => {
  const t = 1_000_000;
  const tracked = new Map([[100, t]]);
  const table = [
    // The shell (pid 100) is gone; its child lives on as an orphan.
    { pid: 200, ppid: 100, created: t + 50 },
    { pid: 300, ppid: 200, created: t + 90 },
    { pid: 999, ppid: 4, created: t - 10_000 }, // unrelated
  ];
  assert.deepEqual([...trackedDescendants(table, tracked)].sort(), [200, 300]);
});

test('a live recorded shell is included; a newer process on a reused PID is not', () => {
  const t = 1_000_000;
  assert.deepEqual([...trackedDescendants([{ pid: 100, ppid: 1, created: t - 5 }], new Map([[100, t]]))], [100]);
  // PID 100 now belongs to a process started long after our shell; neither it
  // nor the children it started are ours.
  const reused = [
    { pid: 100, ppid: 1, created: t + 60_000 },
    { pid: 101, ppid: 100, created: t + 61_000 },
  ];
  assert.deepEqual([...trackedDescendants(reused, new Map([[100, t]]))], []);
});

test('a "child" older than its parent is PID reuse, not ours', () => {
  const t = 1_000_000;
  const table = [{ pid: 500, ppid: 100, created: t - 60_000 }];
  assert.deepEqual([...trackedDescendants(table, new Map([[100, t]]))], []);
});
