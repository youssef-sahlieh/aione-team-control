// Vercel entry point (Node.js runtime). vercel.json sends every path here as ?__path=<path>; this restores
// the path and hands the request to the proxy with the settings and the secrets from Vercel's environment
// variables. When GMAIL_USER and GMAIL_APP_PASSWORD are set, the dashboard's emails go out through Gmail.
// When the Upstash Redis storage is connected (KV_REST_API_* or UPSTASH_REDIS_REST_* variables), user
// accounts are on.
import nodemailer from "nodemailer";
import { AsyncLocalStorage } from "node:async_hooks";
import handler from "../src/handler.js";
import settings from "../settings.js";
import { redisStore } from "../src/users.js";

const SECRETS = ["GITHUB_TOKEN", "ODOO_URL", "ODOO_DB", "ODOO_LOGIN", "ODOO_API_KEY", "TEAM_PASSWORD", "SESSION_SECRET", "TEAM_CONFIG", "JIRA_SITE", "JIRA_EMAIL", "JIRA_API_TOKEN", "MS_TENANT_ID", "MS_CLIENT_ID", "MS_CLIENT_SECRET", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "AI_VENDOR", "AI_MODEL", "AI_EFFORT", "JIRA_NOTIFICATION_SECRET", "CRON_SECRET", "JIRA_TOKEN_EXPIRES", "ODOO_KEY_EXPIRES"];

let gmail = null;
function gmailMailer() {
  const user = process.env.GMAIL_USER, pass = process.env.GMAIL_APP_PASSWORD;
  if (!user || !pass) return undefined;
  gmail = gmail || nodemailer.createTransport({ service: "gmail", auth: { user, pass: pass.replace(/\s+/g, "") } });
  return async ({ fromName, replyTo, to, subject, html }) => {
    await gmail.sendMail({ from: { name: fromName, address: user }, replyTo, to, subject, html });
  };
}

function store() {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  return url && token ? redisStore(url, token) : undefined;
}

// Server-Timing on every answer: how long this request waited on the database, Jira and Odoo
// (used to keep the proxy in the region closest to them). Only durations, never content.
const timing = new AsyncLocalStorage();
const baseFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const t = timing.getStore(), t0 = performance.now();
  try { return await baseFetch(input, init); }
  finally {
    if (t) {
      const host = new URL(typeof input === "string" || input instanceof URL ? input : input.url).hostname;
      const kind = /upstash\.io$/.test(host) ? "db" : /atlassian\.net$/.test(host) ? "jira" : /odoo\.com$/.test(host) ? "odoo" : "other";
      t[kind] = (t[kind] || 0) + (performance.now() - t0);
    }
  }
};

async function handle(request) {
  const t = {}, t0 = performance.now();
  const res = await timing.run(t, () => answer(request));
  const parts = Object.entries(t).map(([k, v]) => k + ";dur=" + Math.round(v));
  parts.push("total;dur=" + Math.round(performance.now() - t0), "region;desc=" + (process.env.VERCEL_REGION || "local"));
  try { res.headers.set("Server-Timing", parts.join(", ")); return res; }
  catch { const copy = new Response(res.body, res); copy.headers.set("Server-Timing", parts.join(", ")); return copy; }
}

async function answer(request) {
  const url = new URL(request.url);
  url.pathname = "/" + (url.searchParams.get("__path") || "");
  url.searchParams.delete("__path");
  const env = { ...settings, MAILER: gmailMailer(), STORE: store() };
  for (const name of SECRETS) env[name] = process.env[name] || "";
  env.NO_DEVELOPER_NOTIFY_TO = process.env.NO_DEVELOPER_NOTIFY_TO ?? settings.NO_DEVELOPER_NOTIFY_TO;
  // The commit this deployment runs (Vercel sets it), shown on /health so a deploy can be checked.
  env.BUILD = process.env.VERCEL_GIT_COMMIT_SHA || "";
  const hasBody = !["GET", "HEAD"].includes(request.method);
  return handler.fetch(new Request(url, { method: request.method, headers: request.headers, body: hasBody ? await request.arrayBuffer() : undefined }), env);
}

export const GET = handle, POST = handle, PUT = handle, DELETE = handle, OPTIONS = handle;
