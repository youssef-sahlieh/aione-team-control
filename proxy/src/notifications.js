// Jira Automation calls this when a ticket is created. No browser session or dashboard refresh
// is involved. Jira data is read again with the proxy's credentials; recipients are server settings.
import { validEmail } from "./users.js";

const json = (body, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
const fail = (code, error, status) => json({ code, error }, status);
const escape = value => String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

export async function newTicketNotification(request, env, { readIssue, sendMail }) {
  const store = env.STORE;
  const to = [...new Set(String(env.NO_DEVELOPER_NOTIFY_TO || "").split(",").map(s => s.trim().toLowerCase()).filter(Boolean))];
  const domain = "@" + String(env.MAIL_DOMAIN || "").toLowerCase();
  if (!store?.setIfAbsent || !store?.deleteIfValue || !to.length || to.length > 20 || !to.every(e => validEmail(e) && e.endsWith(domain))) {
    return fail("notification_config", "Ticket notifications need storage and valid recipient settings.", 503);
  }
  if (Number(request.headers.get("Content-Length")) > 30000) return fail("bad_request", "Event is too large.", 413);
  const text = await request.text();
  if (text.length > 30000) return fail("bad_request", "Event is too large.", 413);
  let event;
  try { event = JSON.parse(text); } catch { return fail("bad_request", "Invalid event JSON.", 400); }
  if (event?.webhookEvent !== "jira:issue_created") return json({ skipped: "not_issue_created" });
  const key = event.issue?.key;
  if (typeof key !== "string" || !key.startsWith(env.JIRA_PROJECT + "-") || !/^\d+$/.test(key.slice(env.JIRA_PROJECT.length + 1)) || key.length > 80) {
    return fail("bad_request", "The event must reference this project's Jira ticket.", 400);
  }
  const result = await readIssue(key);
  if (!result.ok) return result.res;
  const issue = result.data, fields = issue?.fields;
  if (issue?.key !== key || fields?.project?.key !== env.JIRA_PROJECT || !/^\d+$/.test(String(issue?.id || "")) || !Array.isArray(fields?.labels) || !fields?.status?.statusCategory?.key) {
    return fail("jira", "Jira returned incomplete ticket information.", 502);
  }
  if (fields.status.statusCategory.key === "done") return json({ skipped: "ticket_closed" });
  if (fields.labels.some(label => /^ai1_/i.test(label))) return json({ skipped: "has_developer" });

  // A permanent sent marker survives redeployments. A separate atomic lock prevents parallel
  // webhook deliveries from both sending, and expires if the process stops unexpectedly.
  const marker = "notify:no-developer:" + env.JIRA_PROJECT + ":" + issue.id;
  if (await store.get(marker)) return json({ skipped: "already_sent" });
  const lock = marker + ":lock", owner = crypto.randomUUID();
  if (!await store.setIfAbsent(lock, owner, 120)) return fail("notification_busy", "This ticket alert is being processed. Retry shortly.", 503);
  try {
    if (await store.get(marker)) return json({ skipped: "already_sent" });
    const jiraLink = new URL("/browse/" + key, env.JIRA_SITE).href;
    const dashboardLink = String(env.APP_URL || "").replace(/\/+$/, "") + "/dashboard.html?page=tickets#" + key;
    const html = "<p>A new AION ticket is waiting for a developer.</p>"
      + "<p><b>" + escape(key) + " — " + escape(fields.summary || "Untitled ticket") + "</b></p>"
      + "<p>Status: " + escape(fields.status.name) + "<br>Assignee: " + escape(fields.assignee?.displayName || "Unassigned")
      + "<br>Priority: " + escape(fields.priority?.name || "Not set") + "<br>Due date: " + escape(fields.duedate || "Not set") + "</p>"
      + "<p><a href=\"" + escape(dashboardLink) + "\">Open in AION Team Control</a> · <a href=\"" + escape(jiraLink) + "\">Open in Jira</a></p>";
    // Use the existing Gmail / Microsoft mail infrastructure and domain restrictions.
    const response = await sendMail(to[0], { to, subject: "[AION] New ticket with no developer: " + key, html });
    if (!response.ok) return response;
    await store.set(marker, new Date().toISOString());
    return json({ sent: true, key });
  } finally {
    await store.deleteIfValue(lock, owner);
  }
}
