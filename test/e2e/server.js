// Serves only public files on loopback. No production proxy runs here.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve, extname, sep } from "node:path";
import handler from "../../proxy/src/handler.js";
import {memoryStore,saveUser,hashPassword} from "../../proxy/src/users.js";
import {jiraIssue,people} from "../fixtures/issues.js";
const hosting=JSON.parse(await readFile(new URL("../../vercel.json",import.meta.url),"utf8"));
const env={COOKIE_SESSIONS:true,STORE:memoryStore(),SESSION_SECRET:"synthetic-browser-session-secret",ALLOWED_ORIGIN:"http://127.0.0.1:4173",JIRA_PROJECT:"AION",JIRA_SITE:"https://jira.example.invalid",JIRA_EMAIL:"synthetic@invalid",JIRA_API_TOKEN:"synthetic",TEAM_CONFIG:JSON.stringify({people})};
await saveUser(env.STORE,{email:"security@example.invalid",name:"Security test",role:"admin",v:1,pw:await hashPassword("synthetic-browser-password")});
// Every backend read in this server is synthetic. Never forward to live Jira or email.
globalThis.fetch=async(url,options)=>{if(!String(url).startsWith(env.JIRA_SITE))throw new Error("External access blocked in browser tests");if(String(url).includes("search/jql")){const query=JSON.parse(options.body);return Response.json({issues:query.jql.includes("statusCategory = Done")?[]:[jiraIssue],isLast:true});}return Response.json({transitions:[],changelog:{histories:[]}});};
const root = resolve("public");
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };
createServer(async (req, res) => {
  for(const header of hosting.headers[0].headers)res.setHeader(header.key,header.value);
  try {
    const url=new URL(req.url,"http://127.0.0.1:4173");
    if(url.pathname.startsWith("/api/")){
      const chunks=[];for await(const chunk of req)chunks.push(chunk);
      const target=new URL(url);target.pathname=target.pathname.slice(4);
      const response=await handler.fetch(new Request(target,{method:req.method,headers:req.headers,body:["GET","HEAD"].includes(req.method)?undefined:Buffer.concat(chunks)}),env);
      response.headers.forEach((value,name)=>res.setHeader(name,value));res.writeHead(response.status).end(await response.text());return;
    }
    const pathname = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
    const path = resolve(root, "." + (pathname === "/" ? "/index.html" : pathname));
    if (!path.startsWith(root + sep)) { res.writeHead(403).end(); return; }
    const body = await readFile(path);
    res.writeHead(200, { "Content-Type": types[extname(path)] || "application/octet-stream" }).end(body);
  } catch { res.writeHead(404).end(); }
}).listen(4173, "127.0.0.1");
