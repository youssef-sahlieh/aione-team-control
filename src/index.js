// AION Team Control - Cloudflare Worker.
// Sign-in is handled by Cloudflare Access (email one-time PIN). This Worker double-checks the
// Access token and the allow-list on every request before serving any page or data.
import { verifyAccess } from "./access.js";

const SECURITY_HEADERS = {
  "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; form-action 'self'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "same-origin",
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()"
};

function withHeaders(res, extra = {}) {
  const r = new Response(res.body, res);
  for (const [k, v] of Object.entries({ ...SECURITY_HEADERS, ...extra })) r.headers.set(k, v);
  return r;
}

function denied(reason) {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>No access · AION Team Control</title><link rel="stylesheet" href="/assets/style.css"></head>
<body><main class="auth"><div class="card"><div class="band"></div><div class="cbody">
<div class="mark"><span class="logo">Ai1</span><div><b>AION Team Control</b><small>Aione System Ltd</small></div></div>
<h1>You don't have access</h1><p class="lead">This email isn't on the list of people who can open AION Team Control. Sign out and use your approved work email, or ask Youssef for access.</p>
<a class="btn primary" style="text-align:center;text-decoration:none" href="/cdn-cgi/access/logout">Sign out</a>
</div></div></main></body></html>`;
  return withHeaders(new Response(html, { status: 403, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Denied-Reason": reason } }));
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // The "no access" page needs its stylesheet even when access is refused.
    if (url.pathname === "/assets/style.css") return withHeaders(await env.ASSETS.fetch(request));

    let user;
    try { user = await verifyAccess(request, env); }
    catch (err) {
      console.log("access denied:", err.message, url.pathname);
      if (url.pathname.startsWith("/api/")) return withHeaders(Response.json({ error: "forbidden" }, { status: 403 }), { "Cache-Control": "no-store" });
      return denied(err.message);
    }

    if (url.pathname === "/api/me") {
      return withHeaders(Response.json({ email: user.email, expiresAt: user.expires * 1000 }), { "Cache-Control": "no-store" });
    }
    if (url.pathname === "/healthz") return withHeaders(Response.json({ ok: true }), { "Cache-Control": "no-store" });
    if (url.pathname === "/logout") return Response.redirect(url.origin + "/cdn-cgi/access/logout", 302);

    // Everything else: the app's static files (index.html for "/").
    const res = await env.ASSETS.fetch(request);
    return withHeaders(res, { "Cache-Control": url.pathname.startsWith("/assets/") ? "private, max-age=300" : "no-store" });
  }
};
