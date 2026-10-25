// Local API for trying sign-in on this computer. It runs the same handler as the Vercel deployment, with an
// in-memory user store: the TEAM_EMAILS addresses are added as admins when it starts, and accounts and
// sessions are forgotten when it stops. Start it with its env file, then the preview with AION_API_URL:
//   node --env-file=.env.local scripts/local-api.js
//   AION_API_URL=http://127.0.0.1:3001 node --env-file=.env.local scripts/dev-server.js
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import handler from "../proxy/src/handler.js";
import settings from "../proxy/settings.js";
import { memoryStore, saveUser } from "../proxy/src/users.js";

const port = Number(process.env.LOCAL_API_PORT || 3001);
const dashboard = "http://localhost:" + Number(process.env.PORT || 3000);
const store = memoryStore();
const env = {
  ...settings,
  ...process.env,
  STORE: store,
  ALLOWED_ORIGIN: dashboard,
  APP_URL: dashboard,
  SESSION_SECRET: process.env.SESSION_SECRET || randomBytes(32).toString("hex")
};

for (const email of String(env.TEAM_EMAILS || "").split(",").map((e) => e.trim().toLowerCase()).filter(Boolean)) {
  await saveUser(store, { email, name: email.split("@")[0], role: "admin", dev: email.split("@")[0], v: 0 });
}

const dropped = ["host", "connection", "content-length"];
createServer(async (req, res) => {
  try {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const headers = new Headers();
    for (const [name, value] of Object.entries(req.headers)) {
      if (!dropped.includes(name) && value != null) headers.set(name, String(value));
    }
    const body = ["GET", "HEAD"].includes(req.method) ? undefined : Buffer.concat(chunks);
    const response = await handler.fetch(new Request(new URL(req.url, "http://localhost"), { method: req.method, headers, body }), env);
    res.writeHead(response.status, Object.fromEntries(response.headers)).end(Buffer.from(await response.arrayBuffer()));
  } catch (err) {
    console.error(err);
    res.writeHead(500, { "Content-Type": "application/json", "Cache-Control": "no-store" })
      .end(JSON.stringify({ code: "local", error: "The local API hit an error. See its terminal." }));
  }
}).listen(port, "127.0.0.1", () => console.log(`AION local API: http://127.0.0.1:${port} (accounts: ${env.TEAM_EMAILS || "none"})`));
