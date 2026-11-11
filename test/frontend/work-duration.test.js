import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseDurationInput, formatDuration, normalizeDuration, durationFieldError,
  MIN_MINUTES, MAX_MINUTES, SHORTCUT_MINUTES
} from '../../public/assets/models/work-duration.js';

const ok = text => {
  const r = parseDurationInput(text);
  assert.equal(r.error, undefined, text + ' should parse');
  return r.minutes;
};
const refused = text => {
  const r = parseDurationInput(text);
  assert.ok(r.error, text + ' should be refused');
  assert.equal(r.minutes, undefined);
};

test('H:MM is read as hours and minutes', () => {
  assert.equal(ok('1:30'), 90);
  assert.equal(ok('0:15'), 15);
  assert.equal(ok('1:5'), 65, 'one minute digit is accepted');
  assert.equal(ok(' 2:30 '), 150, 'spaces around the value are ignored');
  assert.equal(ok('24:00'), 1440);
  assert.equal(ok('0:01'), MIN_MINUTES);
});

test('a bare number is hours', () => {
  assert.equal(ok('2'), 120);
  assert.equal(ok('24'), 1440);
});

test('decimal hours are read exactly, with a dot or a comma', () => {
  assert.equal(ok('1.5'), 90);
  assert.equal(ok('1,5'), 90);
  assert.equal(ok('0.25'), 15);
  assert.equal(ok('0.1'), 6);
  assert.equal(ok('2.0'), 120);
});

test('decimal hours round to the nearest minute, half up', () => {
  assert.equal(ok('1.01'), 61, '1.01 h = 60.6 min -> 61');
  assert.equal(ok('1.0083'), 60, '1.0083 h = 60.498 min -> 60');
  assert.equal(ok('1.0084'), 61, '1.0084 h = 60.504 min -> 61');
  assert.equal(ok('0.5083'), 30, '0.5083 h = 30.498 min -> 30');
  assert.equal(ok('0.5085'), 31, '0.5085 h = 30.51 min -> 31');
  refused('0.50833');  // more than 4 decimals are refused, not rounded
  assert.equal(ok('0.0167'), 1, '0.0167 h = 1.002 min -> 1');
});

test('values that round to nothing are refused, and a sub-minute value rounds up to 1', () => {
  refused('0.001');
  assert.equal(ok('0.0084'), 1, '0.0084 h = 0.504 min -> 1');
});

test('invalid text is refused with a message', () => {
  for (const text of ['', '   ', 'abc', '1h', '1h 30m', '1:75', '1:60', '-5', '-1:00', '1.5.5', '1:30:00', '1.25.3', '+2', '1e2']) {
    refused(text);
  }
});

test('zero and values above 24 hours are refused', () => {
  refused('0');
  refused('0:00');
  refused('24:01');
  refused('25');
  refused('24.5');
  assert.equal(parseDurationInput('0:00').error, 'Enter at least 0:01.');
  assert.equal(parseDurationInput('24:01').error, 'Enter at most 24:00.');
});

test('minutes must be 00 to 59 in H:MM', () => {
  assert.equal(parseDurationInput('1:99').error, 'Minutes must be from 00 to 59.');
});

test('formatDuration writes whole minutes as H:MM', () => {
  assert.equal(formatDuration(0), '0:00');
  assert.equal(formatDuration(1), '0:01');
  assert.equal(formatDuration(90), '1:30');
  assert.equal(formatDuration(1440), '24:00');
  assert.equal(formatDuration(1500), '25:00', 'timers longer than a day are still shown');
});

test('formatDuration refuses values that are not whole non-negative minutes', () => {
  for (const v of [-1, 1.5, NaN, Infinity, '90', null]) {
    assert.throws(() => formatDuration(v), RangeError, String(v));
  }
});

test('normalizeDuration: the text the field shows after it loses focus', () => {
  assert.equal(normalizeDuration('1.5'), '1:30');
  assert.equal(normalizeDuration('2'), '2:00');
  assert.equal(normalizeDuration('0:5'), '0:05');
  assert.equal(normalizeDuration('  '), '', 'empty stays empty');
  assert.equal(normalizeDuration(''), '');
  assert.equal(normalizeDuration('abc'), null, 'invalid gives null, so the field keeps the text and shows the error');
  assert.equal(normalizeDuration('0:00'), null);
});

test('durationFieldError: the message for the field, or an empty string when it is usable', () => {
  assert.equal(durationFieldError('1:30'), '');
  assert.equal(durationFieldError('1.5'), '');
  assert.equal(durationFieldError(''), 'Enter a duration, like 1:30.');
  assert.equal(durationFieldError('1h'), 'Use H:MM, like 1:30, or decimal hours, like 1.5.');
  assert.equal(durationFieldError('24:30'), 'Enter at most 24:00.');
});

test('the shortcuts are 15 minutes, 30 minutes, 1 hour and 2 hours', () => {
  assert.deepEqual(SHORTCUT_MINUTES, [15, 30, 60, 120]);
  for (const m of SHORTCUT_MINUTES) {
    assert.equal(parseDurationInput(formatDuration(m)).minutes, m);
  }
  assert.equal(MAX_MINUTES, 1440);
});
