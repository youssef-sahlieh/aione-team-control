// Users page (administrators only): add people, choose Administrator or User, pick the developer a
// User sees, send password links, and remove accounts. Everything is checked again by the proxy.
import { api, getSession, signOut } from "./session.js";

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const initials = (n) => String(n || "?").split(/\s+/).filter(Boolean).slice(0, 2).map((x) => x[0].toUpperCase()).join("") || "?";
const OTHER = "__other";

let me = null, devs = [], devColors = {}, users = [];
const devK = (d) => devColors[d] || "k" + (1 + [...d].reduce((a, c) => a + c.charCodeAt(0), 0) % 8);

let toastTimer = null;
function toast(text, isErr) {
  const t = $("toast");
  t.replaceChildren(el("span", "t", text));
  t.className = "toast" + (isErr ? " err" : "");
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), isErr ? 8000 : 3500);
}
function showState(text, isErr) { const s = $("pagestate"); s.hidden = !text; s.className = "state" + (isErr ? " err" : ""); s.textContent = text || ""; }
function setMsg(id, text, ok) { const m = $(id); m.textContent = text || ""; m.className = "msg" + (text ? (ok ? " ok" : " err") : ""); }
const errText = (err) => err.code === "network" ? "Can't reach the AION server. Try again." : err.message;

// Developer choices: the team's developers plus any already given to a user.
function devOptions(select, current) {
  const names = new Set(devs);
  users.forEach((u) => u.dev && names.add(u.dev));
  if (current) names.add(current);
  select.replaceChildren(new Option("Choose a developer…", ""));
  [...names].sort().forEach((d) => select.appendChild(new Option("ai1_" + d, d)));
  select.appendChild(new Option("Other…", OTHER));
  select.value = current || "";
}

// ---- Add a user ----
let addRole = "user";
function setAddRole(role) {
  addRole = role;
  document.querySelectorAll("#a-role button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.role === role)));
  $("a-devwrap").querySelector("span").textContent = role === "user" ? "Developer (sees only ai1_… tickets)" : "Developer name (optional)";
}
document.querySelectorAll("#a-role button").forEach((b) => b.addEventListener("click", () => setAddRole(b.dataset.role)));
$("a-dev").addEventListener("change", () => { $("a-otherwrap").hidden = $("a-dev").value !== OTHER; if (!$("a-otherwrap").hidden) $("a-other").focus(); });

$("add-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const name = $("a-name").value.trim(), email = $("a-email").value.trim();
  const dev = $("a-dev").value === OTHER ? $("a-other").value.trim() : $("a-dev").value;
  if (!name) return setMsg("a-msg", "Enter their name.", false);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return setMsg("a-msg", "Enter their work email.", false);
  if (addRole === "user" && !dev) return setMsg("a-msg", "Choose the developer whose tickets they see.", false);
  const btn = $("a-save");
  btn.disabled = true; setMsg("a-msg", "Adding…", true); $("a-link").hidden = true;
  try {
    const r = await api("/users", { method: "POST", body: { name, email, role: addRole, dev } });
    $("add-form").reset(); setAddRole("user"); $("a-otherwrap").hidden = true;
    setMsg("a-msg", r.invited ? "Added. " + r.user.name + " has been emailed a link to choose a password." : "Added.", true);
    if (!r.invited && r.link) { $("a-linkval").value = r.link; $("a-link").hidden = false; }
    await load();
  } catch (err) {
    setMsg("a-msg", errText(err), false);
  } finally {
    btn.disabled = false;
  }
});
$("a-copy").addEventListener("click", async () => {
  try { await navigator.clipboard.writeText($("a-linkval").value); toast("Link copied."); }
  catch { $("a-linkval").select(); toast("Press Ctrl+C to copy the link."); }
});

// ---- The list ----
function row(u) {
  const r = el("div", "urow");
  const who = el("div", "uwho");
  who.appendChild(el("span", "av " + (u.role === "admin" ? "k1" : devK(u.dev)), initials(u.name)));
  const nm = el("div"); nm.appendChild(el("b", null, u.name + (u.email === me.email ? " (you)" : ""))); nm.appendChild(el("small", null, u.email)); who.appendChild(nm);
  r.appendChild(who);

  const view = el("div", "uview");
  view.appendChild(el("span", "flag " + (u.role === "admin" ? "k1" : "k6"), u.role === "admin" ? "Administrator" : "User"));
  if (u.dev) view.appendChild(el("span", "dev " + devK(u.dev), "ai1_" + u.dev));
  view.appendChild(el("span", "ustatus" + (u.hasPassword ? "" : " pending"), u.hasPassword ? "Active" : "Invited, no password yet"));
  r.appendChild(view);

  const acts = el("div", "uacts");
  const edit = el("button", "btn", "Edit"); edit.type = "button";
  edit.addEventListener("click", () => r.replaceWith(editRow(u)));
  const link = el("button", "btn", u.hasPassword ? "Send password reset" : "Resend invitation"); link.type = "button";
  link.addEventListener("click", async () => {
    link.disabled = true;
    try {
      const res = await api("/users/" + encodeURIComponent(u.email) + "/invite", { method: "POST" });
      if (res.invited) toast("Emailed " + u.email + " a link to choose a password.");
      else if (res.link) { $("a-linkval").value = res.link; $("a-link").hidden = false; $("add").scrollIntoView({ behavior: "smooth" }); toast("Email isn't set up: copy the link at the top and send it to them."); }
    } catch (err) { toast(errText(err), true); }
    link.disabled = false;
  });
  acts.appendChild(edit); acts.appendChild(link);
  if (u.email !== me.email) {
    const del = el("button", "btn danger", "Remove"); del.type = "button";
    del.addEventListener("click", async () => {
      if (!confirm("Remove " + u.name + " (" + u.email + ")? They're signed out right away and can't sign in again.")) return;
      try { await api("/users/" + encodeURIComponent(u.email), { method: "DELETE" }); toast(u.name + " removed."); await load(); }
      catch (err) { toast(errText(err), true); }
    });
    acts.appendChild(del);
  }
  r.appendChild(acts);
  return r;
}

function editRow(u) {
  const r = el("div", "urow editing");
  const who = el("div", "uwho");
  const name = el("input", "inp"); name.value = u.name; name.setAttribute("aria-label", "Name");
  const nm = el("div"); nm.appendChild(name); nm.appendChild(el("small", null, u.email)); who.appendChild(nm);
  r.appendChild(who);

  const view = el("div", "uview");
  const role = el("select", "fsel auto"); role.setAttribute("aria-label", "Role");
  role.appendChild(new Option("User", "user")); role.appendChild(new Option("Administrator", "admin")); role.value = u.role;
  if (u.email === me.email) role.disabled = true;
  const dev = el("select", "fsel auto"); dev.setAttribute("aria-label", "Developer"); devOptions(dev, u.dev);
  const other = el("input", "inp"); other.placeholder = "Other developer name"; other.hidden = true;
  dev.addEventListener("change", () => { other.hidden = dev.value !== OTHER; if (!other.hidden) other.focus(); });
  view.appendChild(role); view.appendChild(dev); view.appendChild(other);
  r.appendChild(view);

  const acts = el("div", "uacts");
  const msg = el("span", "msg");
  const save = el("button", "btn primary", "Save"); save.type = "button";
  save.addEventListener("click", async () => {
    const d = dev.value === OTHER ? other.value.trim() : dev.value;
    if (role.value === "user" && !d) { msg.textContent = "Choose a developer."; msg.className = "msg err"; return; }
    save.disabled = true;
    try { await api("/users/" + encodeURIComponent(u.email), { method: "PUT", body: { name: name.value.trim(), role: role.value, dev: d } }); toast("Saved. It applies right away."); await load(); }
    catch (err) { msg.textContent = errText(err); msg.className = "msg err"; save.disabled = false; }
  });
  const cancel = el("button", "btn", "Cancel"); cancel.type = "button";
  cancel.addEventListener("click", () => r.replaceWith(row(u)));
  acts.appendChild(save); acts.appendChild(cancel); acts.appendChild(msg);
  r.appendChild(acts);
  return r;
}

async function load() {
  const r = await api("/users");
  users = r.users;
  $("count").textContent = users.length + (users.length === 1 ? " person" : " people");
  $("rows").replaceChildren(...users.map(row));
  devOptions($("a-dev"), $("a-dev").value === OTHER ? "" : $("a-dev").value);
}

$("signout").addEventListener("click", () => signOut());

async function start() {
  const s = getSession();
  if (!s) return signOut();
  $("me").textContent = s.email;
  try {
    const cfg = await api("/config");
    if (cfg.role !== "admin") { location.replace("dashboard.html"); return; }
    if (!cfg.accounts) { showState("User accounts aren't switched on yet: the proxy needs its database (see SETUP.md, \"User accounts\"). Until then, Youssef and Ellen sign in with the team password.", true); return; }
    me = { email: cfg.email, name: cfg.name };
    devs = cfg.devs || []; devColors = cfg.devColors || {};
    await load();
    showState("");
    $("add").hidden = false; $("list").hidden = false;
  } catch (err) {
    showState(errText(err), true);
  }
}
start();
