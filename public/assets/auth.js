// Sign-in rules, kept separate from the page so they can be tested with `npm test`.

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Returns a sentence explaining what is missing in config.js, or "" when it is ready.
export function configProblem(cfg) {
  if (!cfg) return "config.js did not load.";
  if (!GUID.test(String(cfg.clientId || ""))) return "clientId in assets/config.js is not set yet.";
  if (!GUID.test(String(cfg.tenantId || ""))) return "tenantId in assets/config.js is not set yet.";
  if (!Array.isArray(cfg.allowedEmails) || cfg.allowedEmails.length === 0) return "allowedEmails in assets/config.js is empty.";
  return "";
}

// The address Microsoft sends people back to after sign-in. "/app/index.html" and "/app/" are the
// same page, so both map to "/app/" to match the single redirect URI registered in Entra.
export function redirectUri(loc) {
  return loc.origin + loc.pathname.replace(/index\.html$/, "");
}

// Returns the signed-in email when the Microsoft account is from our tenant and on the allow-list;
// otherwise "".
export function allowedEmail(account, cfg) {
  if (!account || !cfg) return "";
  const tid = String((account.idTokenClaims && account.idTokenClaims.tid) || account.tenantId || "").toLowerCase();
  if (!tid || tid !== String(cfg.tenantId).toLowerCase()) return "";
  const email = String(account.username || "").trim().toLowerCase();
  const allowed = (cfg.allowedEmails || []).map((e) => String(e).trim().toLowerCase()).filter(Boolean);
  return email && allowed.includes(email) ? email : "";
}
