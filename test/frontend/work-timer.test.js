import test from 'node:test';
import assert from 'node:assert/strict';
import {
  TIMER_STATES, clockText, suggestedMinutes, liveElapsedMs, timerActions, isOpenSession
} from '../../public/assets/models/work-timer.js';

test('the clock shows H:MM:SS and never goes negative', () => {
  assert.equal(clockText(0), '0:00:00');
  assert.equal(clockText(999), '0:00:00', 'partial seconds are not shown');
  assert.equal(clockText(59999), '0:00:59');
  assert.equal(clockText(60000), '0:01:00');
  assert.equal(clockText(3723000), '1:02:03');
  assert.equal(clockText(36000000), '10:00:00');
  assert.equal(clockText(-5000), '0:00:00', 'clock skew is shown as 0');
  assert.equal(clockText(NaN), '0:00:00');
  assert.equal(clockText(undefined), '0:00:00');
});

test('the suggested duration is the elapsed time to the nearest minute, half up', () => {
  assert.equal(suggestedMinutes(0), 0);
  assert.equal(suggestedMinutes(29999), 0, '29 seconds and 999 ms -> 0 minutes');
  assert.equal(suggestedMinutes(30000), 1, 'exactly 30 seconds -> 1 minute');
  assert.equal(suggestedMinutes(89999), 1);
  assert.equal(suggestedMinutes(90000), 2, 'exactly 1 min 30 s -> 2 minutes');
  assert.equal(suggestedMinutes(60 * 60 * 1000), 60);
  assert.equal(suggestedMinutes(-1000), 0);
  assert.equal(suggestedMinutes(NaN), 0);
});

test('the live elapsed time adds the time since the answer only while running', () => {
  const running = { state: 'running', elapsedMs: 120000 };
  assert.equal(liveElapsedMs(running, 1000, 1000), 120000);
  assert.equal(liveElapsedMs(running, 1000, 6000), 125000);
  assert.equal(liveElapsedMs(running, 6000, 1000), 120000, 'a clock that went backwards adds nothing');

  const paused = { state: 'paused', elapsedMs: 120000 };
  assert.equal(liveElapsedMs(paused, 1000, 999999), 120000, 'a paused timer does not move');

  const stopped = { state: 'stopped', elapsedMs: 42000 };
  assert.equal(liveElapsedMs(stopped, 1000, 999999), 42000);

  assert.equal(liveElapsedMs(null, 0, 0), 0);
  assert.equal(liveElapsedMs({ state: 'running' }, 0, 1000), 1000, 'a missing elapsed time counts as 0');
});

test('each state offers only its own actions', () => {
  assert.deepEqual(timerActions('running'), ['pause', 'stop']);
  assert.deepEqual(timerActions('paused'), ['resume', 'stop']);
  assert.deepEqual(timerActions('stopped'), ['finish', 'discard']);
  assert.deepEqual(timerActions('logged'), []);
  assert.deepEqual(timerActions('discarded'), []);
  assert.deepEqual(timerActions('unknown'), []);
});

test('a session is open until it is logged or discarded', () => {
  assert.equal(isOpenSession(null), false);
  assert.equal(isOpenSession(undefined), false);
  assert.equal(isOpenSession({ state: 'running' }), true);
  assert.equal(isOpenSession({ state: 'paused' }), true);
  assert.equal(isOpenSession({ state: 'stopped' }), true, 'a stopped timer blocks a new one until logged or discarded');
  assert.equal(isOpenSession({ state: 'logged' }), false);
  assert.equal(isOpenSession({ state: 'discarded' }), false);
});

test('every state has a label', () => {
  for (const s of ['running', 'paused', 'stopped', 'logged', 'discarded']) {
    assert.equal(typeof TIMER_STATES[s], 'string');
  }
});
