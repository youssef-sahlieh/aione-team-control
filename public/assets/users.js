// Users page (administrators only): invite people, choose Administrator or User, pick whose tickets a User sees,
// set the GitHub username used for review requests, send password links and remove accounts. Everything is checked again by the proxy.
import { api, getSession, signOut } from "./session.js";

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const initials = (n) => String(n || "?").split(/\s+/).filter(Boolean).slice(0, 2).map((x) => x[0].toUpperCase()).join("") || "?";
const OTHER = "__other";

let me = null, devs = [], devColors = {}, users = [];
let editing = null; // the person being managed; null while inviting someone new
let role = "user";
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
const isPending = (u) => !u.hasPassword;

// What a person can see, in one plain sentence.
function seesText(u) {
  if (u.role === "admin") return "Administrator: sees and changes every ticket";
  return u.dev ? "User: sees the tickets for " + u.dev : "User: no developer chosen yet";
}
function lastText(u) {
  if (!u.lastLoginAt) return "Has not signed in yet";
  return "Last sign-in " + new Date(u.lastLoginAt).toLocaleString("en-GB", { timeZone: "Asia/Jerusalem", day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

// Developer choices: the team's developers plus any already given to a user. Shown without the ai1_ prefix.
function devOptions(select, current) {
  const names = new Set(devs);
  users.forEach((u) => u.dev && names.add(u.dev));
  if (current) names.add(current);
  select.replaceChildren(new Option("Choose a person…", ""));
  [...names].sort().forEach((d) => select.appendChild(new Option(d, d)));
  select.appendChild(new Option("Other…", OTHER));
  select.value = current || "";
}

// ---- Invite or manage one person (one dialog for both) ----
const dialog = $("person");
function setRole(next) {
  role = next;
  document.querySelectorAll("#p-role button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.role === next)));
  $("p-devlabel").textContent = next === "user" ? "Sees the tickets for" : "Sees the tickets for (optional)";
}
function openDialog(u) {
  editing = u || null;
  setMsg("p-msg", "");
  $("p-link").hidden = true;
  $("person-form").reset();
  $("p-title").textContent = u ? "Manage " + u.name : "Invite someone";
  $("p-email").readOnly = !!u;
  $("p-manage").hidden = !u;
  $("p-save").textContent = u ? "Save changes" : "Send invitation";
  $("p-otherwrap").hidden = true;
  // The GitHub username is set when managing someone; it is not asked for when inviting.
  $("p-githubwrap").hidden = !u;
  $("p-github").value = u ? u.githubLogin || "" : "";
  setRole(u ? u.role : "user");
  $("p-name").value = u ? u.name : "";
  $("p-email").value = u ? u.email : "";
  devOptions($("p-dev"), u ? u.dev : "");
  if (u) {
    $("p-info").textContent = lastText(u) + (u.lastLoginIp ? " · from IP " + u.lastLoginIp : "") + (isPending(u) ? ". The invitation is still waiting to be used." : ".");
    $("p-reset").textContent = u.hasPassword ? "Send password reset" : "Resend invitation";
    $("p-remove").hidden = u.email === me.email;
    $("p-role").querySelector('[data-role="admin"]').disabled = u.email === me.email;
  } else {
    $("p-role").querySelector('[data-role="admin"]').disabled = false;
  }
  dialog.showModal();
  $("p-name").focus();
}
document.querySelectorAll("#p-role button").forEach((b) => b.addEventListener("click", () => setRole(b.dataset.role)));
$("p-dev").addEventListener("change", () => { $("p-otherwrap").hidden = $("p-dev").value !== OTHER; if (!$("p-otherwrap").hidden) $("p-other").focus(); });
$("p-cancel").addEventListener("click", () => dialog.close());
$("invite").addEventListener("click", () => openDialog(null));
$("p-copy").addEventListener("click", async () => {
  try { await navigator.clipboard.writeText($("p-linkval").value); toast("Link copied."); }
  catch { $("p-linkval").select(); toast("Press Ctrl+C to copy the link."); }
});
// Email isn't set up: the server returns a one-time link to send by hand.
function showLink(link) {
  $("p-linkval").value = link;
  $("p-link").hidden = false;
}

$("person-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const name = $("p-name").value.trim(), email = $("p-email").value.trim();
  const dev = $("p-dev").value === OTHER ? $("p-other").value.trim() : $("p-dev").value;
  if (!name) return setMsg("p-msg", "Enter their name.", false);
  if (!editing && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return setMsg("p-msg", "Enter their work email.", false);
  if (role === "user" && !dev) return setMsg("p-msg", "Choose the person whose tickets they see.", false);
  const btn = $("p-save");
  btn.disabled = true; setMsg("p-msg", editing ? "Saving…" : "Sending…", true);
  try {
    if (editing) {
      await api("/users/" + encodeURIComponent(editing.email), { method: "PUT", body: { name, role, dev, githubLogin: $("p-github").value.trim() } });
      dialog.close();
      toast("Saved. It applies right away.");
    } else {
      const r = await api("/users", { method: "POST", body: { name, email, role, dev } });
      if (r.invited) {
        dialog.close();
        toast(r.user.name + " has been emailed a link to choose a password.");
      } else {
        // Added, but email isn't set up: the dialog switches to managing them, with the link to send by hand.
        editing = r.user;
        $("p-title").textContent = "Manage " + r.user.name;
        $("p-email").readOnly = true;
        $("p-manage").hidden = false;
        $("p-info").textContent = "Invitation not used yet.";
        $("p-reset").textContent = "Resend invitation";
        $("p-remove").hidden = false;
        $("p-save").textContent = "Save changes";
        setMsg("p-msg", "Added. Send them this link yourself:", true);
        if (r.link) showLink(r.link);
      }
    }
    await load();
  } catch (err) {
    setMsg("p-msg", errText(err), false);
  } finally {
    btn.disabled = false;
  }
});

$("p-reset").addEventListener("click", async () => {
  if (!editing) return;
  const b = $("p-reset");
  b.disabled = true;
  try {
    const res = await api("/users/" + encodeURIComponent(editing.email) + "/invite", { method: "POST" });
    if (res.invited) toast("Emailed " + editing.email + " a link to choose a password.");
    else if (res.link) { showLink(res.link); setMsg("p-msg", "Email isn't set up: send them this link yourself.", true); }
  } catch (err) { setMsg("p-msg", errText(err), false); }
  b.disabled = false;
});

$("p-remove").addEventListener("click", async () => {
  if (!editing) return;
  if (!confirm("Remove " + editing.name + " (" + editing.email + ")? They're signed out right away and can't sign in again.")) return;
  try {
    await api("/users/" + encodeURIComponent(editing.email), { method: "DELETE" });
    dialog.close();
    toast(editing.name + " removed.");
    await load();
  } catch (err) { setMsg("p-msg", errText(err), false); }
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
  view.appendChild(el("span", "useesc", seesText(u)));
  view.appendChild(el("span", "ustatus" + (isPending(u) ? " pending" : ""), isPending(u) ? "Invitation not used yet" : lastText(u)));
  r.appendChild(view);

  const acts = el("div", "uacts");
  const manage = el("button", "btn", "Manage"); manage.type = "button";
  manage.setAttribute("aria-label", "Manage " + u.name);
  manage.addEventListener("click", () => openDialog(u));
  acts.appendChild(manage);
  r.appendChild(acts);
  return r;
}

// The search box and the filter narrow the list; the count shows how many match.
function visible() {
  const q = $("search").value.trim().toLowerCase(), f = $("filter").value;
  return users.filter((u) => {
    if (f === "admin" && u.role !== "admin") return false;
    if (f === "user" && u.role !== "user") return false;
    if (f === "pending" && !isPending(u)) return false;
    return !q || (u.name + " " + u.email + " " + (u.dev || "")).toLowerCase().includes(q);
  });
}
// Totals for everyone, whatever the search or filter shows.
function renderStats() {
  const admins = users.filter((u) => u.role === "admin").length;
  const stat = (value, label) => { const s = el("div", "ustat"); s.append(el("strong", null, String(value)), el("span", null, label)); return s; };
  $("stats").replaceChildren(
    stat(users.length - admins, "Users"),
    stat(admins, "Administrators"),
    stat(users.filter(isPending).length, "Invitations not used yet"),
  );
}
function render() {
  const shown = visible();
  renderStats();
  $("rows").replaceChildren(...shown.map(row));
  $("count").textContent = shown.length === users.length ? users.length + (users.length === 1 ? " person" : " people") : shown.length + " of " + users.length;
  $("empty").hidden = shown.length > 0;
}
$("search").addEventListener("input", render);
$("filter").addEventListener("change", render);

async function load() {
  const r = await api("/users");
  users = r.users;
  render();
}

$("signout").addEventListener("click", () => signOut());

// Knowledge base password: set and changed here by administrators. The proxy checks the administrator again.
const fmtDate = (v) => { const d = new Date(v); return v && !isNaN(d) ? d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" }) : ""; };
async function loadKnowledgePassword() {
  const status = await api("/knowledge/status");
  $("kb-pass").hidden = false;
  $("kb-help").textContent = !status.odoo
    ? "Odoo is not connected, so the knowledge base is not available."
    : status.configured
      ? "A password is set (last changed " + fmtDate(status.updatedAt) + "). Changing it means everyone who opens the knowledge base needs the new password."
      : "No password is set yet. Set one so people can open the knowledge base.";
  $("kb-submit").textContent = status.configured ? "Change password" : "Set password";
  $("kb-password").disabled = $("kb-submit").disabled = !status.odoo;
}

$("kb-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const password = $("kb-password").value;
  $("kb-submit").disabled = true; setMsg("kb-msg", "Saving…", true);
  try {
    await api("/knowledge/password", { method: "POST", body: { password } });
    $("kb-password").value = "";
    toast("Knowledge base password saved. Tell the people who need it.");
    setMsg("kb-msg", "");
    await loadKnowledgePassword();
  } catch (err) {
    if (err.code === "session") { signOut(); return; }
    setMsg("kb-msg", errText(err), false);
  } finally { $("kb-submit").disabled = false; }
});

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
    $("list").hidden = false;
    loadKnowledgePassword().catch((err) => { $("kb-pass").hidden = false; $("kb-help").textContent = errText(err); });
  } catch (err) {
    showState(errText(err), true);
  }
}
start();
