// Sign-in session and calls to the AION proxy, shared by the sign-in page and the dashboard.
// The sign-in is remembered in this browser (all tabs, also after closing it) until the proxy's
// 24-hour token runs out or the person signs out, so links in emails open straight into the dashboard.

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
  try { store().removeItem(KEY); } catch {}
  location.replace("index.html" + (keepTicket ? location.hash : ""));
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

// Calls the proxy. Throws ApiError with code "network", "session", "login", "jira", "rate_limited", ...
export async function api(path, { method = "GET", body } = {}) {
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
    throw new ApiError(code, (data && data.error) || "HTTP " + res.status, res.status);
  }
  return data;
}
