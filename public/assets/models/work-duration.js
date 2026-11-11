// Durations as Odoo shows them: H:MM. One parser and one formatter for manual entries, timer results and
// corrections. All arithmetic is in whole minutes (integers); decimal hours are read exactly, never through floats.
//
// Accepted input (after trimming):
//   "2"      -> 2 hours              "1.5" / "1,5" -> 1 hour 30 minutes (decimal hours, up to 4 decimals)
//   "2:30"   -> 2 hours 30 minutes   "0:15" -> 15 minutes      "1:5" -> 1 hour 5 minutes
// Anything else is refused, including minutes above 59 ("1:75"), negative or empty values, and units ("1h").
// Decimal hours are rounded to the nearest whole minute, half up ("1.01" -> 1:01).

export const MIN_MINUTES = 1;
export const MAX_MINUTES = 24 * 60;
export const SHORTCUT_MINUTES = [15, 30, 60, 120];

const CLOCK = /^(\d{1,3}):(\d{1,2})$/;
const DECIMAL = /^(\d{1,3})(?:[.,](\d{1,4}))?$/;

// Returns { minutes } or { error }. An empty value is an error too: callers decide whether empty means "not entered".
export function parseDurationInput(text) {
  const s = String(text ?? '').trim();
  if (!s) return { error: 'Enter a duration, like 1:30.' };
  let minutes;
  let m = CLOCK.exec(s);
  if (m) {
    const mins = Number(m[2]);
    if (mins > 59) return { error: 'Minutes must be from 00 to 59.' };
    minutes = Number(m[1]) * 60 + mins;
  } else if ((m = DECIMAL.exec(s))) {
    // H + F / 10^k hours = (H * 10^k + F) * 60 / 10^k minutes. Round half up using integers only.
    const digits = m[2] || '', scale = 10 ** digits.length;
    const numerator = (Number(m[1]) * scale + Number(digits || 0)) * 60;
    minutes = Math.floor((2 * numerator + scale) / (2 * scale));
  } else {
    return { error: 'Use H:MM, like 1:30, or decimal hours, like 1.5.' };
  }
  if (minutes < MIN_MINUTES) return { error: 'Enter at least 0:01.' };
  if (minutes > MAX_MINUTES) return { error: 'Enter at most 24:00.' };
  return { minutes };
}

// Whole minutes as H:MM (hours are not capped at 24 here, so a long timer can still be shown).
export function formatDuration(minutes) {
  if (!Number.isInteger(minutes) || minutes < 0) throw new RangeError('formatDuration needs whole, non-negative minutes');
  return Math.floor(minutes / 60) + ':' + String(minutes % 60).padStart(2, '0');
}

// The text to show after the field loses focus: the normalized value, '' for empty input, or null when invalid.
export function normalizeDuration(text) {
  if (!String(text ?? '').trim()) return '';
  const r = parseDurationInput(text);
  return r.error ? null : formatDuration(r.minutes);
}

// Validation for the duration field: the message to show, or '' when the value is usable.
export function durationFieldError(text) {
  if (!String(text ?? '').trim()) return 'Enter a duration, like 1:30.';
  const r = parseDurationInput(text);
  return r.error || '';
}
