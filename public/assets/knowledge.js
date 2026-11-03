// Odoo knowledge base, behind an extra password that administrators set. The proxy checks the password on every
// action and reads or writes the entries in Odoo. The password and the entries live in memory for this page view
// only, never in browser storage.
import { api, getSession, signOut } from "./session.js";

const $ = (id) => document.getElementById(id);
const errText = (err) => (err && err.code === "network" ? "Can't reach the AION server. Try again." : (err && err.message) || "Something went wrong.");
const show = (id, on) => { $(id).hidden = !on; };
const note = (id, text, isErr) => { const n = $(id); n.textContent = text || ""; n.classList.toggle("err", !!isErr); };
const MAX_TEXT = 20000;

let password = "";
let entries = [];

function fmtDate(v) { if (!v) return ""; const d = new Date(v); return isNaN(d) ? "" : d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" }); }
const matches = (entry, query) => !query || (entry.name || "").toLowerCase().includes(query) || (entry.text || "").toLowerCase().includes(query);

function button(label, onClick) {
  const b = document.createElement("button");
  b.className = "btn";
  b.type = "button";
  b.textContent = label;
  b.addEventListener("click", onClick);
  return b;
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    note("kb-note", "Copied to the clipboard.");
  } catch {
    note("kb-note", "Copy did not work. Select the text and copy it by hand.", true);
  }
}

function renderEntries() {
  const query = $("kb-search").value.trim().toLowerCase();
  const shown = entries.filter((entry) => matches(entry, query));
  const list = $("entries");
  list.replaceChildren(...shown.map((entry) => {
    const li = document.createElement("li");
    li.className = "kb-item";
    const details = document.createElement("details");
    const summary = document.createElement("summary");
    const name = document.createElement("span");
    name.className = "kb-name";
    name.textContent = entry.name || "(no name)";
    const date = document.createElement("span");
    date.className = "kb-date";
    date.textContent = fmtDate(entry.updatedAt) ? "Updated " + fmtDate(entry.updatedAt) : "";
    summary.append(name, date);
    const body = document.createElement("div");
    body.className = "kb-body";
    const text = document.createElement("pre");
    text.className = "kb-text";
    text.textContent = entry.text || "";
    const actions = document.createElement("div");
    actions.className = "kb-actions";
    actions.append(button("Copy details", () => copyText(entry.text || "")), button("Edit", () => openEditor(entry)));
    body.append(text, actions);
    details.append(summary, body);
    li.append(details);
    return li;
  }));
  $("kb-count").textContent = entries.length ? (shown.length === entries.length ? `${entries.length} entries` : `${shown.length} of ${entries.length} entries`) : "";
  show("entries-empty", shown.length === 0);
  $("entries-empty").textContent = entries.length === 0 ? "No entries yet. Add the first one." : "No entries match your search.";
}

function updateCount() {
  const n = $("edit-text").value.length;
  $("edit-count").textContent = `${n.toLocaleString("en-GB")} / ${MAX_TEXT.toLocaleString("en-GB")}`;
}

function openEditor(entry) {
  $("edit-id").value = entry ? String(entry.id) : "";
  $("edit-name").value = entry ? entry.name : "";
  $("edit-text").value = entry ? entry.text : "";
  $("edit-title").textContent = entry ? "Edit entry" : "Add entry";
  note("edit-msg", "");
  updateCount();
  show("edit-block", true);
  $("edit-block").scrollIntoView({ block: "start", behavior: "smooth" });
  $("edit-name").focus();
}

function closeEditor() { show("edit-block", false); }

function showEntries(list) {
  entries = list || [];
  show("state", false);
  show("unlock-block", false);
  show("entries-block", true);
  renderEntries();
}

function lock() {
  password = "";
  entries = [];
  $("entries").replaceChildren();
  $("kb-search").value = "";
  $("kb-note").textContent = "";
  closeEditor();
  show("entries-block", false);
  show("unlock-block", true);
  note("unlock-msg", "Locked. Enter the password to open it again.");
  $("unlock-password").focus();
}

$("unlock-toggle").addEventListener("click", () => {
  const input = $("unlock-password");
  const showing = input.type === "text";
  input.type = showing ? "password" : "text";
  $("unlock-toggle").textContent = showing ? "Show" : "Hide";
  $("unlock-toggle").setAttribute("aria-pressed", String(!showing));
});

$("unlock-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const typed = $("unlock-password").value;
  $("unlock-submit").disabled = true; note("unlock-msg", "Checking…");
  try {
    const { url, articles } = await api("/knowledge/unlock", { method: "POST", body: { password: typed } });
    password = typed;
    $("unlock-password").value = "";
    $("unlock-password").type = "password";
    $("unlock-toggle").textContent = "Show";
    $("unlock-toggle").setAttribute("aria-pressed", "false");
    note("unlock-msg", "");
    $("kb-open").href = url;
    showEntries(articles);
  } catch (err) {
    if (err && err.code === "session") { signOut(true); return; }
    note("unlock-msg", errText(err), true);
  } finally { $("unlock-submit").disabled = false; }
});

$("kb-search").addEventListener("input", renderEntries);
$("kb-new").addEventListener("click", () => openEditor(null));
$("kb-lock").addEventListener("click", lock);
$("edit-cancel").addEventListener("click", closeEditor);
$("edit-text").addEventListener("input", updateCount);
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !$("edit-block").hidden) closeEditor(); });

$("edit-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const body = { password, id: Number($("edit-id").value) || null, name: $("edit-name").value.trim(), text: $("edit-text").value };
  $("edit-submit").disabled = true; note("edit-msg", "Saving…");
  try {
    const { articles } = await api("/knowledge/save", { method: "POST", body });
    closeEditor();
    showEntries(articles);
    note("kb-note", body.id ? "Entry saved." : "Entry added.");
  } catch (err) {
    if (err && err.code === "session") { signOut(true); return; }
    note("edit-msg", errText(err), true);
  } finally { $("edit-submit").disabled = false; }
});

async function load() {
  const status = await api("/knowledge/status");
  show("state", false);
  if (!status.odoo) { show("state", true); $("state").textContent = "Odoo is not connected, so the knowledge base is not available."; return; }
  if (status.configured) show("unlock-block", true);
  else { show("state", true); $("state").textContent = "No knowledge password has been set yet. An administrator sets it on the Users page."; }
}

const s = getSession();
if (!s) signOut(true);
else {
  $("me").textContent = s.email;
  $("signout").addEventListener("click", () => signOut());
  load().catch((err) => {
    if (err && err.code === "session") { signOut(true); return; }
    show("state", true); $("state").textContent = errText(err); $("state").classList.add("err");
  });
}
