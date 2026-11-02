// Odoo knowledge base, locked with a password that administrators set. The proxy checks the password and returns
// the Odoo link only when it is right. Nothing here is saved in the browser: the link and the password live in memory
// for this page view only.
import { api, getSession, signOut } from "./session.js";

const $ = (id) => document.getElementById(id);
const errText = (err) => (err && err.code === "network" ? "Can't reach the AION server. Try again." : (err && err.message) || "Something went wrong.");
const show = (id, on) => { $(id).hidden = !on; };
const note = (id, text, isErr) => { const n = $(id); n.textContent = text || ""; n.classList.toggle("err", !!isErr); };

function fmtDate(v) { if (!v) return ""; const d = new Date(v); return isNaN(d) ? "" : d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" }); }

async function load() {
  const status = await api("/knowledge/status");
  show("state", false);
  if (!status.odoo) { show("state", true); $("state").textContent = "Odoo is not connected, so the knowledge base is not available."; return; }
  if (status.canSetPassword) {
    show("set-block", true);
    $("set-help").textContent = status.configured
      ? "A password is set (last changed " + fmtDate(status.updatedAt) + "). Changing it means everyone needs the new password."
      : "No password is set yet. Set one so people can open the knowledge base.";
  }
  if (status.configured) show("unlock-block", true);
  else if (!status.canSetPassword) { show("state", true); $("state").textContent = "No password has been set yet. Ask an administrator to set it."; }
}

$("unlock-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const password = $("unlock-password").value;
  $("unlock-submit").disabled = true; note("unlock-msg", "Checking…");
  try {
    const { url } = await api("/knowledge/unlock", { method: "POST", body: { password } });
    $("kb-open").href = url; show("kb-open-wrap", true); note("unlock-msg", "Unlocked for this page view.");
    $("unlock-password").value = "";
  } catch (err) {
    if (err && err.code === "session") { signOut(true); return; }
    note("unlock-msg", errText(err), true);
  } finally { $("unlock-submit").disabled = false; }
});

$("set-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const password = $("set-password").value;
  $("set-submit").disabled = true; note("set-msg", "Saving…");
  try {
    await api("/knowledge/password", { method: "POST", body: { password } });
    $("set-password").value = "";
    note("set-msg", "Saved. Tell the people who need it to use the new password.");
    await load();
  } catch (err) {
    if (err && err.code === "session") { signOut(true); return; }
    note("set-msg", errText(err), true);
  } finally { $("set-submit").disabled = false; }
});

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
