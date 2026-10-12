// Sign-in session and calls to the AION proxy, shared by the sign-in page and the dashboard.
// The sign-in is remembered in this browser (all tabs, also after closing it) until the proxy's
// 24-hour HttpOnly cookie runs out or is revoked on sign-out. Only identity and CSRF metadata live in memory.

const KEY = "aion-logout";
let session = null;

// https in production; http://localhost when testing on this computer.
export const proxyReady = () => {try{const url=new URL(window.AIONE_API);return url.origin===location.origin&&(url.protocol==="https:"||["localhost","127.0.0.1"].includes(url.hostname));}catch{return false;}};

const store = () => { try { return window.localStorage; } catch { return null; } };

export function getSession() {
  return session && session.expiresAt > Date.now() ? session : null;
}

export async function loadSession(){
  try{const response=await fetch(window.AIONE_API+"/session",{credentials:"same-origin",cache:"no-store"});if(!response.ok){session=null;return null;}saveSession(await response.json());return getSession();}catch{session=null;return null;}
}

export function saveSession(s) {
  if(!s||typeof s.csrf!=="string"||!s.email)throw new Error("The server needs the secure-session update before you can sign in.");
  session={email:s.email,name:s.name,role:s.role,expiresAt:s.expiresAt,csrf:s.csrf};
  try{store()?.removeItem("aione-session");}catch{}
}

// Back to the sign-in page. A ticket in the address (#AION-123) is kept, so it opens after signing in.
export async function signOut(keepTicket) {
  if(!keepTicket&&getSession()){
    try{const response=await fetch(window.AIONE_API+"/logout",{method:"POST",credentials:"same-origin",headers:{"X-AION-CSRF":session.csrf}});if(!response.ok&&response.status!==401)throw new Error();}
    catch{alert("Could not securely sign out. Please retry when the connection is available.");return;}
  }
  session=null;
  try { store()?.removeItem("aione-session");store()?.setItem(KEY,String(Date.now())); } catch {}
  location.replace("index.html" + (keepTicket ? location.search + location.hash : ""));
}

// Signing out in one tab signs out the others too.
window.addEventListener("storage", (e) => {
  if (e.key === KEY && !/index\.html$|\/$|reset\.html$/.test(location.pathname)) {session=null;location.replace("index.html");}
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
  if (s && !["GET","HEAD"].includes(method)) headers["X-AION-CSRF"] = s.csrf;
  if (type) headers["Content-Type"] = type;
  let res;
  try {
    res = await fetch(window.AIONE_API + path, { method, headers, body, credentials:"same-origin" });
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
  if (s && !["GET","HEAD"].includes(method)) headers["X-AION-CSRF"] = s.csrf;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  let res;
  try {
    res = await fetch(window.AIONE_API + path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined, credentials:"same-origin" });
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
