// Same-tab sign-in for AI1 Monitor. The Monitor opens this dashboard with ?ai1-monitor=<state>. We ask Team Control
// for a one-time code bound to that state, then send the browser to the Monitor's callback with the code and state.
// The Monitor's server trades the code for a token, so the token never reaches this page.
import { api } from "../session.js";

const MONITOR_CALLBACK_ORIGIN = "https://monitor.ai1.host";
const STATE_PATTERN = /^[A-Za-z0-9_-]{20,100}$/;

// True when this page was reached with the browser's Back or Forward button (not a fresh visit).
export const reachedWithBackOrForward = () => { try { return performance.getEntriesByType("navigation")[0]?.type === "back_forward"; } catch { return false; } };

// The address without the Monitor sign-in state (to show the dashboard normally).
export function withoutMonitorState(href = location.href) {
  const url = new URL(href); url.searchParams.delete("ai1-monitor");
  return url.pathname + url.search + url.hash;
}

// The state from the address bar, or null when this isn't a Monitor sign-in.
export function monitorStateFromUrl(href = location.href) {
  const state = new URL(href).searchParams.get("ai1-monitor");
  return state && STATE_PATTERN.test(state) ? state : null;
}

// Gets the code and sends the browser to the Monitor. Rejects with a message for the person when it can't.
export async function completeMonitorSignIn(state, { call = api, go = url => location.replace(url) } = {}) {
  if (!STATE_PATTERN.test(state)) throw new Error("AI1 Monitor sign-in didn't start correctly. Open AI1 Monitor again.");
  const { code, callback } = await call("/sso/monitor/code", { method: "POST", body: { state } });
  const target = new URL(callback);
  if (target.origin !== MONITOR_CALLBACK_ORIGIN || target.pathname !== "/auth/aione/callback") {
    throw new Error("AI1 Monitor's address isn't the one this dashboard expects.");
  }
  target.searchParams.set("code", code);
  target.searchParams.set("state", state);
  go(target.href);
}
