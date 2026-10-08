// AION Team Control - sign-in with Microsoft 365, then show the app.
// Microsoft only issues sign-ins to users assigned to the app in Entra; this page also checks the
// tenant and the allow-list in config.js before showing anything.
import { allowedEmail, configProblem, redirectUri } from "./auth.js";

const cfg = window.AIONE_CONFIG;
const $ = (id) => document.getElementById(id);
const VIEWS = ["loading", "signin", "denied", "app"];

function show(view) {
  for (const v of VIEWS) $("view-" + v).hidden = v !== view;
}

function fail(msg) {
  $("signin-msg").textContent = msg;
  $("signin-msg").hidden = false;
  $("signin-btn").disabled = true;
  show("signin");
}

async function start() {
  const problem = configProblem(cfg);
  if (problem) return fail("This site isn't set up yet: " + problem);

  const here = redirectUri(window.location);
  const pca = await msal.PublicClientApplication.createPublicClientApplication({
    auth: {
      clientId: cfg.clientId,
      authority: "https://login.microsoftonline.com/" + cfg.tenantId,
      redirectUri: here,
      postLogoutRedirectUri: here,
      navigateToLoginRequestUrl: false
    },
    cache: { cacheLocation: "sessionStorage" }
  });

  const result = await pca.handleRedirectPromise();
  const account = (result && result.account) || pca.getActiveAccount() || pca.getAllAccounts()[0];

  const signOut = () => pca.logoutRedirect({ account });
  $("signout-btn").addEventListener("click", signOut);
  $("denied-signout-btn").addEventListener("click", signOut);
  $("signin-btn").addEventListener("click", () =>
    pca.loginRedirect({ scopes: ["openid", "profile", "email"], prompt: "select_account" }));

  if (!account) return show("signin");

  const email = allowedEmail(account, cfg);
  if (!email) {
    $("denied-who").textContent = account.username || "This account";
    return show("denied");
  }
  pca.setActiveAccount(account);
  $("me").textContent = email;
  show("app");
}

start().catch((err) => {
  console.error(err);
  fail("Sign-in didn't work: " + (err.errorMessage || err.message || "unknown error") + ". Try again, or ask Youssef.");
  $("signin-btn").disabled = false;
});
