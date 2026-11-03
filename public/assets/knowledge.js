// Odoo knowledge base, behind an extra password that administrators set. The proxy checks the password on every
// action and reads or writes the entries in Odoo. The password and the entries live in memory for this page view
// only, never in browser storage.
import { api, getSession, signOut } from "./session.js";

const $ = (id) => document.getElementById(id);
const errText = (err) => (err && err.code === "network" ? "Can't reach the AION server. Try again." : (err && err.message) || "Something went wrong.");
const show = (id, on) => { $(id).hidden = !on; };
const note = (id, text, isErr) => { const n = $(id); n.textContent = text || ""; n.classList.toggle("err", !!isErr); };

let password = "";
let entries = [];

function fmtDate(v) { if (!v) return ""; const d = new Date(v); return isNaN(d) ? "" : d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" }); }

function renderEntries() {
  const list = $("entries");
  list.replaceChildren(...entries.map((entry) => {
    const li = document.createElement("li");
    li.className = "kb-item";
    const title = document.createElement("strong");
    title.textContent = entry.name || "(no name)";
    const meta = document.createElement("span");
    meta.className = "msg";
    meta.textContent = fmtDate(entry.updatedAt) ? "Updated " + fmtDate(entry.updatedAt) : "";
    const edit = document.createElement("button");
    edit.className = "btn";
    edit.type = "button";
    edit.textContent = "Edit";
    edit.addEventListener("click", () => openEditor(entry));
    const text = document.createElement("pre");
    text.className = "kb-text";
    text.textContent = entry.text || "";
    li.append(title, " ", meta, " ", edit, text);
    return li;
  }));
  show("entries-empty", entries.length === 0);
}

function openEditor(entry) {
  $("edit-id").value = entry ? String(entry.id) : "";
  $("edit-name").value = entry ? entry.name : "";
  $("edit-text").value = entry ? entry.text : "";
  $("edit-title").textContent = entry ? "Edit entry" : "Add entry";
  note("edit-msg", "");
  show("edit-block", true);
  $("edit-name").focus();
}

function showEntries(list) {
  entries = list || [];
  show("state", false);
  show("unlock-block", false);
  show("entries-block", true);
  renderEntries();
}

$("unlock-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const typed = $("unlock-password").value;
  $("unlock-submit").disabled = true; note("unlock-msg", "Checking…");
  try {
    const { url, articles } = await api("/knowledge/unlock", { method: "POST", body: { password: typed } });
    password = typed;
    $("unlock-password").value = "";
    $("kb-open").href = url;
    showEntries(articles);
  } catch (err) {
    if (err && err.code === "session") { signOut(true); return; }
    note("unlock-msg", errText(err), true);
  } finally { $("unlock-submit").disabled = false; }
});

$("kb-new").addEventListener("click", () => openEditor(null));
$("edit-cancel").addEventListener("click", () => show("edit-block", false));

$("edit-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const body = { password, id: Number($("edit-id").value) || null, name: $("edit-name").value.trim(), text: $("edit-text").value };
  $("edit-submit").disabled = true; note("edit-msg", "Saving…");
  try {
    const { articles } = await api("/knowledge/save", { method: "POST", body });
    show("edit-block", false);
    showEntries(articles);
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
