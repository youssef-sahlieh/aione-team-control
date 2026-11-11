import test from 'node:test';
import assert from 'node:assert/strict';
import { loadFilters, queryOf } from '../../public/assets/components/work-log-overview.js';

// A storage stand-in: the browser's localStorage, or one that throws (private windows, blocked site data).
const memory = (initial = null) => {
  let value = initial;
  return { getItem: () => value, setItem: (_k, v) => { value = v; }, get value() { return value; } };
};
const throwing = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } };

test('the default filters send an empty query, so the server applies "This month" and every entry', () => {
  assert.equal(queryOf(loadFilters(memory())), '');
});

test('only the filters that differ from the defaults are sent', () => {
  const f = { ...loadFilters(memory()), q: ' bulk ', person: 'Dana', billable: true, sync: 'attention', groupBy: 'day' };
  const p = new URLSearchParams(queryOf(f));
  assert.equal(p.get('q'), ' bulk ');
  assert.equal(p.get('person'), 'Dana');
  assert.equal(p.get('billable'), '1');
  assert.equal(p.get('sync'), 'attention');
  assert.equal(p.get('groupBy'), 'day');
  assert.equal(p.has('period'), false);
  assert.equal(p.has('client'), false);
});

test('a custom period sends both inclusive dates, and paging is added last', () => {
  const f = { ...loadFilters(memory()), period: 'custom', from: '2026-10-03', to: '2026-10-09' };
  const p = new URLSearchParams(queryOf(f, { offset: 50, limit: 50 }));
  assert.equal(p.get('period'), 'custom');
  assert.equal(p.get('from'), '2026-10-03');
  assert.equal(p.get('to'), '2026-10-09');
  assert.equal(p.get('offset'), '50');
  assert.equal(p.get('limit'), '50');
});

test('filters are remembered in the browser and read back', () => {
  const store = memory(JSON.stringify({ period: 'last_month', q: 'login', billable: true, sync: 'posted' }));
  const f = loadFilters(store);
  assert.equal(f.period, 'last_month');
  assert.equal(f.q, 'login');
  assert.equal(f.billable, true);
  assert.equal(f.sync, 'posted');
  assert.equal(f.person, '');
});

test('saved values that are not valid are replaced by the defaults', () => {
  const f = loadFilters(memory(JSON.stringify({ period: 'next_year', sync: 'everything', groupBy: 'ticket', q: 5, billable: 'yes', extra: 1 })));
  assert.equal(f.period, 'this_month');
  assert.equal(f.sync, 'all');
  assert.equal(f.groupBy, '');
  assert.equal(f.q, '');
  assert.equal(f.billable, false);
  assert.equal(Object.hasOwn(f, 'extra'), false);
});

test('a corrupt or unreadable store gives the defaults rather than an error', () => {
  assert.equal(loadFilters(memory('{not json')).period, 'this_month');
  assert.equal(loadFilters(memory('null')).sync, 'all');
  assert.equal(loadFilters(throwing).period, 'this_month');
});
