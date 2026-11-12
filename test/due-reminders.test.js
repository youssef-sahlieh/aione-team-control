import test from "node:test";
import assert from "node:assert/strict";
import { remindDueDates, readReminderTickets } from "../proxy/src/due-reminders.js";

function fakeStore() {
  const m = new Map();
  return { m, get: async (k) => (m.has(k) ? m.get(k) : null), set: async (k, v) => { m.set(k, String(v)); return "OK"; } };
}
const env = (store) => ({ STORE: store, APP_URL: "https://dashboard.example.invalid", MAIL_DOMAIN: "example.invalid" });
const me = { email: "admin@example.invalid", name: "Admin Example" };

test("each developer gets one notification per ticket and one email listing them", async () => {
  const store = fakeStore(), mails = [];
  const res = await remindDueDates(env(store), me, { tickets: [
    { key: "AION-1", title: "First <task>", devs: ["builder"] },
    { key: "INT-2", title: "Second", devs: ["builder", "reviewer"] },
    { key: "AION-3", title: "No dev", devs: [] },
    { key: "HD-4", title: "Odoo", devs: ["builder"] },
    { key: "AION-5", title: "Unknown dev", devs: ["ghost"] },
  ] }, { devEmails: { builder: "builder@example.invalid", reviewer: "reviewer@other.invalid" }, sendMail: async (from, b) => { mails.push({ from, ...b }); return { ok: true }; } });
  const out = await res.json();
  assert.equal(res.status, 200);
  assert.deepEqual(out.reminded, [{ dev: "builder", tickets: 2, emailed: true }, { dev: "reviewer", tickets: 1, emailed: false }]);
  assert.deepEqual(out.noDev, ["AION-3"]);
  assert.deepEqual(out.noEmail, ["ghost"]);
  assert.equal(out.skippedOdoo, 1);
  const inbox = JSON.parse(store.m.get("inbox:builder@example.invalid"));
  assert.deepEqual(inbox.map((x) => [x.type, x.key]).sort(), [["due", "AION-1"], ["due", "INT-2"]]);
  assert.ok(store.m.get("inbox:reviewer@other.invalid"), "a non-company address still gets the dashboard notification");
  assert.equal(mails.length, 1, "only company addresses are emailed");
  assert.deepEqual(mails[0].to, ["builder@example.invalid"]);
  assert.match(mails[0].subject, /2 tickets/);
  assert.match(mails[0].html, /First &lt;task&gt;/);
  assert.match(mails[0].html, /dashboard\.html\?page=tickets#INT-2/);
});

test("bad input is refused, and odd keys and names are dropped", async () => {
  const res = await remindDueDates(env(fakeStore()), me, { tickets: [] }, { devEmails: {}, sendMail: null });
  assert.equal(res.status, 400);
  assert.deepEqual(readReminderTickets({ tickets: [{ key: "bad key", devs: ["x"] }, { key: "AION-9", devs: ["ok", "<script>"] }, { key: "AION-9", devs: [] }] }), [{ key: "AION-9", title: "", devs: ["ok"] }]);
});
