// AION Team Control sign-in: the proxy checks the email and password and returns a session token.
import { api, getSession, proxyReady, saveSession } from "./session.js";

const $ = (id) => document.getElementById(id);

function showError(msg) {
  $("signin-msg").textContent = msg;
  $("signin-msg").hidden = false;
}

if (getSession()) {
  location.replace("dashboard.html");
} else {
  $("view-signin").hidden = false;
  if (!proxyReady()) {
    $("signin-btn").disabled = true;
    showError("This site isn't set up yet: the proxy address in assets/config.js is missing.");
  }
  $("signin-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = $("signin-btn");
    btn.disabled = true;
    btn.textContent = "Signing in…";
    $("signin-msg").hidden = true;
    try {
      const s = await api("/login", { method: "POST", body: { email: $("email").value, password: $("password").value } });
      saveSession(s);
      location.replace("dashboard.html");
    } catch (err) {
      btn.disabled = false;
      btn.textContent = "Sign in";
      showError(err.code === "login" ? "That email and password don't match. Check them and try again."
        : err.code === "rate_limited" ? "Too many tries. Wait a minute and try again."
        : err.code === "network" ? "Can't reach the AION server. Check your connection and try again."
        : "Sign-in didn't work (" + err.message + "). Try again, or ask Youssef.");
      $("password").select();
    }
  });
}
