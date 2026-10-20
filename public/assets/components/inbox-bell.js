// The bell in the top bar: @mentions and internal notes sent to you (kept by the proxy, see inbox.js),
// plus tickets created since you last opened it that are yours (every new ticket for administrators).
const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
const ago = (iso) => { const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000); return s < 60 ? "just now" : s < 3600 ? Math.round(s / 60) + " min ago" : s < 86400 ? Math.round(s / 3600) + " h ago" : Math.round(s / 86400) + " d ago"; };
const KIND = { mention: "mentioned you", note: "sent you an internal note", ticket: "New ticket" };

export function createInboxBell({ api, button, count, panel, issues, mine, open, toast }) {
  // shownSeen: the last look before this one, so what is new stays highlighted while the list is open.
  let shownSeen = null, items = [], seenAt = null, newTickets = [], timer = null, off = false, shown = new Set(), first = true;
  const unread = () => items.filter((x) => x.at > seenAt).length + newTickets.length;
  function paint() {
    const n = unread();
    count.hidden = !n; count.textContent = n > 99 ? "99+" : String(n);
    button.setAttribute("aria-label", n ? "Notifications, " + n + " new" : "Notifications");
    if (!panel.hidden) list();
  }
  // Tickets created after the last look, yours only (administrators: all of them).
  function update() {
    if (!seenAt || !panel.hidden) return; // the open list stays as it was opened
    newTickets = (issues() || []).filter((i) => i && i.created && new Date(i.created).toISOString() > seenAt && mine(i)).sort((a, b) => (a.created < b.created ? 1 : -1)).slice(0, 30);
    paint();
  }
  function announce() {
    // A toast for anything that arrived since the last check (not on the first load of the page).
    const fresh = [...items.filter((x) => x.at > seenAt).map((x) => x.id), ...newTickets.map((i) => "t:" + i.key)].filter((id) => !shown.has(id));
    fresh.forEach((id) => shown.add(id));
    if (first) { first = false; return; }
    if (!fresh.length) return;
    const one = items.find((x) => x.id === fresh[0]);
    toast(fresh.length === 1 && one ? one.by + " " + KIND[one.type] + " on " + one.key : fresh.length === 1 ? "New ticket assigned to you" : fresh.length + " new notifications");
  }
  async function load() {
    if (off) return;
    try {
      const r = await api("/inbox");
      if (r.off) { off = true; button.hidden = true; return; }
      items = r.items || []; seenAt = r.seenAt; button.hidden = false;
      update(); announce();
    } catch { /* the bell waits for the next check */ }
  }
  function row(kind, key, title, by, text, at, isNew) {
    const b = el("button", "inbox-item" + (isNew ? " new" : "")); b.type = "button";
    const head = el("div", "inbox-head");
    head.append(el("b", null, kind === "ticket" ? "New ticket" : by), el("span", null, kind === "ticket" ? "" : " " + KIND[kind]), el("span", "inbox-when", ago(at)));
    b.append(head, el("div", "inbox-key", key + (title ? " — " + title : "")));
    if (text) b.append(el("div", "inbox-text", text));
    b.addEventListener("click", () => { close(); open(key); });
    return b;
  }
  function list() {
    const body = el("div", "inbox-list"), top = el("div", "inbox-top");
    const clear = el("button", "btn", "Clear"); clear.type = "button"; clear.disabled = !items.length;
    clear.addEventListener("click", async () => { try { await api("/inbox/clear", { method: "POST", body: {} }); items = []; paint(); } catch (err) { toast(err.message || "Couldn't clear notifications.", null, true); } });
    top.append(el("b", null, "Notifications"), clear);
    const rows = [...newTickets.map((i) => ({ at: new Date(i.created).toISOString(), node: row("ticket", i.key, i.summary, "", "", i.created, true) })),
      ...items.map((x) => ({ at: x.at, node: row(x.type, x.key, x.title, x.by, x.text, x.at, x.at > shownSeen) }))].sort((a, b) => (a.at < b.at ? 1 : -1));
    if (!rows.length) body.append(el("p", "msg", "Nothing new. When someone @mentions you or sends you a note, it shows here."));
    rows.forEach((r) => body.append(r.node));
    panel.replaceChildren(top, body);
  }
  async function openPanel() {
    shownSeen = seenAt; panel.hidden = false; button.setAttribute("aria-expanded", "true"); list();
    try { const r = await api("/inbox/seen", { method: "POST", body: {} }); seenAt = r.seenAt; } catch {}
    count.hidden = true;
  }
  function close() {
    panel.hidden = true; button.setAttribute("aria-expanded", "false");
    update();
  }
  button.addEventListener("click", (e) => { e.stopPropagation(); panel.hidden ? openPanel() : close(); });
  document.addEventListener("click", (e) => { if (!panel.hidden && !panel.contains(e.target) && e.target !== button) close(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !panel.hidden) { close(); button.focus(); } });
  return {
    start() { load(); clearInterval(timer); timer = setInterval(() => { if (!document.hidden) load(); }, 60000); },
    update() { const before = newTickets.length; update(); if (newTickets.length !== before) announce(); },
    refresh: load
  };
}
