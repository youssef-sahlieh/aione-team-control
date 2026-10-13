// Local frontend preview using the deployed authenticated API. No Jira secrets
// are needed locally, and the upstream proxy still enforces every permission.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve, sep, extname } from "node:path";
import { aiChat, aiBrief, aiConfigured } from "../proxy/src/ai.js";

const root = resolve("public");
const port = Number(process.env.PORT || 3000);
const upstream = "https://aione-team-proxy.vercel.app";
const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8" };

createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://localhost");
    if (url.pathname.startsWith("/api/")) {
      const chunks = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 5 * 1024 * 1024) { res.writeHead(413).end(); return; }
        chunks.push(chunk);
      }
      const headers = {};
      for (const name of ["authorization", "content-type"]) {
        if (req.headers[name]) headers[name] = req.headers[name];
      }
      if(url.pathname.startsWith("/api/ai/")){
        const cfg=await fetch(upstream+"/config",{headers,redirect:"error",signal:AbortSignal.timeout(15000)});
        if(!cfg.ok){res.writeHead(cfg.status,{"Content-Type":"application/json","Cache-Control":"no-store"}).end(await cfg.text());return;}
        const me=await cfg.json();
        const request=new Request("http://localhost"+url.pathname.slice(4),{method:req.method,headers,body:["GET","HEAD"].includes(req.method)?undefined:Buffer.concat(chunks)});
        const response=!["/api/ai/chat","/api/ai/brief"].includes(url.pathname)?Response.json({code:"ai_read_only",error:"Ticket actions are disabled in AION AI v1."},{status:403}):await (url.pathname==="/api/ai/brief"?aiBrief:aiChat)(request,process.env,{me,project:me.project,readSearch:async body=>{
          const r=await fetch(upstream+"/jira/search",{method:"POST",headers:{...headers,"Content-Type":"application/json","X-AION-Read-Only":"1"},body:JSON.stringify(body),redirect:"error",signal:AbortSignal.timeout(20000)});
          if(!r.ok)throw new Error("Authorized Jira read failed");return r.json();
        }});
        res.writeHead(response.status,{"Content-Type":"application/json","Cache-Control":"no-store"}).end(await response.text());return;
      }
      const response = await fetch(upstream + url.pathname.slice(4) + url.search, {
        method: req.method, headers,
        body: ["GET", "HEAD"].includes(req.method) ? undefined : Buffer.concat(chunks),
        redirect: "error", signal: AbortSignal.timeout(60000)
      });
      const responseHeaders = { "Cache-Control": "no-store" };
      for (const name of ["content-type", "content-disposition"]) {
        if (response.headers.has(name)) responseHeaders[name] = response.headers.get(name);
      }
      if(url.pathname==="/api/config"&&response.ok){const cfg=await response.json();cfg.ai={enabled:aiConfigured(process.env),readOnly:true};res.writeHead(response.status,responseHeaders).end(JSON.stringify(cfg));}
      else res.writeHead(response.status, responseHeaders).end(Buffer.from(await response.arrayBuffer()));
      return;
    }
    if (!["GET", "HEAD"].includes(req.method)) { res.writeHead(405).end(); return; }
    if (url.pathname === "/assets/config.js") {
      res.writeHead(200, { "Content-Type": types[".js"], "Cache-Control": "no-store" })
        .end('window.AIONE_API = location.origin + "/api";\n');
      return;
    }
    const pathname = decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname);
    const path = resolve(root, "." + pathname);
    if (!path.startsWith(root + sep)) { res.writeHead(403).end(); return; }
    let body;
    try { body = await readFile(path); } catch { res.writeHead(404).end(); return; }
    res.writeHead(200, { "Content-Type": types[extname(path)] || "application/octet-stream", "Cache-Control": "no-store" })
      .end(req.method === "HEAD" ? undefined : body);
  } catch {
    res.writeHead(502, { "Content-Type": "application/json", "Cache-Control": "no-store" })
      .end(JSON.stringify({ code: "network", error: "The local server could not reach the AION API." }));
  }
}).listen(port, "127.0.0.1", () => console.log(`AION local preview: http://localhost:${port}\nSign in with your existing account. Ticket saves use the deployed API.`));
