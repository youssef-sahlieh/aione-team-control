// Vercel entry point. vercel.json sends every path here as ?__path=<path>; this restores the path and
// hands the request to the proxy with the settings and the secrets from Vercel's environment variables.
import handler from "../src/handler.js";
import settings from "../settings.js";

export const config = { runtime: "edge" };

const SECRETS = ["TEAM_PASSWORD", "SESSION_SECRET", "TEAM_CONFIG", "JIRA_SITE", "JIRA_EMAIL", "JIRA_API_TOKEN", "MS_TENANT_ID", "MS_CLIENT_ID", "MS_CLIENT_SECRET"];

export default async function (request) {
  const url = new URL(request.url);
  url.pathname = "/" + (url.searchParams.get("__path") || "");
  url.searchParams.delete("__path");
  const env = { ...settings };
  for (const name of SECRETS) env[name] = process.env[name] || "";
  return handler.fetch(new Request(url, request), env);
}
