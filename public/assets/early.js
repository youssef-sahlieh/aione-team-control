// Runs first on every signed-in page, before anything is drawn (a plain script in <head>, after config.js):
// - Not signed in: straight to the sign-in page (a ticket in the address is kept), so the page never flashes.
// - Opened by AI1 Monitor's sign-in (?ai1-monitor=<state>): nothing is drawn; the one-time code is fetched
//   and the browser goes straight on to the Monitor. If that fails, the page shows itself and dashboard.js
//   reports why (window.AION_MONITOR_HANDOFF resolves with the message).
(function () {
  var root = document.documentElement, session = null;
  try { session = JSON.parse(localStorage.getItem("aione-session") || "null"); } catch (e) { /* no storage: sign in */ }
  if (!(session && session.token && session.expiresAt > Date.now())) {
    root.style.visibility = "hidden";
    location.replace("index.html" + location.search + location.hash);
    return;
  }
  var state = new URLSearchParams(location.search).get("ai1-monitor");
  if (!state || !/^[A-Za-z0-9_-]{20,100}$/.test(state) || !window.AIONE_API) return;
  // Reached again with Back or Forward: dashboard.js shows the dashboard instead.
  try { var nav = performance.getEntriesByType("navigation")[0]; if (nav && nav.type === "back_forward") return; } catch (e) { /* older browser */ }
  // The Monitor page a Databases "Open" link asked for in the last 2 minutes (used once), or null.
  function monitorPage() {
    var saved = null;
    try { saved = JSON.parse(localStorage.getItem("aione-monitor-next") || "null"); localStorage.removeItem("aione-monitor-next"); } catch (e) { return null; }
    var page = saved && String(saved.page || "");
    if (!page || !(Date.now() - saved.at < 120000) || !/^\/(dashboard#instance\/[\w.%-]{1,80}\/info|api\/monitor\/instances\/(?!\.+\/)[\w.%-]{1,80}\/open-odoo(\?database=[\w.%-]{1,120})?)$/.test(page)) return null;
    return page;
  }
  root.style.visibility = "hidden";
  document.title = "Opening AI1 Monitor…";
  window.AION_MONITOR_HANDOFF = fetch(window.AIONE_API + "/sso/monitor/code", {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + session.token }, body: JSON.stringify({ state: state })
  }).then(function (r) {
    return r.json().catch(function () { return {}; }).then(function (data) {
      if (!r.ok) throw new Error(data.error || "AI1 Monitor sign-in didn't work. Open AI1 Monitor again.");
      var target = new URL(data.callback);
      if (target.origin !== "https://monitor.ai1.host" || target.pathname !== "/auth/aione/callback") throw new Error("AI1 Monitor's address isn't the one this dashboard expects.");
      target.searchParams.set("code", data.code);
      target.searchParams.set("state", state);
      var page = monitorPage();
      if (!page) { location.replace(target.href); return new Promise(function () {}); }
      // Opened from a Databases "Open" link: the Monitor's callback always lands on its home page, so the sign-in
      // runs in the background (monitor.ai1.host is the same site, so its login cookie is kept) and the browser
      // goes straight to the instance page. If the background call can't be made, the usual sign-in runs.
      return fetch(target.href, { mode: "no-cors", credentials: "include" }).then(function () {
        location.replace("https://monitor.ai1.host" + page);
      }, function () {
        location.replace(target.href);
      }).then(function () { return new Promise(function () {}); }); // leaving the page
    });
  }).catch(function (err) {
    root.style.visibility = "";
    document.title = "AIONE Team Control";
    return (err && err.message) || "AI1 Monitor sign-in didn't work. Open AI1 Monitor again.";
  });
})();
