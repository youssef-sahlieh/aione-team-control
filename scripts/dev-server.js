// Local frontend preview using the deployed authenticated API. No Jira secrets
// are needed locally, and the upstream proxy still enforces every permission.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve, sep, extname } from "node:path";
import { aiChat, aiBrief, aiConfigured } from "../proxy/src/ai.js";

const root = resolve("public");
const port = Number(process.env.PORT || 3000);
const upstreamOrigin = "https://aione-team-proxy.vercel.app";
const upstream = upstreamOrigin + "/api";
const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8" };

createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://localhost");
    res.setHeader("X-Frame-Options","DENY");res.setHeader("X-Content-Type-Options","nosniff");res.setHeader("Referrer-Policy","strict-origin-when-cross-origin");
    res.setHeader("Content-Security-Policy","default-src 'self'; script-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; form-action 'none'; base-uri 'self'; frame-ancestors 'none'; object-src 'none'");
    if (url.pathname.startsWith("/api/")) {
      if(!["GET","HEAD","OPTIONS"].includes(req.method)&&req.headers.origin!=="http://"+req.headers.host){res.writeHead(403,{"Content-Type":"application/json"}).end(JSON.stringify({code:"csrf",error:"Invalid local request origin."}));return;}
      const chunks = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 5 * 1024 * 1024) { res.writeHead(413).end(); return; }
        chunks.push(chunk);
      }
      const headers = {};
      for (const name of ["content-type","x-aion-csrf"]) {
        if (req.headers[name]) headers[name] = req.headers[name];
      }
      headers.Origin=upstreamOrigin;
      if(req.headers.cookie)headers.Cookie=req.headers.cookie.replace(/(?:^|;\s*)aion-session=/g,match=>match.replace("aion-session=","__Host-aion-session="));
      if(url.pathname.startsWith("/api/ai/")){
        const session=await fetch(upstream+"/session",{headers,redirect:"error",signal:AbortSignal.timeout(15000)});
        if(!session.ok){res.writeHead(session.status,{"Content-Type":"application/json","Cache-Control":"no-store"}).end(await session.text());return;}
        const sessionInfo=await session.json();
        if(!sessionInfo.csrf||headers["x-aion-csrf"]!==sessionInfo.csrf){res.writeHead(403,{"Content-Type":"application/json"}).end(JSON.stringify({code:"csrf",error:"Refresh your session and try again."}));return;}
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
      const cookies=response.headers.getSetCookie();
      if(cookies.length)responseHeaders["Set-Cookie"]=cookies.map(cookie=>cookie.replace("__Host-aion-session=","aion-session=").replace(/;\s*Secure\b/gi,""));
      if(url.pathname==="/api/config"&&response.ok){const cfg=await response.json();cfg.ai={enabled:aiConfigured(process.env),readOnly:true};res.writeHead(response.status,responseHeaders).end(JSON.stringify(cfg));}
      else res.writeHead(response.status, responseHeaders).end(Buffer.from(await response.arrayBuffer()));
      return;
    }
    if (!["GET", "HEAD"].includes(req.method)) { res.writeHead(405).end(); return; }
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
