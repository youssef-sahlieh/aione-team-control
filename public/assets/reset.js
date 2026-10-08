// Choose a password from an emailed link (forgotten password or a new account's invitation).
// The link's one-time token is in the address after "#t=", so it never reaches GitHub's servers.
import { api } from "./session.js";

const $ = (id) => document.getElementById(id);
const token = new URLSearchParams(location.hash.slice(1)).get("t") || "";
// Take the token out of the address bar and history.
history.replaceState(null, "", location.pathname);

function showMsg(text, kind) {
  $("reset-msg").textContent = text;
  $("reset-msg").className = "msg " + kind;
  $("reset-msg").hidden = false;
}

function finish(title, lead) {
  $("title").textContent = title;
  $("lead").textContent = lead;
  $("reset-form").hidden = true;
  $("signin-link").hidden = false;
}

async function start() {
  if (!token) return finish("This link doesn't work", "Open the link from your email again, or ask for a new one with \"Forgot password?\" on the sign-in page.");
  let info;
  try {
    info = await api("/reset/check", { method: "POST", body: { token } });
  } catch (err) {
    return finish("This link doesn't work", err.code === "network" ? "Can't reach the AION server. Check your connection and open the link again."
      : "It has expired or was already used. Ask for a new one with \"Forgot password?\" on the sign-in page.");
  }
  $("title").textContent = info.purpose === "invite" ? "Welcome, " + info.name : "Choose a new password";
  $("lead").textContent = (info.purpose === "invite" ? "Choose a password for your account " : "For your account ") + info.email + ".";
  $("username").value = info.email;
  $("reset-form").hidden = false;
  $("password").focus();

  $("reset-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const pw = $("password").value;
    if (pw.length < 10) return showMsg("Use at least 10 characters.", "err");
    if (pw !== $("password2").value) return showMsg("The two passwords don't match.", "err");
    const btn = $("reset-btn");
    btn.disabled = true;
    btn.textContent = "Saving…";
    try {
      await api("/reset", { method: "POST", body: { token, password: pw } });
      finish("Password saved", "You can now sign in with " + info.email + " and your new password.");
    } catch (err) {
      btn.disabled = false;
      btn.textContent = "Save password";
      if (err.code === "bad_link") return finish("This link doesn't work", "It has expired or was already used. Ask for a new one with \"Forgot password?\" on the sign-in page.");
      showMsg(err.code === "network" ? "Can't reach the AION server. Try again." : err.message, "err");
    }
  });
}

start();
