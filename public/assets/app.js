// AION Team Control - email and password sign-in that unlocks the encrypted app content.
import { fromB64, normalizeEmail, openContent, toB64, unlockKey } from "./lock.js";

const SESSION = "aione-session";
const $ = (id) => document.getElementById(id);

function readSession() {
  try { return JSON.parse(sessionStorage.getItem(SESSION) || "null"); } catch { return null; }
}
function writeSession(value) {
  try { value ? sessionStorage.setItem(SESSION, JSON.stringify(value)) : sessionStorage.removeItem(SESSION); } catch {}
}

function showApp(html, email) {
  $("view-app").innerHTML = html;
  $("me").textContent = email;
  $("signout-btn").addEventListener("click", () => { writeSession(null); location.reload(); });
  $("view-signin").hidden = true;
  $("view-app").hidden = false;
}

function showError(msg) {
  $("signin-msg").textContent = msg;
  $("signin-msg").hidden = false;
}

async function start() {
  const res = await fetch("assets/locked.json", { cache: "no-store" });
  if (!res.ok) throw new Error("locked.json " + res.status);
  const locked = await res.json();

  // Stay signed in for this browser tab.
  const saved = readSession();
  if (saved) {
    const html = await openContent(locked, fromB64(saved.key));
    if (html) return showApp(html, saved.email);
    writeSession(null);
  }

  $("view-signin").hidden = false;
  $("signin-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const email = normalizeEmail($("email").value);
    const btn = $("signin-btn");
    btn.disabled = true;
    btn.textContent = "Checking…";
    $("signin-msg").hidden = true;
    const key = await unlockKey(locked, email, $("password").value);
    const html = key && await openContent(locked, key);
    if (html) {
      writeSession({ email, key: toB64(key) });
      $("password").value = "";
      return showApp(html, email);
    }
    btn.disabled = false;
    btn.textContent = "Sign in";
    showError("That email and password don't match. Check them and try again.");
    $("password").select();
  });
}

start().catch((err) => {
  console.error(err);
  $("view-signin").hidden = false;
  $("signin-btn").disabled = true;
  showError("The app couldn't load. Refresh the page, or ask Youssef.");
});
