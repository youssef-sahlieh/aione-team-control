// AIONE Team Control sign-in: the proxy checks the email and password and returns a session token.
// Also the "Forgot password?" form, which asks the proxy to email a reset link.
import { api, getSession, proxyReady, saveSession } from "./session.js";

const $ = (id) => document.getElementById(id);

function showMsg(id, text, kind) {
  $(id).textContent = text;
  $(id).className = "msg " + kind;
  $(id).hidden = false;
}

function showView(name) {
  $("view-signin").hidden = name !== "signin";
  $("view-mfa").hidden = name !== "mfa";
  $("view-forgot").hidden = name !== "forgot";
  (name === "forgot" ? $("forgot-email") : name === "mfa" ? $("mfa-code") : $("email")).focus();
}

if (getSession()) {
  location.replace("dashboard.html" + location.search + location.hash);
} else {
  let mfaChallenge = "";
  showView("signin");
  if (!proxyReady()) {
    $("signin-btn").disabled = true;
    showMsg("signin-msg", "This site isn't set up yet: the proxy address in assets/config.js is missing.", "err");
  }

  $("signin-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = $("signin-btn");
    btn.disabled = true;
    btn.textContent = "Signing in…";
    $("signin-msg").hidden = true;
    try {
      const s = await api("/login", { method: "POST", body: { email: $("email").value, password: $("password").value } });
      if (s.mfaRequired && s.challenge) {
        mfaChallenge = s.challenge;
        $("mfa-code").value = "";
        $("mfa-msg").hidden = true;
        btn.disabled = false;
        btn.textContent = "Sign in";
        showView("mfa");
        return;
      }
      saveSession(s);
      location.replace("dashboard.html" + location.search + location.hash);
    } catch (err) {
      btn.disabled = false;
      btn.textContent = "Sign in";
      showMsg("signin-msg", err.code === "login" ? "That email and password don't match. Check them and try again."
        : err.code === "rate_limited" ? "Too many tries. Wait a few minutes and try again."
        : err.code === "network" ? "Can't reach the AIONE server. Check your connection and try again."
        : "Sign-in didn't work (" + err.message + "). Try again, or ask Youssef.", "err");
      $("password").select();
    }
  });

  $("mfa-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = $("mfa-btn");
    btn.disabled = true;
    btn.textContent = "Verifying…";
    $("mfa-msg").hidden = true;
    try {
      const session = await api("/mfa/challenge", {
        method: "POST",
        body: { challenge: mfaChallenge, code: $("mfa-code").value },
      });
      saveSession(session);
      mfaChallenge = "";
      location.replace("dashboard.html" + location.search + location.hash);
    } catch (err) {
      btn.disabled = false;
      btn.textContent = "Verify";
      showMsg("mfa-msg", err.code === "mfa_invalid" ? "That code is invalid or already used. Try the current code."
        : err.code === "rate_limited" ? "Too many tries. Wait a few minutes and try again."
        : err.code === "network" ? "Can't reach the AIONE server. Check your connection and try again."
        : err.message, "err");
      $("mfa-code").select();
    }
  });
  $("mfa-back").addEventListener("click", () => {
    mfaChallenge = "";
    $("password").value = "";
    showView("signin");
  });

  $("forgot-link").addEventListener("click", () => {
    $("forgot-email").value = $("email").value;
    $("forgot-msg").hidden = true;
    showView("forgot");
  });
  $("back-link").addEventListener("click", () => showView("signin"));

  $("forgot-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = $("forgot-btn");
    const email = $("forgot-email").value.trim();
    if (!email) { showMsg("forgot-msg", "Enter your work email.", "err"); return; }
    btn.disabled = true;
    btn.textContent = "Sending…";
    try {
      await api("/forgot", { method: "POST", body: { email } });
      showMsg("forgot-msg", "If " + email + " has an account, a reset link is on its way. It works for 1 hour. Check your Junk folder if it doesn't arrive.", "ok");
      btn.textContent = "Send again";
    } catch (err) {
      showMsg("forgot-msg", err.code === "rate_limited" ? "Too many reset requests. Wait a while and try again."
        : err.code === "network" ? "Can't reach the AIONE server. Check your connection and try again."
        : err.message, "err");
      btn.textContent = "Send reset link";
    } finally {
      btn.disabled = false;
    }
  });
}
