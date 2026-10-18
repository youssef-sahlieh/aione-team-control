// Sync errors: ticket changes that didn't go through (to Jira, Odoo or the dashboard's own data), kept in this
// browser so they can be retried exactly as they were sent; plus the state of the API keys (administrators).
// A failed change disappears when it is retried successfully, or when the same change later succeeds.
const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
const button = (text, cls, fn) => { const b = el("button", cls, text); b.type = "button"; b.addEventListener("click", fn); return b; };

// Ticket changes worth keeping; reads and sign-in are never kept.
const WATCHED = /^\/(jira\/issue\/|internal(\/|$)|odoo\/tickets\/|ticket-metadata$|date-requests\/|ticket-notes$|mail$)/;
// Errors the dashboard already handles with a question (billing, closing checklist, date process, sign-in).
const HANDLED = new Set(["session", "billing_required", "closure_required", "date_request", "backend_outdated"]);
const MAX = 100;

export function describeChange(path, method, body = {}) {
  const key = (/([A-Z][A-Z0-9_]*-\d+)/.exec(path) || [])[1] || (body && typeof body.key === "string" ? body.key : "");
  let what = "Update";
  if (/\/transitions$/.test(path)) what = "Move status";
  else if (/\/comment$/.test(path)) what = "Add comment";
  else if (/\/note$/.test(path)) what = "Add Odoo note";
  else if (/^\/jira\/issue\/[^/]+$/.test(path)) what = body?.fields && "assignee" in body.fields ? "Change assignee" : body?.fields?.labels ? "Change developers" : "Update Jira ticket";
  else if (path === "/internal" && method === "POST") what = "Create internal ticket";
  else if (/^\/internal\/[^/]+$/.test(path)) what = method === "DELETE" ? "Delete internal ticket" : body && "status" in body ? "Move status" : body && "assignee" in body ? "Change assignee" : body && body.devs ? "Change developers" : "Update internal ticket";
  else if (/^\/odoo\/tickets\/[^/]+$/.test(path)) what = body && "stage" in body ? "Move status" : body && body.devs ? "Change developer" : "Update Odoo ticket";
  else if (path === "/ticket-metadata") what = "Save ticket fields";
  else if (path.startsWith("/date-requests/")) what = "Date request: " + path.slice(15).replace(/-/g, " ");
  else if (path === "/ticket-notes" || path === "/mail") what = "Send internal note";
  return { key, what };
}

export function createSyncErrors({ api, onApiWrite, storageKey, isAdmin, onRetried, onChange, formatTime }) {
  let items = [];
  try { items = JSON.parse(localStorage.getItem(storageKey()) || "[]"); } catch { items = []; }
  const save = () => { try { localStorage.setItem(storageKey(), JSON.stringify(items.slice(-MAX))); } catch {} onChange(); };
  const same = (a, b) => a.path === b.path && a.method === b.method && JSON.stringify(a.body ?? null) === JSON.stringify(b.body ?? null);
  const reload = () => { try { items = JSON.parse(localStorage.getItem(storageKey()) || "[]"); } catch { items = []; } onChange(); };

  onApiWrite(({ ok, path, method, body, error }) => {
    if (!WATCHED.test(path.split("?")[0])) return;
    if (ok) { const before = items.length; items = items.filter((x) => !same(x, { path, method, body })); if (items.length !== before) save(); return; }
    if (!error || HANDLED.has(error.code)) return;
    const at = new Date().toISOString(), message = error.code === "network" ? "The server didn't answer (no connection or it timed out). The change may not have been saved." : error.message || "Failed";
    const found = items.find((x) => same(x, { path, method, body }));
    if (found) { found.at = at; found.error = message; found.code = error.code || ""; found.tries = (found.tries || 1) + 1; }
    else items.push({ id: crypto.randomUUID(), at, path, method, body: body ?? null, error: message, code: error.code || "", tries: 1, ...describeChange(path, method, body || {}) });
    save();
  });

  async function retry(item) {
    try { await api(item.path, { method: item.method, body: item.body ?? undefined }); items = items.filter((x) => x.id !== item.id); save(); if (item.key) onRetried(item.key); return true; }
    catch { return false; } // the listener above has already stored the new error
  }

  let keyState = null, keyLoading = false;
  async function loadKeys(force) {
    if (!isAdmin() || keyLoading || (keyState && !force)) return;
    keyLoading = true; onChange();
    try { keyState = await api("/integrations"); } catch (e) { keyState = { error: e.code === "not_found" ? "Deploy the updated proxy to check the API keys." : e.message }; }
    keyLoading = false; onChange();
  }
  const keyProblems = () => (keyState?.keys || []).filter((k) => k.status !== "ok").length;

  function renderKeys(target) {
    const panel = el("section", "panel sync-panel"), head = el("div", "panel-heading"), text = el("div");
    text.append(el("h2", "", "API keys"), el("p", "panel-subtitle", "Whether Jira, GitHub and Odoo accept the dashboard's keys right now, and when they expire."));
    head.append(text, button(keyLoading ? "Checking…" : "Check again", "btn", () => loadKeys(true))); panel.append(head);
    if (!keyState) { panel.append(el("p", "msg", "Checking…")); loadKeys(); }
    else if (keyState.error) panel.append(el("p", "msg err", keyState.error));
    else for (const k of keyState.keys) {
      const row = el("div", "sync-key " + k.status);
      row.append(el("span", "sync-dot"), el("b", "", k.name), el("span", "sync-key-msg", k.message));
      if (k.expiresAt) row.append(el("small", "sync-key-date", "Expires " + k.expiresAt.slice(0, 10)));
      panel.append(row);
    }
    target.append(panel);
  }

  function renderFailures(target) {
    const panel = el("section", "panel sync-panel"), head = el("div", "panel-heading"), text = el("div");
    text.append(el("h2", "", "Changes that didn't go through (" + items.length + ")"), el("p", "panel-subtitle", "Kept in this browser. Retry sends the same change again; it disappears once it succeeds."));
    head.append(text);
    if (items.length) {
      const all = button("Retry all", "btn primary", async () => { all.disabled = true; all.textContent = "Retrying…"; for (const item of [...items].reverse()) await retry(item); });
      head.append(all);
    }
    panel.append(head);
    if (!items.length) { panel.append(el("p", "empty-copy", "Nothing failed. Every change reached Jira, Odoo and the dashboard.")); target.append(panel); return; }
    const list = el("div", "sync-list");
    for (const item of [...items].reverse()) {
      const row = el("article", "sync-item"), main = el("div", "sync-main");
      const title = el("div", "sync-title"); title.append(el("b", "", item.what)); if (item.key) title.append(el("span", "sync-key-ref", item.key));
      main.append(title, el("p", "sync-error", item.error), el("small", "sync-meta", formatTime(item.at) + (item.tries > 1 ? " · tried " + item.tries + " times" : "")));
      const acts = el("div", "sync-acts");
      const again = button("Retry", "btn primary", async () => { again.disabled = true; again.textContent = "Retrying…"; if (!(await retry(item))) { again.disabled = false; again.textContent = "Retry"; } });
      acts.append(again, button("Dismiss", "btn", () => { items = items.filter((x) => x.id !== item.id); save(); }));
      row.append(main, acts); list.append(row);
    }
    panel.append(list); target.append(panel);
  }

  return {
    count: () => items.length + keyProblems(),
    reload, loadKeys,
    render(target) { renderFailures(target); if (isAdmin()) renderKeys(target); }
  };
}
