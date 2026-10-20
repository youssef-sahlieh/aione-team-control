// The bell in the top bar: @mentions and internal notes sent to you (kept by the proxy, see inbox.js),
// plus tickets created since your notifications started that are yours (every new ticket for
// administrators). Each one stays unread until you click it (or "Mark all read").
const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
const ago = (iso) => { const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000); return s < 60 ? "just now" : s < 3600 ? Math.round(s / 60) + " min ago" : s < 86400 ? Math.round(s / 3600) + " h ago" : Math.round(s / 86400) + " d ago"; };
const KIND = { mention: "mentioned you", note: "sent you an internal note" };
const EVERY = 15000; // how often the bell checks while the page is visible

export function createInboxBell({ api, button, count, panel, issues, mine, open, toast }) {
  let items = [], seenAt = null, readTickets = new Set(), newTickets = [], timer = null, off = false, first = true, busy = false;
  const shown = new Set();
  const unreadItems = () => items.filter((x) => !x.read);
  const unread = () => unreadItems().length + newTickets.length;
  function paint() {
    const n = unread();
    count.hidden = !n; count.textContent = n > 99 ? "99+" : String(n);
    button.setAttribute("aria-label", n ? "Notifications, " + n + " unread" : "Notifications");
    if (!panel.hidden) list();
  }
  // Unread new tickets: created after your notifications started, yours (administrators: all of them).
  function update() {
    if (!seenAt) return;
    newTickets = (issues() || []).filter((i) => i && i.created && !readTickets.has(i.key) && new Date(i.created).toISOString() > seenAt && mine(i)).sort((a, b) => (a.created < b.created ? 1 : -1)).slice(0, 50);
    paint();
  }
  function take(r) { items = r.items || []; seenAt = r.seenAt; readTickets = new Set(r.readTickets || []); update(); }
  function announce() {
    // A short message for anything that arrived since the last check (not on the first load of the page).
    const fresh = [...unreadItems().map((x) => x.id), ...newTickets.map((i) => "t:" + i.key)].filter((id) => !shown.has(id));
    fresh.forEach((id) => shown.add(id));
    if (first) { first = false; return; }
    if (!fresh.length) return;
    const one = items.find((x) => x.id === fresh[0]);
    toast(fresh.length === 1 && one ? one.by + " " + KIND[one.type] + " on " + one.key : fresh.length === 1 ? "New ticket: " + fresh[0].slice(2) : fresh.length + " new notifications");
  }
  async function load() {
    if (off || busy) return;
    busy = true;
    try {
      const r = await api("/inbox");
      if (r.off) { off = true; button.hidden = true; return; }
      button.hidden = false; take(r); announce();
    } catch { /* the bell waits for the next check */ }
    finally { busy = false; }
  }
  // Marking as read shows at once; the proxy is told in the background.
  async function markRead(body) {
    try { take(await api("/inbox/read", { method: "POST", body })); } catch { load(); }
  }
  function row({ kind, key, title, by, text, at, isNew, onOpen }) {
    const b = el("button", "inbox-item" + (isNew ? " new" : "")); b.type = "button";
    const head = el("div", "inbox-head");
    if (kind === "ticket") head.append(el("b", null, "New ticket")); else head.append(el("b", null, by), el("span", null, " " + KIND[kind]));
    head.append(el("span", "inbox-when", ago(at)));
    b.append(head, el("div", "inbox-key", key + (title ? " — " + title : "")));
    if (text) b.append(el("div", "inbox-text", text));
    b.addEventListener("click", () => { onOpen(); close(); open(key); });
    return b;
  }
  function list() {
    const body = el("div", "inbox-list"), top = el("div", "inbox-top");
    const all = el("button", "btn", "Mark all read"); all.type = "button"; all.disabled = !unread();
    all.addEventListener("click", () => {
      const tickets = newTickets.map((i) => i.key);
      items = items.map((x) => ({ ...x, read: true })); tickets.forEach((k) => readTickets.add(k)); update();
      markRead({ all: true, tickets });
    });
    top.append(el("b", null, "Notifications"), all);
    const rows = [
      ...newTickets.map((i) => ({ at: new Date(i.created).toISOString(), node: row({ kind: "ticket", key: i.key, title: i.summary, at: i.created, isNew: true, onOpen: () => { readTickets.add(i.key); update(); markRead({ tickets: [i.key] }); } }) })),
      ...items.map((x) => ({ at: x.at, node: row({ kind: x.type, key: x.key, title: x.title, by: x.by, text: x.text, at: x.at, isNew: !x.read, onOpen: () => { if (x.read) return; x.read = true; paint(); markRead({ id: x.id }); } }) }))
    ].sort((a, b) => (a.at < b.at ? 1 : -1));
    if (!rows.length) body.append(el("p", "msg", "Nothing yet. When someone @mentions you, sends you a note or gives you a new ticket, it shows here."));
    rows.forEach((r) => body.append(r.node));
    panel.replaceChildren(top, body);
  }
  function openPanel() { panel.hidden = false; button.setAttribute("aria-expanded", "true"); list(); load(); }
  function close() { panel.hidden = true; button.setAttribute("aria-expanded", "false"); }
  button.addEventListener("click", (e) => { e.stopPropagation(); panel.hidden ? openPanel() : close(); });
  document.addEventListener("click", (e) => { if (!panel.hidden && !panel.contains(e.target) && !button.contains(e.target)) close(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !panel.hidden) { close(); button.focus(); } });
  // Check straight away when you come back to the page.
  document.addEventListener("visibilitychange", () => { if (!document.hidden) load(); });
  window.addEventListener("focus", () => load());
  return {
    start() { load(); clearInterval(timer); timer = setInterval(() => { if (!document.hidden) load(); }, EVERY); },
    update() { const before = newTickets.map((i) => i.key).join(); update(); if (newTickets.map((i) => i.key).join() !== before) announce(); },
    refresh: load
  };
}
