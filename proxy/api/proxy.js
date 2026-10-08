// Vercel entry point (Node.js runtime). vercel.json sends every path here as ?__path=<path>; this restores
// the path and hands the request to the proxy with the settings and the secrets from Vercel's environment
// variables. When GMAIL_USER and GMAIL_APP_PASSWORD are set, the dashboard's emails go out through Gmail.
// When the Upstash Redis storage is connected (KV_REST_API_* or UPSTASH_REDIS_REST_* variables), user
// accounts are on.
import nodemailer from "nodemailer";
import handler from "../src/handler.js";
import settings from "../settings.js";
import { redisStore } from "../src/users.js";

const SECRETS = ["TEAM_PASSWORD", "SESSION_SECRET", "TEAM_CONFIG", "JIRA_SITE", "JIRA_EMAIL", "JIRA_API_TOKEN", "MS_TENANT_ID", "MS_CLIENT_ID", "MS_CLIENT_SECRET"];

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

async function handle(request) {
  const url = new URL(request.url);
  url.pathname = "/" + (url.searchParams.get("__path") || "");
  url.searchParams.delete("__path");
  const env = { ...settings, MAILER: gmailMailer(), STORE: store() };
  for (const name of SECRETS) env[name] = process.env[name] || "";
  const hasBody = !["GET", "HEAD"].includes(request.method);
  return handler.fetch(new Request(url, { method: request.method, headers: request.headers, body: hasBody ? await request.arrayBuffer() : undefined }), env);
}

export const GET = handle, POST = handle, PUT = handle, DELETE = handle, OPTIONS = handle;
