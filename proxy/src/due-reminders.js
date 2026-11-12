// "Remind about due date": an administrator picks tickets with no due date, and each developer on them gets one
// dashboard notification per ticket (a click opens it) and one email listing all of theirs.
// The browser sends the tickets it shows ({key, title, devs}); only administrators can call this.
import { addToInbox } from "./inbox.js";

const json = (data, status = 200) => Response.json(data, { status, headers: { "Cache-Control": "no-store" } });
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const KEY = /^[A-Z][A-Z0-9_]*-\d{1,9}$/, DEV = /^[a-z0-9][a-z0-9._-]{0,39}$/i, MAX = 200;

// The tickets as sent, cleaned: Odoo tickets (HD-) are left out, since their deadline is Odoo's SLA.
export function readReminderTickets(body) {
  const list = Array.isArray(body?.tickets) ? body.tickets.slice(0, MAX) : null;
  if (!list || !list.length) return null;
  const seen = new Set(), out = [];
  for (const t of list) {
    const key = String(t?.key || "");
    if (!KEY.test(key) || key.startsWith("HD-") || seen.has(key)) continue;
    seen.add(key);
    const devs = [...new Set((Array.isArray(t.devs) ? t.devs : []).map((d) => String(d || "").toLowerCase()).filter((d) => DEV.test(d)))].slice(0, 20);
    out.push({ key, title: String(t.title || "").replace(/\s+/g, " ").trim().slice(0, 200), devs });
  }
  return out;
}

// devEmails: developer name -> email. sendMail(from, {to, subject, html}) -> Response (or undefined when mail is off).
export async function remindDueDates(env, me, body, { devEmails, sendMail }) {
  const tickets = readReminderTickets(body);
  if (!tickets) return json({ code: "bad_request", error: "Choose at least one ticket." }, 400);
  const byDev = new Map(), noDev = [], noEmail = new Set();
  for (const t of tickets) {
    if (!t.devs.length) { noDev.push(t.key); continue; }
    for (const d of t.devs) {
      const email = String(devEmails[d] || "").trim().toLowerCase();
      if (!email) { noEmail.add(d); continue; }
      if (!byDev.has(email)) byDev.set(email, { dev: d, tickets: [] });
      byDev.get(email).tickets.push(t);
    }
  }
  const by = me.name || me.email, base = String(env.APP_URL || "").replace(/\/+$/, "") + "/dashboard.html?page=tickets#";
  const reminded = [];
  for (const [email, { dev, tickets: mine }] of byDev) {
    for (const t of mine) await addToInbox(env.STORE, [email], { type: "due", key: t.key, title: t.title, by, text: "Please set a due date for " + t.key + " (Request date change on the ticket)." }, me.email);
    let emailed = false;
    if (sendMail && email.endsWith("@" + String(env.MAIL_DOMAIN || "").toLowerCase())) {
      const rows = mine.map((t) => "<li><a href=\"" + esc(base + t.key) + "\">" + esc(t.key) + "</a> — " + esc(t.title) + "</li>").join("");
      try {
        const res = await sendMail(me.email, { to: [email], subject: "[AION] Please set a due date on " + (mine.length === 1 ? mine[0].key : mine.length + " tickets"),
          html: "<p>Hi,</p><p>" + esc(by) + " asks you to set a due date on " + (mine.length === 1 ? "this ticket" : "these tickets") + ". Open each one and use <b>Request date change</b>:</p><ul>" + rows + "</ul><p>Thank you.</p>" });
        emailed = !!(res && res.ok);
      } catch { console.warn("due_reminder_mail_failed"); }
    }
    reminded.push({ dev, tickets: mine.length, emailed });
  }
  return json({ reminded, noDev, noEmail: [...noEmail], skippedOdoo: (body.tickets || []).filter((t) => String(t?.key || "").startsWith("HD-")).length });
}
