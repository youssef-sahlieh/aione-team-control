// Sign-in session and calls to the AION proxy, shared by the sign-in page and the dashboard.
// The sign-in is remembered in this browser (all tabs, also after closing it) until the proxy's
// saved token expires (30 days) or the person signs out, so email links open the dashboard. Signing out
// also cancels the sign-in on the server.

const KEY = "aione-session";

// https in production; http://localhost when testing on this computer.
export const proxyReady = () => /^(https:\/\/|http:\/\/localhost[:/])/.test(String(window.AIONE_API || ""));

const store = () => { try { return window.localStorage; } catch { return null; } };

export function getSession() {
  try {
    const s = JSON.parse(store().getItem(KEY) || "null");
    if (s && s.token && s.expiresAt > Date.now()) return s;
    if (s) store().removeItem(KEY);
  } catch {}
  return null;
}

export function saveSession(s) {
  try { store().setItem(KEY, JSON.stringify(s)); } catch {}
}

// Back to the sign-in page. A ticket in the address (#AION-123) is kept, so it opens after signing in.
export function signOut(keepTicket) {
  let token = "";
  try { token = (JSON.parse(store().getItem(KEY) || "null") || {}).token || ""; } catch {}
  try { Object.keys(localStorage).filter((k) => k.startsWith("aion.cache.")).forEach((k) => localStorage.removeItem(k)); } catch {}
  try { store().removeItem(KEY); } catch {}
  const leave = () => location.replace("index.html" + (keepTicket ? location.search + location.hash : ""));
  if (!token || !proxyReady()) return leave();
  // Cancel the token on the server too (at most 3 seconds, then leave anyway).
  fetch(window.AIONE_API + "/logout", { method: "POST", headers: { Authorization: "Bearer " + token }, signal: AbortSignal.timeout(3000) }).catch(() => {}).finally(leave);
}

// Signing out in one tab signs out the others too.
window.addEventListener("storage", (e) => {
  if (e.key === KEY && !e.newValue && !/index\.html$|\/$|reset\.html$/.test(location.pathname)) location.replace("index.html");
});

export class ApiError extends Error {
  constructor(code, message, status) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

// Sends or fetches a file (raw bytes, not JSON). Returns the Response; throws ApiError like api().
export async function apiFile(path, { method = "GET", body, type } = {}) {
  const s = getSession();
  const headers = {};
  if (s) headers.Authorization = "Bearer " + s.token;
  if (type) headers["Content-Type"] = type;
  let res;
  try {
    res = await fetch(window.AIONE_API + path, { method, headers, body });
  } catch {
    throw new ApiError("network", "network error", 0);
  }
  if (!res.ok) {
    let data = null;
    try { data = await res.json(); } catch {}
    const code = (data && data.code) || (res.status === 413 ? "too_large" : "server");
    if (code === "session") signOut(true);
    throw new ApiError(code, (data && data.error) || (res.status === 413 ? "Files can be up to 4 MB." : "HTTP " + res.status), res.status);
  }
  return res;
}

// Listeners told about every change sent through api() (not reads): { ok, path, method, body, error }.
// The dashboard keeps the failed ones so they can be retried (see components/sync-errors.js).
const writeListeners = [];
export const onApiWrite = (fn) => { writeListeners.push(fn); };
const tellWrite = (info) => { for (const fn of writeListeners) { try { fn(info); } catch {} } };

// Calls the proxy. Throws ApiError with code "network", "session", "login", "jira", "rate_limited", ...
export async function api(path, { method = "GET", body } = {}) {
  if (method === "GET") return request(path, method, body);
  try { const data = await request(path, method, body); tellWrite({ ok: true, path, method, body }); return data; }
  catch (error) { tellWrite({ ok: false, path, method, body, error }); throw error; }
}

async function request(path, method, body) {
  const s = getSession();
  const headers = {};
  if (s) headers.Authorization = "Bearer " + s.token;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  let res;
  try {
    res = await fetch(window.AIONE_API + path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  } catch {
    throw new ApiError("network", "network error", 0);
  }
  let data = null;
  try { data = await res.json(); } catch {}
  if (!res.ok) {
    const code = (data && data.code) || "server";
    if (code === "session") signOut(true);
    if (res.status === 404 && code === "not_found" && data?.error === "Not found." && /^\/(date-requests|ticket-notes|ticket-metadata|clients|reports)(\/|\?|$)/.test(path)) {
      throw new ApiError("backend_outdated", "The connected backend has not been updated for ticket business fields, clients, reports, date requests, and internal notes. Deploy the current main branch in the existing Vercel project. Localhost:3000 also uses this live backend; the sample preview uses a separate local backend.", 404);
    }
    throw new ApiError(code, (data && data.error) || "HTTP " + res.status, res.status);
  }
  return data;
}

// "← Dashboard" on the other pages (Databases, Audit & Deploy, Monitor, Users): when you came here from the
// dashboard, go back to it instead of opening it again, so the browser's Back button keeps working in order.
if (!/\/dashboard\.html$/.test(location.pathname)) {
  document.addEventListener("click", (e) => {
    const link = e.target.closest && e.target.closest('a[href="dashboard.html"]');
    if (!link || e.ctrlKey || e.metaKey || e.shiftKey || e.button !== 0) return;
    let from = null; try { from = new URL(document.referrer); } catch {}
    if (from && from.origin === location.origin && /\/dashboard\.html$/.test(from.pathname) && history.length > 1) { e.preventDefault(); history.back(); }
  });
}
