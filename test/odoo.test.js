// Odoo Helpdesk tickets through the proxy, against a fake Odoo JSON-RPC server.
import test from "node:test";
import assert from "node:assert/strict";
import worker from "../proxy/src/handler.js";
import { customerOf } from "../proxy/src/odoo.js";

const calls = [];
const TICKETS = {
  300: { id: 300, name: "Ready development", stage_id: [2, "In Progress"], user_id: [12, "Shahd Ghayadah"], partner_email: '"Ariel Amiri" <ariel@kadouri.co.il>', partner_name: "", partner_id: [5, "ariel@kadouri.co.il"], priority: "1", team_id: [1, "ai1 | Support"], create_date: "2026-10-01 08:00:00", write_date: "2026-10-14 09:00:00", close_date: false, sla_deadline: "2026-10-20 10:00:00", ticket_ref: "302", description: "<p>Please deploy</p>" },
  // Conversation cases: we replied last (waiting for the customer); Solved, then the customer wrote again;
  // Solved with nothing after; we replied, then the customer answered; a note after the customer (still theirs).
  310: { id: 310, name: "Waiting for customer", stage_id: [2, "In Progress"], user_id: [12, "Shahd Ghayadah"], partner_email: "w@example.invalid", partner_name: "", partner_id: [40, "W"], priority: "0", team_id: [1, "ai1 | Support"], create_date: "2026-10-01 08:00:00", write_date: "2026-10-05 09:00:00", close_date: false, sla_deadline: false, ticket_ref: "310", description: "" },
  320: { id: 320, name: "Solved, customer wrote again", stage_id: [3, "Solved"], user_id: [12, "Shahd Ghayadah"], partner_email: "s@example.invalid", partner_name: "", partner_id: [41, "S"], priority: "0", team_id: [1, "ai1 | Support"], create_date: "2026-10-01 08:00:00", write_date: "2026-10-06 09:00:00", close_date: "2026-10-06 09:00:00", sla_deadline: false, ticket_ref: "320", description: "" },
  330: { id: 330, name: "Solved and quiet", stage_id: [3, "Solved"], user_id: [12, "Shahd Ghayadah"], partner_email: "q@example.invalid", partner_name: "", partner_id: [42, "Q"], priority: "0", team_id: [1, "ai1 | Support"], create_date: "2026-10-01 08:00:00", write_date: "2026-10-06 09:00:00", close_date: "2026-10-06 09:00:00", sla_deadline: false, ticket_ref: "330", description: "" },
  340: { id: 340, name: "Customer answered our reply", stage_id: [2, "In Progress"], user_id: [12, "Shahd Ghayadah"], partner_email: "a@example.invalid", partner_name: "", partner_id: [43, "A"], priority: "0", team_id: [1, "ai1 | Support"], create_date: "2026-10-01 08:00:00", write_date: "2026-10-07 09:00:00", close_date: false, sla_deadline: false, ticket_ref: "340", description: "" },
  293: { id: 293, name: "Cartons order", stage_id: [2, "In Progress"], user_id: [34, "Bashar Bannoura"], partner_email: "neor@suzume.co.il", partner_name: "Neor El Hai", partner_id: false, priority: "0", team_id: [1, "ai1 | Support"], create_date: "2026-10-02 08:00:00", write_date: "2026-10-13 09:00:00", close_date: false, sla_deadline: false, ticket_ref: "293", description: "" }
};
const ATTACHMENTS = [
  { id: 501, name: "invoice.pdf", mimetype: "application/pdf", file_size: 5, create_date: "2026-10-03 10:00:00", create_uid: [12, "Shahd Ghayadah"], res_model: "helpdesk.ticket", res_id: 300, type: "binary", datas: Buffer.from("%PDF-").toString("base64") },
  { id: 502, name: "other.txt", mimetype: "text/plain", file_size: 3, create_date: "2026-10-03 11:00:00", create_uid: false, res_model: "helpdesk.ticket", res_id: 293, type: "binary", datas: Buffer.from("abc").toString("base64") },
  // Files of chatter messages: attached to the message itself (as an email's attachments are), not to the ticket.
  { id: 503, name: "screenshot.png", mimetype: "image/png", file_size: 4, create_date: "2026-10-04 09:00:00", create_uid: [5, "Ariel Amiri"], res_model: "mail.message", res_id: 9001, type: "binary", datas: Buffer.from("PNG!").toString("base64") },
  { id: 504, name: "elsewhere.png", mimetype: "image/png", file_size: 4, create_date: "2026-10-04 09:00:00", create_uid: false, res_model: "mail.message", res_id: 9002, type: "binary", datas: Buffer.from("NOPE").toString("base64") }
];
// Ticket 300's chatter: a text message, and an email whose only content is a picture. 504 is on another ticket's message.
const MESSAGES = [
  { id: 9000, res_id: 300, body: "<p>Hello</p>", author_id: [5, "Ariel Amiri"], date: "2026-10-03 10:00:00", subtype_id: [1, "Discussions"], message_type: "email", attachment_ids: [] },
  { id: 9001, res_id: 300, body: "", author_id: [5, "Ariel Amiri"], date: "2026-10-04 09:00:00", subtype_id: [1, "Discussions"], message_type: "email", attachment_ids: [503] },
  { id: 9002, res_id: 293, body: "<p>Other</p>", author_id: false, date: "2026-10-04 09:00:00", subtype_id: [1, "Discussions"], message_type: "email", attachment_ids: [504] },
  // 112 is Shahd's Odoo contact: her messages are ours.
  { id: 9100, res_id: 310, body: "<p>Help</p>", author_id: [40, "W"], date: "2026-10-04 09:00:00", subtype_id: [1, "Discussions"], message_type: "email", attachment_ids: [] },
  { id: 9101, res_id: 310, body: "<p>Done, please check</p>", author_id: [112, "Shahd Ghayadah"], date: "2026-10-05 09:00:00", subtype_id: [1, "Discussions"], message_type: "comment", attachment_ids: [] },
  { id: 9200, res_id: 320, body: "<p>It broke again</p>", author_id: [41, "S"], date: "2026-10-08 09:00:00", subtype_id: [1, "Discussions"], message_type: "email", attachment_ids: [] },
  { id: 9300, res_id: 330, body: "<p>Thanks</p>", author_id: [42, "Q"], date: "2026-10-05 09:00:00", subtype_id: [1, "Discussions"], message_type: "email", attachment_ids: [] },
  { id: 9400, res_id: 340, body: "<p>Done</p>", author_id: [112, "Shahd Ghayadah"], date: "2026-10-06 09:00:00", subtype_id: [1, "Discussions"], message_type: "comment", attachment_ids: [] },
  { id: 9401, res_id: 340, body: "<p>Not fixed</p>", author_id: [43, "A"], date: "2026-10-07 09:00:00", subtype_id: [1, "Discussions"], message_type: "email", attachment_ids: [] },
  { id: 9402, res_id: 340, body: "<p>Checking</p>", author_id: [112, "Shahd Ghayadah"], date: "2026-10-07 10:00:00", subtype_id: [2, "Note"], message_type: "comment", attachment_ids: [] }
];
globalThis.fetch = async (url, init) => {
  const body = JSON.parse(init.body);
  const { service, method, args } = body.params;
  calls.push({ service, method, args });
  const reply = (result) => Response.json({ jsonrpc: "2.0", id: body.id, result });
  if (service === "common" && method === "authenticate") return reply(args[2] === "good-key" ? 7 : false);
  const [, , , model, m, a, kw = {}] = args;
  if (model === "res.users") return reply([{ id: 12, name: "Shahd Ghayadah", login: "shahd@aione.biz", email: "shahd@aione.biz", partner_id: [112, "Shahd Ghayadah"] }, { id: 34, name: "Bashar Bannoura", login: "bashar.b@aione.biz", email: "bashar.b@aione.biz", partner_id: [134, "Bashar Bannoura"] }, { id: 6, name: "Ireen Khair", login: "ireen@aione.biz", email: "ireen@aione.biz", partner_id: [106, "Ireen Khair"] }]);
  if (model === "ir.attachment" && m === "read") return reply(ATTACHMENTS.filter((x) => a[0].includes(x.id)).map(({ datas, res_model, res_id, ...rest }) => (a[1] || []).includes("datas") ? { id: rest.id, datas } : rest));
  if (model === "ir.attachment" && m === "create") { const id = 600 + ATTACHMENTS.length; ATTACHMENTS.push({ id, file_size: Buffer.from(a[0].datas, "base64").length, create_date: "2026-10-05 08:00:00", create_uid: [7, "API"], type: "binary", mimetype: "application/octet-stream", ...a[0] }); return reply(id); }
  if (model === "ir.attachment") {
    const byTerm = (field) => a[0].find((t) => Array.isArray(t) && t[0] === field);
    const idOk = (x) => { const t = byTerm("id"); return !t || (t[1] === "in" ? t[2].includes(x.id) : x.id === t[2]); };
    const rows = ATTACHMENTS.filter((x) => x.res_model === byTerm("res_model")[2] && x.res_id === byTerm("res_id")[2] && x.type === "binary" && idOk(x));
    return reply(rows.map(({ datas, res_model, res_id, type, ...rest }) => ({ ...rest })));
  }
  if (model === "helpdesk.stage") return reply([{ id: 1, name: "New", fold: false, sequence: 1, team_ids: [1] }, { id: 2, name: "In Progress", fold: false, sequence: 2, team_ids: [1] }, { id: 3, name: "Solved", fold: true, sequence: 3, team_ids: [1] }, { id: 9, name: "Other team only", fold: false, sequence: 4, team_ids: [5] }]);
  if (model === "mail.message") {
    // Domain terms: res_id (= / in), message_type (= / in), date (>=), attachment_ids (in).
    const match = (x, [f, op, v]) => f === "model" || f === "attachment_ids" || (op === "in" ? v.includes(x[f]) : op === ">=" ? String(x[f]) >= v : x[f] === v);
    const onTicket = MESSAGES.filter((x) => a[0].every((t) => match(x, t)));
    if (m === "search_count") { const att = a[0].find((t) => t[0] === "attachment_ids"); return reply(onTicket.filter((x) => att[2].some((id) => x.attachment_ids.includes(id))).length); }
    return reply(onTicket.map((x) => ({ ...x })));
  }
  if (model === "helpdesk.ticket" && m === "search_read") {
    const refTerm = a[0].find((t) => Array.isArray(t) && t[0] === "ticket_ref");
    const userTerm = a[0].find((t) => Array.isArray(t) && t[0] === "user_id");
    let rows = Object.values(TICKETS);
    if (refTerm) rows = rows.filter((t) => t.ticket_ref === refTerm[2]);
    if (userTerm) rows = rows.filter((t) => t.user_id && t.user_id[0] === userTerm[2]);
    return reply(rows.map((t) => ({ ...t })));
  }
  if (model === "helpdesk.ticket" && m === "write") { const t = TICKETS[a[0][0]]; if (a[1].stage_id) t.stage_id = [a[1].stage_id, a[1].stage_id === 3 ? "Solved" : "x"]; if ("user_id" in a[1]) t.user_id = a[1].user_id ? [a[1].user_id, "someone"] : false; return reply(true); }
  if (model === "helpdesk.ticket" && m === "message_post") return reply(99);
  return reply(null);
};

const env = {
  ALLOWED_ORIGIN: "x", TEAM_EMAILS: "youssef@aione.biz", JIRA_PROJECT: "AION", TEAM_PASSWORD: "pw-12345678", SESSION_SECRET: "s",
  TEAM_CONFIG: JSON.stringify({ devEmails: { bashar: "bashar.b@aione.biz", shahd: "Shahd@aione.biz" } }),
  LOGIN_LIMIT: { limit: async () => ({ success: true }) },
  ODOO_URL: "https://kadis.odoo.test", ODOO_DB: "db", ODOO_LOGIN: "youssef@aione.biz", ODOO_API_KEY: "good-key"
};
const req = async (path, { method = "GET", body, token } = {}) => {
  const r = await worker.fetch(new Request("https://p" + path, { method, headers: token ? { Authorization: "Bearer " + token } : {}, body: body ? JSON.stringify(body) : undefined }), env);
  return { status: r.status, data: await r.json() };
};
const adminToken = async () => (await req("/login", { method: "POST", body: { email: "youssef@aione.biz", password: "pw-12345678" } })).data.token;

test("customer name and email from Odoo's fields", () => {
  assert.deepEqual(customerOf({ partner_email: '"Ariel Amiri" <ariel@kadouri.co.il>' }), { name: "Ariel Amiri", email: "ariel@kadouri.co.il" });
  assert.deepEqual(customerOf({ partner_email: "neor@suzume.co.il", partner_name: "Neor El Hai" }), { name: "Neor El Hai", email: "neor@suzume.co.il" });
  assert.deepEqual(customerOf({ partner_email: "", partner_name: "", partner_id: [1, "Acme"] }), { name: "Acme", email: "" });
});

test("config says Odoo is connected", async () => {
  const t = await adminToken();
  assert.equal((await req("/config", { token: t })).data.odoo, true);
});

test("list maps Odoo tickets: developer from the Odoo assignee, customer, stage, SLA", async () => {
  const { data } = await req("/odoo/tickets", { token: await adminToken() });
  const t300 = data.tickets.find((t) => t.key === "HD-302");
  assert.equal(t300.id, 300, "keyed by the number people see in Odoo (302), record id kept for links");
  assert.deepEqual(t300.devs, ["shahd"]);
  assert.deepEqual(t300.customer, { name: "Ariel Amiri", email: "ariel@kadouri.co.il" });
  assert.equal(t300.status, "In Progress"); assert.equal(t300.statusCat, "indeterminate");
  assert.equal(t300.due, "2026-10-20"); assert.equal(t300.priority, "Medium"); assert.equal(t300.team, "ai1 | Support");
  assert.match(t300.url, /^https:\/\/kadis\.odoo\.test\/web#id=300&model=helpdesk\.ticket/);
  assert.deepEqual(data.tickets.find((t) => t.key === "HD-293").devs, ["bashar"]);
});

test("detail: description, chatter and only this team's stages", async () => {
  const { data } = await req("/odoo/tickets/HD-302", { token: await adminToken() });
  assert.equal(data.description, "<p>Please deploy</p>");
  assert.equal(data.messages[0].author, "Ariel Amiri"); assert.equal(data.messages[0].email, true);
  assert.deepEqual(data.stages.map((s) => s.name), ["New", "In Progress", "Solved"]);
});

test("attachments are listed on the ticket and downloaded through the proxy, only for that ticket", async () => {
  const t = await adminToken();
  const { data } = await req("/odoo/tickets/HD-302", { token: t });
  assert.deepEqual(data.attachments.map((a) => [a.id, a.filename, a.mimeType, a.size, a.author.displayName]), [[503, "screenshot.png", "image/png", 4, "Ariel Amiri"], [501, "invoice.pdf", "application/pdf", 5, "Shahd Ghayadah"]]);
  const ok = await worker.fetch(new Request("https://p/odoo/tickets/HD-302/attachments/501", { headers: { Authorization: "Bearer " + t } }), env);
  assert.equal(ok.status, 200); assert.equal(ok.headers.get("Content-Type"), "application/pdf");
  assert.match(ok.headers.get("Content-Disposition"), /invoice\.pdf/);
  assert.equal(await ok.text(), "%PDF-");
  const other = await req("/odoo/tickets/HD-302/attachments/502", { token: t });
  assert.equal(other.status, 404, "a file on another ticket is not served under this one");
  assert.equal((await req("/odoo/tickets/HD-302/attachments/501", { method: "POST", token: t, body: {} })).status, 404);
});

test("files in the Odoo chatter show with their message and in the ticket's attachments, and download only for that ticket", async () => {
  const t = await adminToken();
  const { data } = await req("/odoo/tickets/HD-302", { token: t });
  // The email with only a picture is kept (it has a file), and the picture is on it.
  assert.equal(data.messages.length, 2);
  assert.deepEqual(data.messages[1].attachments.map((a) => [a.id, a.filename, a.mimeType]), [[503, "screenshot.png", "image/png"]]);
  assert.deepEqual(data.messages[0].attachments, []);
  assert.deepEqual(data.attachments.map((a) => a.id), [503, 501], "the ticket's attachments include the chatter's, newest first");
  const pic = await worker.fetch(new Request("https://p/odoo/tickets/HD-302/attachments/503", { headers: { Authorization: "Bearer " + t } }), env);
  assert.equal(pic.status, 200); assert.equal(pic.headers.get("Content-Type"), "image/png"); assert.equal(await pic.text(), "PNG!");
  // A file on another ticket's message isn't served under this ticket.
  assert.equal((await req("/odoo/tickets/HD-302/attachments/504", { token: t })).status, 404);
});

test("admin moves the stage and changes the developer in Odoo", async () => {
  const t = await adminToken();
  calls.length = 0;
  let r = await req("/odoo/tickets/HD-302", { method: "PUT", token: t, body: { stage: 3 } });
  assert.equal(r.status, 200);
  assert.deepEqual(calls.find((c) => c.args[4] === "write").args[5], [[300], { stage_id: 3 }]);
  assert.equal((await req("/odoo/tickets/HD-302", { method: "PUT", token: t, body: { stage: 9 } })).status, 400, "other team's stage refused");
  calls.length = 0;
  r = await req("/odoo/tickets/HD-293", { method: "PUT", token: t, body: { devs: ["ireen"] } });
  assert.equal(r.status, 200);
  assert.deepEqual(calls.find((c) => c.args[4] === "write").args[5], [[293], { user_id: 6 }]);
  assert.equal((await req("/odoo/tickets/HD-293", { method: "PUT", token: t, body: { devs: ["a", "b"] } })).status, 400, "one developer only");
  TICKETS[293].user_id = [34, "Bashar Bannoura"];
});

test("notes go to the chatter as internal notes, signed by the dashboard user", async () => {
  calls.length = 0;
  const r = await req("/odoo/tickets/HD-302/note", { method: "POST", token: await adminToken(), body: { text: "Checking <now>" } });
  assert.equal(r.status, 201);
  const post = calls.find((c) => c.args[4] === "message_post");
  assert.equal(post.args[6].subtype_xmlid, "mail.mt_note"); assert.equal(post.args[6].message_type, "comment");
  assert.match(post.args[6].body, /Checking &lt;now&gt;/); assert.match(post.args[6].body, /via AION Team Control/);
});

test("a wrong API key is reported clearly", async () => {
  const saved = env.ODOO_API_KEY; env.ODOO_API_KEY = "bad"; env.ODOO_LOGIN = "other@aione.biz";
  const r = await req("/odoo/tickets", { token: await adminToken() });
  env.ODOO_API_KEY = saved; env.ODOO_LOGIN = "youssef@aione.biz";
  assert.equal(r.status, 502); assert.match(r.data.error, /ODOO_API_KEY/);
});

test("without Odoo settings the routes say so", async () => {
  const saved = env.ODOO_URL; env.ODOO_URL = "";
  const r = await req("/odoo/tickets", { token: await adminToken() });
  env.ODOO_URL = saved;
  assert.equal(r.status, 501); assert.equal(r.data.code, "odoo_off");
});

test("a picture added to an Odoo note is uploaded to that ticket and attached to the note", async () => {
  const t = await adminToken();
  const up = await worker.fetch(new Request("https://p/odoo/tickets/HD-302/attachments?name=" + encodeURIComponent("picture-1.png"), { method: "POST", headers: { Authorization: "Bearer " + t, "Content-Type": "image/png" }, body: new Uint8Array([137, 80, 78, 71]) }), env);
  assert.equal(up.status, 201);
  const { attachment } = await up.json();
  assert.equal(attachment.filename, "picture-1.png"); assert.equal(attachment.mimeType, "image/png");
  const saved = ATTACHMENTS.find((x) => x.id === attachment.id);
  assert.deepEqual([saved.res_model, saved.res_id, saved.mimetype, Buffer.from(saved.datas, "base64").length], ["helpdesk.ticket", 300, "image/png", 4]);
  calls.length = 0;
  assert.equal((await req("/odoo/tickets/HD-302/note", { method: "POST", token: t, body: { text: "See the picture", attachmentIds: [attachment.id] } })).status, 201);
  const post = calls.find((c) => c.args[4] === "message_post");
  assert.deepEqual(post.args[6].attachment_ids, [attachment.id]);
  // A picture alone is a note too; a file of another ticket can't be attached.
  assert.equal((await req("/odoo/tickets/HD-302/note", { method: "POST", token: t, body: { text: "", attachmentIds: [attachment.id] } })).status, 201);
  assert.equal((await req("/odoo/tickets/HD-302/note", { method: "POST", token: t, body: { text: "x", attachmentIds: [502] } })).status, 400);
  assert.equal((await req("/odoo/tickets/HD-302/note", { method: "POST", token: t, body: { text: "" } })).status, 400);
  const empty = await worker.fetch(new Request("https://p/odoo/tickets/HD-302/attachments?name=x.png", { method: "POST", headers: { Authorization: "Bearer " + t }, body: new Uint8Array([]) }), env);
  assert.equal(empty.status, 400);
});

test("the list follows the conversation: hidden after our reply, shown when the customer answers; a Solved ticket the customer wrote to goes back to In Progress", async () => {
  const t = await adminToken();
  // Solved again (an earlier list in this file may already have reopened it).
  Object.assign(TICKETS[320], { stage_id: [3, "Solved"], close_date: "2026-10-06 09:00:00" });
  calls.length = 0;
  const keys = (await req("/odoo/tickets", { token: t })).data.tickets.map((x) => x.key).sort();
  assert.ok(keys.includes("HD-293"), "the customer wrote and we haven't replied");
  assert.ok(!keys.includes("HD-310"), "we replied last: waiting for the customer, hidden");
  assert.ok(keys.includes("HD-340"), "the customer answered our reply (a later internal note doesn't count as a reply)");
  assert.ok(!keys.includes("HD-330"), "Solved with nothing after: hidden");
  assert.ok(keys.includes("HD-320"), "Solved, then the customer wrote: shown again");
  const reopened = calls.filter((c) => c.args[3] === "helpdesk.ticket" && c.args[4] === "write");
  assert.deepEqual(reopened.map((c) => c.args[5]), [[[320], { stage_id: 2 }]], "moved to In Progress in Odoo");
  assert.equal(TICKETS[320].stage_id[0], 2);
});

test("Reply to customer is emailed by Odoo to the ticket's customer; an internal note isn't", async () => {
  const t = await adminToken();
  calls.length = 0;
  assert.equal((await req("/odoo/tickets/HD-302/note", { method: "POST", token: t, body: { text: "We fixed it", toCustomer: true } })).status, 201);
  const reply = calls.find((c) => c.args[4] === "message_post").args[6];
  assert.equal(reply.subtype_xmlid, "mail.mt_comment"); assert.deepEqual(reply.partner_ids, [5]);
  assert.match(reply.body, /We fixed it/); assert.doesNotMatch(reply.body, /AION Team Control/);
  calls.length = 0;
  await req("/odoo/tickets/HD-302/note", { method: "POST", token: t, body: { text: "Internal only" } });
  const note = calls.find((c) => c.args[4] === "message_post").args[6];
  assert.equal(note.subtype_xmlid, "mail.mt_note"); assert.equal(note.partner_ids, undefined);
  assert.equal((await req("/odoo/tickets/HD-302/note", { method: "POST", token: t, body: { text: "", toCustomer: true } })).status, 400);
});

test("new Odoo tickets start unassigned once, even when Odoo assigned someone; older tickets keep their assignee", async () => {
  const { memoryStore } = await import("../proxy/src/users.js");
  env.STORE = memoryStore();
  try {
    const t = await adminToken();
    calls.length = 0;
    await req("/odoo/tickets", { token: t }); // starts now: nothing existing is touched
    assert.deepEqual(calls.filter((c) => c.args[4] === "write" && c.args[6] === undefined && "user_id" in (c.args[5][1] || {})), []);
    const since = await env.STORE.get("odoo:unassign-new-since");
    TICKETS[350] = { id: 350, name: "Brand new", stage_id: [1, "New"], user_id: [12, "Shahd Ghayadah"], partner_email: "n@example.invalid", partner_name: "", partner_id: [44, "N"], priority: "0", team_id: [1, "ai1 | Support"], create_date: since.slice(0, 10) + " 23:59:59", write_date: since, close_date: false, sla_deadline: false, ticket_ref: "350", description: "" };
    calls.length = 0;
    const list = (await req("/odoo/tickets", { token: t })).data.tickets;
    const unassigned = calls.filter((c) => c.args[3] === "helpdesk.ticket" && c.args[4] === "write" && "user_id" in c.args[5][1]);
    assert.deepEqual(unassigned.map((c) => c.args[5]), [[[350], { user_id: false }]]);
    assert.deepEqual(list.find((x) => x.key === "HD-350").devs, [], "shown unassigned");
    assert.equal(TICKETS[300].user_id[0], 12, "an older ticket keeps its assignee");
    // Assigned afterwards: it stays assigned.
    TICKETS[350].user_id = [34, "Bashar Bannoura"]; calls.length = 0;
    await req("/odoo/tickets", { token: t });
    assert.equal(calls.filter((c) => c.args[4] === "write" && "user_id" in (c.args[5][1] || {})).length, 0);
  } finally { delete env.STORE; delete TICKETS[350]; }
});
