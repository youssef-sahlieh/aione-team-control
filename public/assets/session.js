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
