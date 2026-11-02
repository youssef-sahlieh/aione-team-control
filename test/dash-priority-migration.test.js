// Priorities saved before the High, Medium and Low levels are read as the nearest new value.
import test from 'node:test';
import assert from 'node:assert/strict';
import { migrateDash } from '../proxy/src/ticket-metadata.js';

test('old dashboard priorities are read as High, Medium or Low, and the most urgent old ones get order 1', () => {
  assert.deepEqual(migrateDash({ dashPriority: 'Highest', dashOrder: null }), { dashPriority: 'High', dashOrder: 1 });
  assert.deepEqual(migrateDash({ dashPriority: 'Critical', dashOrder: null }), { dashPriority: 'High', dashOrder: 1 });
  assert.deepEqual(migrateDash({ dashPriority: 'High', dashOrder: null }), { dashPriority: 'High', dashOrder: null });
  assert.deepEqual(migrateDash({ dashPriority: 'Medium', dashOrder: null }), { dashPriority: 'Medium', dashOrder: null });
  assert.deepEqual(migrateDash({ dashPriority: 'Lowest', dashOrder: null }), { dashPriority: 'Low', dashOrder: null });
  assert.deepEqual(migrateDash({ dashPriority: 'Urgent!!', dashOrder: 2 }), { dashPriority: null, dashOrder: 2 });
});

test('a value that is already a level, or no priority, is left as it is', () => {
  const current = { dashPriority: 'Low', dashOrder: 3 };
  assert.equal(migrateDash(current), current);
  const none = { dashPriority: null, dashOrder: null };
  assert.equal(migrateDash(none), none);
});
