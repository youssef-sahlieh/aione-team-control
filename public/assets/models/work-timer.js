// Timer display helpers. The server owns the timer: it stores the start, pauses and stop times and computes the
// elapsed time. The browser only shows that time (it adds the seconds since the answer arrived, for display) and never
// decides the recorded duration. The completion form takes the server's suggested minutes.
//
// Rounding policy (the same rule as the proxy): the form suggests the elapsed time rounded to the nearest whole minute,
// half up (29 seconds -> 0 minutes, 30 seconds -> 1 minute). Under one minute the form asks for a duration instead of
// inventing one. The exact elapsed seconds are kept on the server and shown in the form.

export const TIMER_STATES = Object.freeze({
  running: 'Running',
  paused: 'Paused',
  stopped: 'Stopped · not logged yet',
  logged: 'Logged',
  discarded: 'Discarded'
});

// Whole seconds as H:MM:SS. Negative input (clock skew) is shown as 0.
export function clockText(ms) {
  const total = Math.max(0, Math.floor(Number(ms) / 1000) || 0);
  const h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60), s = total % 60;
  return h + ':' + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
}

// Whole minutes suggested for the completion form: nearest minute, half up, using integer arithmetic.
export function suggestedMinutes(elapsedMs) {
  const ms = Math.max(0, Math.floor(Number(elapsedMs) || 0));
  return Math.floor((ms + 30000) / 60000);
}

// The elapsed time shown now: the server's figure plus the time since it was received while running.
export function liveElapsedMs(session, receivedAtMs, nowMs) {
  if (!session) return 0;
  const base = Number(session.elapsedMs) || 0;
  return session.state === 'running' ? base + Math.max(0, nowMs - receivedAtMs) : base;
}

// The action buttons a state offers: the timer's own lifecycle, nothing else.
export function timerActions(state) {
  if (state === 'running') return ['pause', 'stop'];
  if (state === 'paused') return ['resume', 'stop'];
  if (state === 'stopped') return ['finish', 'discard'];
  return [];
}

// True while a session still needs the person: it blocks a new timer until it is logged or discarded.
export const isOpenSession = session => !!session && ['running', 'paused', 'stopped'].includes(session.state);
