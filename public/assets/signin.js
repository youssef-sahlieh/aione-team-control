// AION Team Control sign-in: the proxy checks the email and password and returns a session token.
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
  $("view-forgot").hidden = name !== "forgot";
  (name === "forgot" ? $("forgot-email") : $("email")).focus();
}

// Back from Microsoft: the proxy's one-time code (#ms=...) becomes this browser's session, or it says why not (#ms_error=...).
const msParams = new URLSearchParams(location.hash.slice(1));
const msErrors = {
  cancelled: "Microsoft sign-in was cancelled.",
  no_account: "Your Microsoft account doesn't have an AION dashboard account yet. Ask an administrator to add you.",
  tenant: "That Microsoft account isn't in the AION directory.",
  state: "That Microsoft sign-in expired. Try again.",
  token: "Microsoft's sign-in couldn't be checked. Try again.",
  server: "Sign-in with Microsoft didn't work. Try again, or sign in with your password."
};
if (msParams.has("ms") || msParams.has("ms_error")) history.replaceState(null, "", location.pathname + location.search);

async function finishMicrosoft(code) {
  showMsg("signin-msg", "Signing you in…", "ok");
  try {
    saveSession(await api("/auth/microsoft/exchange", { method: "POST", body: { code } }));
    location.replace("dashboard.html" + location.search);
  } catch (err) {
    showMsg("signin-msg", err.code === "bad_link" ? msErrors.state : err.code === "network" ? "Can't reach the AION server. Check your connection and try again." : msErrors.server, "err");
  }
}

if (getSession()) {
  location.replace("dashboard.html" + location.search + location.hash);
} else {
  showView("signin");
  if (!proxyReady()) {
    $("signin-btn").disabled = true;
    $("ms-btn").disabled = true;
    showMsg("signin-msg", "This site isn't set up yet: the proxy address in assets/config.js is missing.", "err");
  }
  $("ms-btn").addEventListener("click", () => {
    location.href = window.AIONE_API + "/auth/microsoft/start?return=" + encodeURIComponent(location.origin + location.pathname);
  });
  if (msParams.has("ms_error")) showMsg("signin-msg", msErrors[msParams.get("ms_error")] || msErrors.server, "err");
  if (msParams.has("ms")) finishMicrosoft(msParams.get("ms"));

  $("signin-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = $("signin-btn");
    btn.disabled = true;
    btn.textContent = "Signing in…";
    $("signin-msg").hidden = true;
    try {
      const s = await api("/login", { method: "POST", body: { email: $("email").value, password: $("password").value } });
      saveSession(s);
      location.replace("dashboard.html" + location.search + location.hash);
    } catch (err) {
      btn.disabled = false;
      btn.textContent = "Sign in";
      showMsg("signin-msg", err.code === "login" ? "That email and password don't match. Check them and try again."
        : err.code === "rate_limited" ? "Too many tries. Wait a few minutes and try again."
        : err.code === "network" ? "Can't reach the AION server. Check your connection and try again."
        : "Sign-in didn't work (" + err.message + "). Try again, or ask Youssef.", "err");
      $("password").select();
    }
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
        : err.code === "network" ? "Can't reach the AION server. Check your connection and try again."
        : err.message, "err");
      btn.textContent = "Send reset link";
    } finally {
      btn.disabled = false;
    }
  });
}
