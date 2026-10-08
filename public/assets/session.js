// Sign-in session and calls to the AION proxy, shared by the sign-in page and the dashboard.
// The session lasts until the tab is closed or the proxy's 12-hour token runs out.

const KEY = "aione-session";

// https in production; http://localhost when testing on this computer.
export const proxyReady = () => /^(https:\/\/|http:\/\/localhost[:/])/.test(String(window.AIONE_API || ""));

export function getSession() {
  try {
    const s = JSON.parse(sessionStorage.getItem(KEY) || "null");
    if (s && s.token && s.expiresAt > Date.now()) return s;
  } catch {}
  return null;
}

export function saveSession(s) {
  try { sessionStorage.setItem(KEY, JSON.stringify(s)); } catch {}
}

export function signOut() {
  try { sessionStorage.removeItem(KEY); } catch {}
  location.replace("index.html");
}

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
    if (code === "session") signOut();
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
    if (code === "session") signOut();
    throw new ApiError(code, (data && data.error) || "HTTP " + res.status, res.status);
  }
  return data;
}
