// AION Team Control dashboard. Jira data comes through the AION proxy (worker/), which checks the
// sign-in and holds the Jira token. Team details (people, developers, emails) come from the proxy too,
// so they aren't in this public code.
import { createTicketBusiness } from "./components/ticket-business.js";
import { previewFile, canPreview } from "./components/file-preview.js";
import { INTERNAL_ASSIGNEE, sortTickets, validSort, createdDate } from "./models/ticket-business.js";
import { api, apiFile, getSession, signOut, onApiWrite } from "./session.js";
import { createSyncErrors } from "./components/sync-errors.js";
import { createWorkLog } from "./components/work-log.js";
import { isDevLabel, devOf, labelsWith, withRendered, normalizeJiraIssue, normalizeInternalIssue, normalizeOdooIssue } from "./models/issue.js";
import { createFilters, matchesFilters } from "./models/filters.js";
import { readViews, restoreView, savedViewKey, serializeView } from "./models/saved-views.js";
import { createWorkspace } from "./app/workspace.js";
import { createIssueDrawer } from "./components/issue-drawer.js";
import { defaultAssigneeKeys, assigneeOptions, assigneeFilterKey } from "./models/assignees.js";
import { createAIAssistant } from "./ai-assistant.js";
import { createAssigneeFilter } from "./components/assignee-filter.js";
import { createTicketBriefs } from "./components/ticket-briefs.js";
import { createTicketHistory } from "./components/ticket-history.js";
import { createDueDateHistory } from "./components/due-date-history.js";
import { createTicketNotes } from "./components/ticket-notes.js";
import { createDateRequests } from "./components/date-requests.js";
import { createCommentMentions } from "./components/comment-mentions.js";

  // The dashboard keeps loading after the page itself has loaded; the browser's own scroll restore could then
  // move you while you scroll, so it is off (redraws keep your place, see render).
  try{ history.scrollRestoration="manual"; }catch(_){}
  // Filled in from the proxy's /config after sign-in (see applyConfig).
  let SITE="", PROJECT="", PEOPLE={}, DEVS=[], DEV_EMAIL={}, DEV_COLOR={}, BYID={}, JQL="", ME="", MAIL=false;
  // Administrators see and change everything. Users see only the tickets labelled ai1_<MY_DEV> (the proxy
  // enforces this) and can move status, set due dates and comment.
  let IS_ADMIN=true, MY_DEV="", MY_EMAIL="";
  let notifyOn=true; try{ notifyOn=localStorage.getItem("aion.notify")!=="0"; }catch(e){}
  const devK=d=>DEV_COLOR[d]||("k"+(1+[...d].reduce((a,c)=>a+c.charCodeAt(0),0)%8));
  const STATUS_ORDER=["open","pending approval","dev approved","in development","on hold","reopened","pending qa","in qa","done review","resolved","closed"];
  const stIdx=s=>{ const i=STATUS_ORDER.indexOf(s.toLowerCase()); return i<0?99:i; };
  const FIELDS=["summary","status","assignee","labels","duedate","created","updated","priority","issuetype","comment","parent","reporter"];
  function applyConfig(cfg){
    LAST_CFG=cfg; GITHUB=!!cfg.github;
    SITE=cfg.site; PROJECT=cfg.project; MAIL=!!cfg.mail; PEOPLE=cfg.people||{}; DEVS=cfg.devs||[]; DEV_EMAIL=cfg.devEmails||{}; DEV_COLOR=cfg.devColors||{};
    PEOPLE={...PEOPLE,[INTERNAL_ASSIGNEE]:{name:"Internal Tickets",ini:"IT",id:INTERNAL_ASSIGNEE}};
    BYID={}; for(const k in PEOPLE) BYID[PEOPLE[k].id]=k;
    IS_ADMIN=cfg.role!=="user"; MY_DEV=cfg.dev||""; MY_EMAIL=cfg.email||""; INTERNAL=!!cfg.accounts; ODOO=!!cfg.odoo; $("monitor-link").hidden=!ODOO; { const dl=$("dbreport-link"); if(dl) dl.hidden=!cfg.dbReport; } $("new-int").hidden=!INTERNAL;
    const filtersKey="aion.ticket-filters.open."+encodeURIComponent(MY_EMAIL);
    if(ticketFiltersKey!==filtersKey){ticketFiltersKey=filtersKey;ticketFiltersOpen=false;try{ticketFiltersOpen=localStorage.getItem(ticketFiltersKey)==="1";}catch{}}
    document.body.classList.toggle("role-user",!IS_ADMIN);
    $("users-link").hidden=!(IS_ADMIN&&cfg.accounts);
    if(IS_ADMIN){
      JQL='project = '+PROJECT+' AND issuetype != Epic AND (statusCategory != Done OR updated >= -30d) ORDER BY updated DESC';
      $("team").textContent=Object.values(PEOPLE).map(p=>p.name).join(" · ");
    } else {
      // The proxy scopes users by their ai1_ label; assignees are a view filter.
      JQL='project = '+PROJECT+' AND issuetype != Epic AND (statusCategory != Done OR updated >= -30d) ORDER BY updated DESC';
      $("team").textContent="Your tickets";
      if(state.view==="dev"||state.view==="assignee"||state.view==="history") state.view="list";
      notifyOn=false;
    }
    if(state.view==="history")state.view="list";
    if(state.focus==="duechg")state.focus="open";
    state.f=defaultFilters();
    try{state.columnsMode=localStorage.getItem("aion.columns."+encodeURIComponent(MY_EMAIL))==="all"?"all":"work";}catch{state.columnsMode="work";}
    try{const sort=JSON.parse(localStorage.getItem("aion.sort."+encodeURIComponent(MY_EMAIL))||"null");state.sort=validSort(sort,IS_ADMIN)?sort:null;}catch{}
    aiAssistant.configure(cfg);
    ticketBriefs.configure(cfg);
  }
  // Both roles start with the named team; Others is an explicit opt-in.
  function defaultFilters(){ const f=F(); defaultAssigneeKeys(PEOPLE).forEach(k=>f.assignee.add(k)); return f; }
  const teamNames=()=>{ const n=Object.values(PEOPLE).map(p=>p.name); return n.length>1?n.slice(0,-1).join(", ")+" or "+n[n.length-1]:n.join(""); };
  let lastLoad=0;
  const NEW_STATUSES=["open","pending approval"];
  const HIST={};

  // Jira actions, all through the proxy.
  const jira={
    search:(jql,fields,nextPageToken,slim)=>api("/jira/search",{method:"POST",body:{jql,fields,maxResults:100,nextPageToken,slim:!!slim}}),
    // extra.assigneeName goes to the ticket's local history (who was assigned, by name).
    edit:(key,fields,extra)=>api("/jira/issue/"+key,{method:"PUT",body:{fields,...extra}}),
    transitions:key=>api("/jira/issue/"+key+"/transitions"),
    transition:(key,id)=>api("/jira/issue/"+key+"/transitions",{method:"POST",body:{id}}),
    comment:(key,text)=>api("/jira/issue/"+key+"/comment",{method:"POST",body:{text}}),
    changelog:key=>api("/jira/issue/"+key+"/changelog"),
    users:q=>api("/jira/users?q="+encodeURIComponent(q))
  };
  // Internal tickets (INT-…): kept by the proxy, never in Jira. They're shown with every Jira ticket and
  // every action below goes to the right place for each kind.
  let INTERNAL=false, INT={}, INT_STATUSES=[{name:"Open",cat:"new"},{name:"In Development",cat:"indeterminate"},{name:"On Hold",cat:"indeterminate"},{name:"Closed",cat:"done"}], INT_PRIORITIES=["Highest","High","Medium","Low"];
  const internalApi={
    list:()=>api("/internal"),
    create:b=>api("/internal",{method:"POST",body:b}),
    update:(key,b)=>api("/internal/"+key,{method:"PUT",body:b}),
    comment:(key,text)=>api("/internal/"+key+"/comment",{method:"POST",body:{text}}),
    remove:key=>api("/internal/"+key,{method:"DELETE"})
  };
  const isInt=key=>/^INT-\d+$/.test(key);
  // Links in emails open the ticket using the saved sign-in; Jira tickets also get their Jira link.
  const dashUrl=key=>location.origin+location.pathname+"#"+key;
  const ticketUrl=key=>isInt(key)?dashUrl(key):isOdoo(key)?((issueByKey(key)||{}).odooUrl||dashUrl(key)):SITE+"/browse/"+key;
  const sourceName=key=>isOdoo(key)?"Odoo":"Jira";
  async function setDevs(key,want){ const i=issueByKey(key); if(isOdoo(key)) return odooApi.update(key,{devs:[...want]});if(IS_ADMIN)await business.ensureBilling(key); return isInt(key)?internalApi.update(key,{devs:[...want]}):jira.edit(key,{labels:labelsWith(i?i.labels:[],want)}); }
  const doTransition=async(key,id)=>{
    if(isOdoo(key))return odooApi.update(key,{stage:id}).then(r=>{delete ODOO_DETAIL[key];return r;});
    await businessReady; if(!business.enabled())throw new Error("Deploy the updated backend before changing ticket status.");
    if(business.dirty(key))throw new Error("Save the ticket work fields before changing status.");
    const move=reason=>isInt(key)?internalApi.update(key,{status:id,...(reason?{overrideReason:reason}:{})}):api("/jira/issue/"+key+"/transitions",{method:"POST",body:{id,...(reason?{overrideReason:reason}:{})}});
    try{return await move();}catch(err){const reason=await business.overrideReason(err,key);if(reason)return move(reason);throw err;}
  };
  const doComment=(key,text)=>isOdoo(key)?odooApi.note(key,text).then(r=>{delete ODOO_DETAIL[key];return r;}):isInt(key)?internalApi.comment(key,text):jira.comment(key,text);
  // Same shape as a Jira ticket after norm(), so tiles, filters, boards and history all work unchanged.
  const normInternal=t=>normalizeInternalIssue(t,PEOPLE);
  // Odoo Helpdesk tickets (HD-…): read from Odoo through the proxy; stage, developer and notes are saved back to Odoo.
  let ODOO=false; const ODOO_DETAIL={};
  const isOdoo=key=>/^HD-[0-9]+$/.test(key);
  // Pull requests in the product repositories that mention a ticket (matched by the proxy).
  let GITHUB=false, PR_CHECKS=true, PR_ERROR=""; const PRS={};
  // What needs attention on a PR: checks, reviews and comments ([class, short text, full text]).
  function prSignals(p){
    const s=p.status, out=[]; if(!s) return out;
    if(s.checks==="FAILURE"||s.checks==="ERROR") out.push(["bad","✗ checks","Checks failed"+(s.failed&&s.failed.length?": "+s.failed.join(", "):"")]);
    else if(s.checks==="PENDING"||s.checks==="EXPECTED") out.push(["wait","● checks","Checks running"+(s.running?" ("+s.running+")":"")]);
    else if(s.checks==="SUCCESS") out.push(["ok","✓ checks","Checks passed"]);
    const by=st=>(s.reviews||[]).filter(r=>r.state===st).map(r=>r.by);
    if(s.decision==="CHANGES_REQUESTED") out.push(["bad","✎ changes","Changes requested by "+(by("CHANGES_REQUESTED").join(", ")||"a reviewer")]);
    else if(s.decision==="APPROVED") out.push(["ok","✔ approved","Approved by "+(by("APPROVED").join(", ")||"a reviewer")]);
    else if(s.requested&&s.requested.length) out.push(["wait","👤 "+s.requested.length,"Waiting for review: "+s.requested.join(", ")]);
    else if(s.decision==="REVIEW_REQUIRED") out.push(["wait","👤 review","Review required"]);
    if(s.comments) out.push([s.unresolved?"wait":"","💬 "+s.comments,s.comments+" comment"+(s.comments===1?"":"s")+(s.unresolved?" · "+s.unresolved+" unresolved thread"+(s.unresolved===1?"":"s"):"")]);
    return out;
  }
  function prLink(p,text){ const a=el("a","pr-num pr-"+p.state,text); a.href=p.url; a.target="_blank"; a.rel="noopener"; a.addEventListener("click",e=>e.stopPropagation()); return a; }
  // Table cell: each PR's number (linked), state and what needs attention.
  function prCell(i){
    const c=el("span","c-prs pr-cell"), list=PRS[i.key];
    if(isInt(i.key)||isOdoo(i.key)){ c.textContent=""; return c; }
    if(!list){ if(PR_ERROR){ const e=el("span","pr-none pr-err","can't load"); e.title=PR_ERROR; c.appendChild(e); } else c.appendChild(el("span","pr-none","…")); return c; }
    if(!list.length){ c.appendChild(el("span","pr-none","—")); return c; }
    list.slice(0,3).forEach(p=>{ const line=el("div","pr-line"); const a=prLink(p,"#"+p.number); a.title=p.repo+" #"+p.number+" · "+p.state+" · "+p.title; line.appendChild(a);
      line.appendChild(el("span","pr-st pr-"+p.state,p.state));
      prSignals(p).forEach(([k,t,full])=>{ const b=el("span","pr-sig "+k,t); b.title=full; line.appendChild(b); }); c.appendChild(line); });
    if(list.length>3){ const more=el("span","pr-none","+"+(list.length-3)+" more"); more.title=list.slice(3).map(p=>p.repo+" #"+p.number+" · "+p.state).join("\n"); c.appendChild(more); }
    return c;
  }
  const prState=list=>list.some(p=>p.state==="open")?"open":list.some(p=>p.state==="draft")?"draft":list.every(p=>p.state==="merged")?"merged":"closed";
  async function loadPrs(keys,refresh){
    keys=[...new Set(keys)].filter(k=>!isInt(k)&&!isOdoo(k)); if(!GITHUB||!keys.length) return;
    try{
      for(let n=0;n<keys.length;n+=300){ const part=keys.slice(n,n+300); const r=await api("/github/prs?keys="+encodeURIComponent(part.join(","))+(refresh?"&refresh=1":"")); part.forEach(k=>{ PRS[k]=(r.prs&&r.prs[k])||[]; }); if(r.checks===false) PR_CHECKS=false; }
      PR_ERROR=""; if($("pop").hidden&&!drag) render(); if(dz.key&&keys.includes(dz.key)) renderPrs(dz.key);
    }catch(err){ const first=!PR_ERROR; PR_ERROR=err.message||errorText(err); if(first){ toast("Pull requests can't be loaded",[PR_ERROR,"An administrator can check the GitHub token on the Sync errors page."],true); renderIfIdle(); } if(dz.key&&keys.includes(dz.key)) renderPrs(dz.key,PR_ERROR); }
  }
  function renderPrs(key,problem){
    const blk=$("d-prs-blk"), box=$("d-prs"); blk.hidden=!GITHUB||isInt(key)||isOdoo(key); if(blk.hidden) return;
    box.replaceChildren(); const list=PRS[key];
    if(problem){ box.appendChild(el("span","msg err","Couldn't load pull requests: "+problem)); return; }
    if(!list){ $("d-prs-count").textContent=""; box.appendChild(el("span","msg","Looking for pull requests…")); loadPrs([key]); return; }
    $("d-prs-count").textContent="("+list.length+")";
    if(!PR_CHECKS&&list.length) box.appendChild(el("p","msg","Check results aren't shown: the GitHub token needs read access to Checks and Commit statuses."));
    if(!list.length){ box.appendChild(el("span","msg","No pull request mentions "+key+" yet. Put "+key+" in the PR title, branch or the release note's Jira line.")); return; }
    list.forEach(p=>{
      const row=el("div","pr-row"), a=el("a","pr-link",p.repo+" #"+p.number); a.href=p.url; a.target="_blank"; a.rel="noopener";
      const t=el("span","pr-title",p.title); t.dir="auto";
      const meta=el("span","pr-meta",(p.author?p.author+" · ":"")+(p.branch&&p.base?p.branch+" → "+p.base+" · ":"")+(p.merged?"merged "+ago(p.merged):"updated "+ago(p.updated)));
      row.append(el("span","pr-state pr-"+p.state,p.state),a,t,meta);
      const sig=prSignals(p); if(sig.length){ const line=el("div","pr-signals"); sig.forEach(([k,,full])=>line.appendChild(el("span","pr-sig "+k,full))); row.appendChild(line); }
      box.appendChild(row);
    });
  }
  const odooApi={
    list:days=>api("/odoo/tickets?closedDays="+days),
    detail:key=>api("/odoo/tickets/"+key),
    update:(key,b)=>api("/odoo/tickets/"+key,{method:"PUT",body:b}),
    note:(key,text)=>api("/odoo/tickets/"+key+"/note",{method:"POST",body:{text}})
  };
  async function loadOdoo(){
    if(!ODOO) return;
    try{ const r=await odooApi.list(state.closedDays); state.odooIssues=r.tickets.map(normalizeOdooIssue); }
    catch(err){ toast("Couldn't load Odoo tickets",[errorText(err)],true); }
  }
  async function odooDetail(key,fresh){ if(fresh||!ODOO_DETAIL[key]) ODOO_DETAIL[key]=await odooApi.detail(key); return ODOO_DETAIL[key]; }
  async function loadInternal(){
    if(!INTERNAL) return;
    try{
      const r=await internalApi.list(); INT={};
      if(r.statuses) INT_STATUSES=r.statuses; if(r.priorities) INT_PRIORITIES=r.priorities;
      r.tickets.forEach(t=>{ INT[t.key]=t; HIST[t.key]={updated:t.updated,changes:(t.dueHistory||[]).map(h=>({when:h.when,by:h.by,from:h.from,to:h.to}))}; });
      state.internalIssues=r.tickets.map(normInternal);
    }catch(err){ toast("Couldn't load internal tickets",[errorText(err)],true); }
  }
  // full=true for one ticket's details; lists get only each ticket's latest comment (much smaller and faster).
  async function searchAll(jql,fields,full){
    const slim=!full;
    let r=await jira.search(jql,fields,undefined,slim); let list=(r.issues||[]).slice(); const tokens=new Set();
    while(r.isLast===false&&r.nextPageToken){ if(tokens.has(r.nextPageToken))throw new Error("Jira repeated a pagination token.");tokens.add(r.nextPageToken);r=await jira.search(jql,fields,r.nextPageToken,slim);list=list.concat(r.issues||[]); }
    return list.map(withRendered);
  }
  const fmtWhen=iso=>{ try{ const d=new Date(iso); return {d:d.toLocaleDateString("en-GB",{day:"numeric",month:"short",year:"numeric",timeZone:"Asia/Jerusalem"}),t:d.toLocaleTimeString("en-GB",{hour:"2-digit",minute:"2-digit",timeZone:"Asia/Jerusalem"})}; }catch(e){ return {d:iso.slice(0,10),t:iso.slice(11,16)}; } };
  const dueChanges=k=>(HIST[k]&&HIST[k].changes)||[];

  const $=id=>document.getElementById(id);
  const el=(tag,cls,text)=>{const e=document.createElement(tag); if(cls) e.className=cls; if(text!=null) e.textContent=text; return e;};

  function todayStr(){ try{return new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Jerusalem",year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date());}catch(e){return new Date().toISOString().slice(0,10);} }
  const dayMs=86400000, dnum=s=>Date.parse(s+"T00:00:00Z")/dayMs;
  const fmtDate=s=>s?new Date(s+"T00:00:00Z").toLocaleDateString("en-GB",{day:"numeric",month:"short",timeZone:"UTC"}):"";
  function ago(iso){ if(!iso) return ""; const m=(Date.now()-new Date(iso))/60000;
    if(m<60) return Math.max(1,Math.round(m))+"m ago"; if(m<1440) return Math.round(m/60)+"h ago"; if(m<10080) return Math.round(m/1440)+"d ago";
    return new Date(iso).toLocaleDateString("en-GB",{day:"numeric",month:"short"}); }
  const ALLOWED=new Set(["P","BR","STRONG","B","EM","I","U","S","DEL","UL","OL","LI","A","H1","H2","H3","H4","H5","H6","CODE","PRE","BLOCKQUOTE","TABLE","THEAD","TBODY","TR","TD","TH","HR"]);
  // Jira's HTML carries inline styles; drop them before parsing (they're never shown, and the page's security policy reports each one).
  const noStyles=h=>String(h||"").replace(/<style[\s\S]*?<\/style>/gi,"").replace(/\sstyle\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi,"");
  const toText=h=>(new DOMParser().parseFromString(noStyles(h),"text/html").body.textContent||"").replace(/\s+/g," ").trim();
  // Pictures in a Jira description or comment are the ticket's own attachments: they load through the proxy
  // (which checks the ticket is yours) and show in place; a click opens the large preview. ctx = {key, attachments}.
  const IMAGES=new Map();
  function attachmentFor(n,ctx){
    if(!ctx||!ctx.key||!(ctx.attachments||[]).length) return null;
    const src=n.getAttribute("src")||"", id=(/\/(?:attachment\/content|secure\/(?:attachment|thumbnail))\/(\d+)/.exec(src)||[])[1];
    const name=n.getAttribute("data-alt")||n.getAttribute("alt")||decodeURIComponent((src.split("?")[0].split("/").pop())||"");
    return ctx.attachments.find(a=>String(a.id)===id)||ctx.attachments.find(a=>name&&a.filename===name)||null;
  }
  function inlineImage(a,key){
    const base=isInt(key)?"/internal/":"/jira/issue/";
    const box=el("button","cimg"); box.type="button"; box.title="Open "+a.filename; box.setAttribute("aria-label","Open image "+a.filename);
    const img=el("img"); img.alt=a.filename; img.loading="lazy"; box.appendChild(img);
    const load=()=>apiFile(base+key+"/attachments/"+a.id);
    const id=key+"/"+a.id;
    (IMAGES.get(id)||(IMAGES.set(id,load().then(r=>r.blob()).then(b=>URL.createObjectURL(b))),IMAGES.get(id)))
      .then(url=>{img.src=url;}).catch(()=>{IMAGES.delete(id);box.replaceWith(el("span","att","image: "+a.filename));});
    if(IMAGES.size>80){const first=IMAGES.keys().next().value;IMAGES.get(first).then(u=>URL.revokeObjectURL(u)).catch(()=>{});IMAGES.delete(first);}
    box.addEventListener("click",()=>previewFile({name:a.filename,type:a.mimeType,load}));
    return box;
  }
  const isImage=a=>/^image\//.test(a.mimeType||"")||/\.(png|jpe?g|gif|webp|bmp)$/i.test(a.filename||"");
  function richNode(body,ctx){
    const box=el("div"); const s=String(body||"").trim();
    if(!s){ const e=el("span",null,"No text."); e.style.color="var(--muted)"; box.appendChild(e); return box; }
    if(!/^</.test(s)){ box.className="plain"; box.textContent=s; return box; }
    const doc=new DOMParser().parseFromString(noStyles(s),"text/html");
    (function walk(src,dst){ src.childNodes.forEach(n=>{
      if(n.nodeType===3){ dst.appendChild(document.createTextNode(n.nodeValue)); return; }
      if(n.nodeType!==1) return; const t=n.tagName;
      if(n.getAttribute("data-type")==="media"){ const a=attachmentFor(n,ctx); if(a&&isImage(a)){ dst.appendChild(inlineImage(a,ctx.key)); return; } dst.appendChild(el("span","att","attachment"+(n.getAttribute("data-alt")?": "+n.getAttribute("data-alt"):""))); return; }
      if(t==="SCRIPT"||t==="STYLE"||t==="IFRAME") return;
      if(t==="IMG"){ const a=attachmentFor(n,ctx); dst.appendChild(a&&isImage(a)?inlineImage(a,ctx.key):el("span","att","image")); return; }
      if(ALLOWED.has(t)){ const c=document.createElement(t); if(t==="A"){ const h=n.getAttribute("href")||""; if(/^https?:\/\//i.test(h)){ c.href=h; c.target="_blank"; c.rel="noopener"; } } dst.appendChild(c); walk(n,c); }
      else walk(n,dst);
    }); })(doc.body,box);
    return box;
  }

  const norm=raw=>normalizeJiraIssue(raw,BYID,toText);
  const isNew=i=>NEW_STATUSES.includes(i.status.toLowerCase());
  const stK=i=>{ const s=(i.status||"").toLowerCase(); if(i.cat==="done"||s==="resolved"||s==="closed") return "k7"; if(s==="open") return "k1"; if(s==="pending approval") return "k4"; if(s==="dev approved") return "k5"; if(s==="in development") return "k3"; if(s==="on hold") return "k8"; if(s.includes("qa")) return "k6"; if(s==="reopened") return "k2"; return "k8"; };
  const issueByKey=k=>(state.issues||[]).find(i=>i.key===k);
  const allDevs=()=>{ const s=new Set(DEVS); (state.issues||[]).forEach(i=>i.devs.forEach(d=>s.add(d))); return [...s].sort(); };
  const needsReply=i=>i.last&&!i.last.fromTeam&&Date.parse(i.updated)>=Date.now()-(typeof state!=="undefined"?state.updDays:3)*dayMs;

  const F=createFilters;
  const state={issues:null,focus:"open",f:F(),q:"",view:"list",group:"",sel:new Set(),fopen:false,hperiod:7,updDays:3,dueDays:7,closedDays:30,mainIssues:[],closedIssues:[],internalIssues:[],odooIssues:[],pageIndex:0,pageSize:25};
  try{ const u=+localStorage.getItem("aion.upd"), d=+localStorage.getItem("aion.due"); if(u>=1&&u<=30) state.updDays=u; if(d>=1&&d<=90) state.dueDays=d; const cd=+localStorage.getItem("aion.closed"); if(cd>=1&&cd<=365) state.closedDays=cd; }catch(e){}
  try{ const v=localStorage.getItem("aion.view"); if(v) state.view=v; state.fopen=localStorage.getItem("aion.fopen")==="1"; const gg=localStorage.getItem("aion.group"); if(gg!==null) state.group=gg; }catch(e){}

  let ticketFiltersOpen=false;
  let ticketFiltersKey="";

  const FOCUS=[
    {id:"open",k:"k1",l:"All open",h:"Everything not done",f:i=>i.cat!=="done"},
    {id:"nodev",k:"k2",l:"No developer",h:"Waiting for a developer",f:i=>i.cat!=="done"&&!i.devs.length},
    {id:"reply",k:"k6",l:"Needs a reply",h:"Last comment from outside",f:i=>i.cat!=="done"&&needsReply(i)},
    // Odoo Helpdesk tickets don't use due dates here: never overdue, due today or missing a due date.
    {id:"overdue",k:"k2",l:"Overdue",h:"Due date passed",f:(i,t)=>i.cat!=="done"&&!i.odoo&&i.due&&i.due<t},
    {id:"today",k:"k3",l:"Due today",h:"Finish by end of day",f:(i,t)=>i.cat!=="done"&&!i.odoo&&i.due===t},
    // Internal tickets never wait for approval; only Jira (and Odoo) tickets show here.
    {id:"approval",k:"k4",l:"Waiting approval",h:"Open · Pending Approval",f:i=>i.cat!=="done"&&isNew(i)&&!i.internal},
    {id:"nodue",k:"k5",l:"No due date",h:"Open, no date set",f:i=>i.cat!=="done"&&!i.odoo&&!i.due},
    {id:"recent",k:"k7",l:"Updated",range:"updDays",max:30,h:"Recent activity",f:i=>i.cat!=="done"&&Date.parse(i.updated)>=Date.now()-state.updDays*dayMs},
    {id:"datereq",k:"k3",l:"Date request pending",h:"Awaiting an admin decision",f:i=>!!dateRequests.activeFor(i.key)},
    {id:"closed",k:"k8",l:"Closed",range:"closedDays",max:365,step:7,h:"All closed AION tickets",f:i=>i.cat==="done"&&Date.parse(i.updated)>=Date.now()-state.closedDays*dayMs}
  ];
  const DUE_OPTS=[["any","Any"],["overdue","Overdue"],["today","Today"],["week","Next 7 days"],["later","Later"],["none","No date"],["pending","Pending date request"]];
  const ACT_OPTS=[["any","Any"],["reply","Needs reply"],["new3","Opened ≤ 3 days"],["upd1","Updated today"]];

  function passFilters(i,t,skip){
    const filters=IS_ADMIN&&workspace.route().page==="internal"?{...state.f,source:"internal"}:state.f;
    return business.matches(i,state.businessFilter)&&matchesFilters(i,t,{filters,query:state.q,needsReply,assigneeKey:i=>assigneeFilterKey(i,PEOPLE)},skip);
  }
  const focusDef=()=>FOCUS.find(x=>x.id===state.focus)||FOCUS[0];
  function visible(skip){ const t=todayStr(), fd=focusDef(); return (state.issues||[]).filter(i=>fd.f(i,t)&&passFilters(i,t,skip)); }
  function filterCount(){ const f=state.f; return Object.values(state.businessFilter||{}).filter(Boolean).length+ f.reporter.size+f.assignee.size+f.dev.size+f.status.size+f.type.size+f.priority.size+(f.epic?1:0)+(f.due!=="any"?1:0)+(f.activity!=="any"?1:0)+(f.source!=="all"&&workspace.route().page!=="internal"?1:0)+(state.q?1:0); }
  const showTicketBriefs=()=>ticketBriefs.enabled()&&workspace.route().page!=="internal";

  function renderQuickFilters(){
    const box=$("quick-filters"), more=$("ftoggle"); box.replaceChildren();
    const pick=(label,options,value,onChange)=>{ const field=el("label","quick-field"), select=el("select"); field.appendChild(el("span",null,label)); select.setAttribute("aria-label",label); options.forEach(([v,l])=>select.appendChild(new Option(l,v))); if(value==="__multiple"){const o=new Option("Multiple selected",value);o.disabled=true;select.appendChild(o);} select.value=value;select.addEventListener("change",()=>{onChange(select.value);state.sel.clear();state.pageIndex=0;render();});field.appendChild(select);box.appendChild(field);return select;};
    const val=set=>set.size>1?"__multiple":[...set][0]||"";
    box.appendChild(assigneeFilter.renderButton());
    if(workspace.route().page!=="internal")pick("Ticket source",[["all","All tickets"],["internal","Internal tickets only"],["jira","Jira tickets only"],...(ODOO?[["odoo","Odoo Helpdesk only"]]:[])],state.f.source,v=>state.f.source=v);
    if(IS_ADMIN)pick("Developer",[["","All developers"],["__none","No developer"],...[...new Set([...allDevs(),...state.f.dev])].filter(d=>d!=="__none").sort().map(d=>[d,d])],val(state.f.dev),v=>state.f.dev=new Set(v?[v]:[]));
    if(IS_ADMIN)pick("Reporter",[["","All reporters"],...[...new Set([...(state.issues||[]).map(i=>i.reporter),...state.f.reporter])].filter(Boolean).sort((a,b)=>a.localeCompare(b)).map(x=>[x,x])],val(state.f.reporter),v=>state.f.reporter=new Set(v?[v]:[]));
    pick("Status",[["","All statuses"],...[...new Set([...(state.issues||[]).map(i=>i.status),...state.f.status])].sort((a,b)=>stIdx(a)-stIdx(b)).map(x=>[x,x])],val(state.f.status),v=>state.f.status=new Set(v?[v]:[]));
    if(IS_ADMIN)pick("Priority",[["","All priorities"],...[...new Set([...(state.issues||[]).map(i=>i.priority||"None"),...state.f.priority])].sort((a,b)=>a.localeCompare(b)).map(x=>[x,x])],val(state.f.priority),v=>state.f.priority=new Set(v?[v]:[]));
    pick("Due date",DUE_OPTS,state.f.due,v=>state.f.due=v);
    business.filters(box,state.businessFilter,()=>{state.pageIndex=0;render();});
    const moreField=el("div","quick-field more-filter-field");moreField.append(el("span",null,"Additional filters"),more);box.appendChild(moreField);
    moreField.hidden=!IS_ADMIN;more.hidden=!IS_ADMIN;
    if(!IS_ADMIN)return;
    let views=[]; try{views=readViews(localStorage,MY_EMAIL);}catch(_){}
    const savedField=pick("Saved view",[["","Saved views"],...views.map((v,n)=>[String(n),v.name])],"",v=>{ if(v==="")return; const restored=restoreView(views[+v],IS_ADMIN,PEOPLE);if(!restored)return;Object.assign(state,restored);$("q").value=state.q;workspace.navigate(state.view==="history"?"requests":["dev","status","assignee"].includes(state.view)?"boards":"tickets",{mode:state.view}); }).closest("label");
    const save=el("button","btn","Save view");save.type="button";save.addEventListener("click",()=>{ const name=prompt("Name this personal view:");if(!name||!name.trim())return;const view=serializeView(workspace.route().page==="internal"?{...state,f:{...state.f,source:"internal"}}:state,name);const updated=views.filter(v=>v.name!==view.name).concat(view).slice(-20);try{localStorage.setItem(savedViewKey(MY_EMAIL),JSON.stringify(updated));toast("View saved in this browser.");renderQuickFilters();}catch(_){toast("Couldn't save this view. Browser storage is unavailable.",[],true);} });box.appendChild(save);
    if(IS_ADMIN){$("fgrid").querySelector(".saved-view-tools")?.remove();const tools=el("div","saved-view-tools");tools.append(savedField,save);$("fgrid").appendChild(tools);}
  }

  function renderTiles(){
    const t=todayStr(), box=$("tiles"); box.replaceChildren();
    const primaryFocus=["open","overdue","today","closed"];
    let extra;
    if(IS_ADMIN&&workspace.route().page!=="tickets"){extra=el("details","focus-more");extra.id="manager-more-focus";extra.open=!!state.moreFocusOpen||!primaryFocus.includes(state.focus);extra.appendChild(el("summary","btn","More focus options"));extra.addEventListener("toggle",()=>{state.moreFocusOpen=extra.open;});}
    const base=(state.issues||[]).filter(i=>passFilters(i,t));
    FOCUS.forEach(fd=>{
      if((fd.id==="nodev"||fd.id==="duechg")&&!IS_ADMIN) return;
      const n=base.filter(i=>fd.f(i,t)).length;
      const b=el("button","tile "+fd.k); b.type="button"; b.setAttribute("aria-pressed",String(state.focus===fd.id));
      b.appendChild(el("span","n",String(n)));
      if(fd.range){ const v=state[fd.range]; b.appendChild(el("span","l",fd.l+" · last "+v+" day"+(v===1?"":"s")));
        const st=el("span","step"); const mk=(txt,delta,lbl)=>{ const x=el("span","stepb",txt); x.setAttribute("role","button"); x.tabIndex=0; x.setAttribute("aria-label",lbl);
          const go=e=>{ e.stopPropagation(); e.preventDefault(); const nv=Math.min(fd.max,Math.max(1,state[fd.range]+delta*(fd.step||1))); state[fd.range]=nv; try{localStorage.setItem(fd.range==="updDays"?"aion.upd":fd.range==="dueDays"?"aion.due":"aion.closed",String(nv));}catch(_){} if(fd.range==="closedDays") loadClosed(); render(); };
          x.addEventListener("click",go); x.addEventListener("keydown",e=>{ if(e.key==="Enter"||e.key===" ") go(e); }); return x; };
        st.appendChild(mk("−",-1,"Fewer days")); st.appendChild(el("span","stepv",v+"d")); st.appendChild(mk("+",1,"More days")); b.appendChild(st);
      } else { b.appendChild(el("span","l",fd.l)); b.appendChild(el("span","h",fd.h)); }
      b.addEventListener("click",()=>{ state.focus=fd.id; state.sel.clear(); render(); });
      if(extra&&!primaryFocus.includes(fd.id))extra.appendChild(b);else box.appendChild(b);
    });
    if(extra)box.appendChild(extra);
  }

  function section(title,k,anyFn){ const s=el("div","fsec "+k); const h=el("h4",null,title); if(anyFn){ const a=el("button","any","Any"); a.type="button"; a.setAttribute("aria-label","Reset "+title+" filter"); a.addEventListener("click",()=>{ anyFn(); state.sel.clear(); render(); }); h.appendChild(a); } s.appendChild(h); return s; }
  function chip(label,k,pressed,count,onClick,swatch,avatar){
    const c=el("button","fc "+k); c.type="button"; c.setAttribute("aria-pressed",String(pressed));
    if(avatar) c.appendChild(el("span","av "+k,avatar)); else if(swatch) c.appendChild(el("span","sw"));
    c.appendChild(el("span",null,label)); if(count!=null) c.appendChild(el("span","cnt",String(count)));
    c.addEventListener("click",onClick); return c;
  }
  function initials(n){ return String(n).split(/\s+/).filter(Boolean).slice(0,2).map(x=>x[0].toUpperCase()).join("")||"?"; }
  function toggleSet(set,v){ set.has(v)?set.delete(v):set.add(v); state.sel.clear(); render(); }
  function countBy(skip,fn){ const m={}; visible(skip).forEach(i=>{ [].concat(fn(i)).forEach(v=>{ m[v]=(m[v]||0)+1; }); }); return m; }

  function renderFilters(){
    const ticketsPage=workspace.route().page==="tickets",expanded=!ticketsPage||ticketFiltersOpen;
    $("ticket-filter-controls").hidden=!ticketsPage;$("ticket-filters").hidden=!expanded;
    $("ticket-filters-toggle").textContent=expanded?"Hide filters":"Show filters";$("ticket-filters-toggle").setAttribute("aria-expanded",String(expanded));
    $("ticket-filters-state").textContent=ticketsPage?(filterCount()?filterCount()+" active filters · ":"")+focusDef().l:"";
    const g=$("fgrid"); g.replaceChildren(); g.hidden=!IS_ADMIN||!state.fopen;
    $("ftoggle").textContent=state.fopen?"Hide more filters":"More filters"; $("ftoggle").setAttribute("aria-expanded",String(state.fopen));
    if(IS_ADMIN&&state.fopen){const help=el("p","filter-help","Select multiple options within a group to include either. Selections across groups are combined.");g.appendChild(help);}
    const f=state.f;
    const eps={};
    if(IS_ADMIN){
    let s=section("Assignee","k4",()=>f.assignee=new Set(defaultAssigneeKeys(PEOPLE))); let cs=el("div","chips");
    s.querySelector(".any").textContent="Default team";
    const ca=countBy("assignee",i=>assigneeFilterKey(i,PEOPLE));
    assigneeOptions(PEOPLE).forEach(([key,name])=>cs.appendChild(chip(name,"kp-"+key,f.assignee.has(key),ca[key]||0,()=>toggleSet(f.assignee,key),false,PEOPLE[key]?.ini||initials(name))));
    cs.appendChild(chip("Others","k8",f.assignee.has("other"),ca.other||0,()=>toggleSet(f.assignee,"other"),false,"+"));
    s.appendChild(cs); g.appendChild(s);

    s=section("Reporter","k6",()=>f.reporter.clear()); cs=el("div","chips");
    const cr=countBy("reporter",i=>i.reporter); const reps=new Set(Object.keys(cr)); f.reporter.forEach(x=>reps.add(x));
    [...reps].sort((a,b)=>(cr[b]||0)-(cr[a]||0)||a.localeCompare(b)).forEach(r=>cs.appendChild(chip(r,"k6",f.reporter.has(r),cr[r]||0,()=>toggleSet(f.reporter,r),false,initials(r))));
    s.appendChild(cs); g.appendChild(s);

    if(IS_ADMIN){
      s=section("Developer (ai1_)","k1",()=>f.dev.clear()); cs=el("div","chips");
      const cd=countBy("dev",i=>i.devs.length?i.devs:["__none"]);
      cs.appendChild(chip("No developer","k2",f.dev.has("__none"),cd["__none"]||0,()=>toggleSet(f.dev,"__none"),true));
      allDevs().forEach(d=>cs.appendChild(chip(d,devK(d),f.dev.has(d),cd[d]||0,()=>toggleSet(f.dev,d),true)));
      s.appendChild(cs); g.appendChild(s);
    }

    s=section("Status","k5",()=>f.status.clear()); cs=el("div","chips");
    const cst=countBy("status",i=>i.status); const sts=new Set(Object.keys(cst)); f.status.forEach(x=>sts.add(x));
    [...sts].sort((a,b)=>stIdx(a)-stIdx(b)||a.localeCompare(b)).forEach(st=>cs.appendChild(chip(st,stK({status:st,cat:""}),f.status.has(st),cst[st]||0,()=>toggleSet(f.status,st),true)));
    s.appendChild(cs); g.appendChild(s);

    s=section("Due date","k3",null); cs=el("div","chips");
    DUE_OPTS.forEach(([v,l])=>cs.appendChild(chip(l,v==="overdue"?"k2":"k3",f.due===v,null,()=>{ f.due=v; state.sel.clear(); render(); })));
    s.appendChild(cs); g.appendChild(s);

    s=section("Activity","k6",null); cs=el("div","chips");
    ACT_OPTS.forEach(([v,l])=>cs.appendChild(chip(l,"k6",f.activity===v,null,()=>{ f.activity=v; state.sel.clear(); render(); })));
    s.appendChild(cs); g.appendChild(s);

    s=section("Work type","k7",()=>f.type.clear()); cs=el("div","chips");
    const ct=countBy("type",i=>i.type); new Set([...Object.keys(ct),...f.type]).forEach(v=>{ if(v) cs.appendChild(chip(v,v==="Bug"?"k2":v==="Story"?"k7":"k1",f.type.has(v),ct[v]||0,()=>toggleSet(f.type,v),true)); });
    s.appendChild(cs); g.appendChild(s);

    s=section("Priority","k2",()=>f.priority.clear()); cs=el("div","chips");
    const cp=countBy("priority",i=>i.priority||"None"); new Set([...Object.keys(cp),...f.priority]).forEach(v=>cs.appendChild(chip(v,/high|critical|blocker|p1|p2/i.test(v)?"k2":/medium|p3/i.test(v)?"k3":"k8",f.priority.has(v),cp[v]||0,()=>toggleSet(f.priority,v),true)));
    s.appendChild(cs); g.appendChild(s);

    s=section("Epic (parent)","k8",null);
    const sel=el("select","fsel"); sel.setAttribute("aria-label","Epic");
    sel.appendChild(new Option("All epics","")); sel.appendChild(new Option("No epic","none"));
    (state.issues||[]).forEach(i=>{ if(i.parent) eps[i.parent.key]=i.parent.name; });
    Object.entries(eps).sort((a,b)=>a[1].localeCompare(b[1])).forEach(([k,n])=>sel.appendChild(new Option(n+" ("+k+")",k)));
    sel.value=f.epic; sel.addEventListener("change",()=>{ f.epic=sel.value; state.sel.clear(); render(); });
    s.appendChild(sel); g.appendChild(s);
    }

    const act=$("active"); act.replaceChildren();
    const addA=(label,k,rm)=>{ const c=el("span","achip "+k,label); const x=el("button",null,"✕"); x.type="button"; x.setAttribute("aria-label","Remove "+label); x.addEventListener("click",()=>{ rm(); state.sel.clear(); render(); }); c.appendChild(x); act.appendChild(c); };
    f.reporter.forEach(v=>addA("Reporter: "+v,"k6",()=>f.reporter.delete(v)));
    const defaults=defaultAssigneeKeys(PEOPLE);
    if(!IS_ADMIN&&f.assignee.size===defaults.length&&defaults.every(key=>f.assignee.has(key)))act.appendChild(el("span","filter-empty","Default team"));
    else f.assignee.forEach(v=>addA(assigneeOptions(PEOPLE).find(([key])=>key===v)?.[1]||(v==="other"?"Other assignees":v),"kp-"+v,()=>f.assignee.delete(v)));
    f.dev.forEach(v=>addA(v==="__none"?"No developer":"ai1_"+v,v==="__none"?"k2":devK(v),()=>f.dev.delete(v)));
    f.status.forEach(v=>addA(v,stK({status:v,cat:""}),()=>f.status.delete(v)));
    f.type.forEach(v=>addA(v,"k7",()=>f.type.delete(v)));
    f.priority.forEach(v=>addA(v,"k2",()=>f.priority.delete(v)));
    if(f.epic) addA(f.epic==="none"?"No epic":(eps[f.epic]||f.epic),"k8",()=>f.epic="");
    if(f.due!=="any") addA("Due: "+DUE_OPTS.find(x=>x[0]===f.due)[1],"k3",()=>f.due="any");
    if(f.activity!=="any") addA(ACT_OPTS.find(x=>x[0]===f.activity)[1],"k6",()=>f.activity="any");
    if(f.source!=="all"&&workspace.route().page!=="internal")addA(f.source==="internal"?"Internal tickets only":f.source==="odoo"?"Odoo Helpdesk only":"Jira tickets only","k7",()=>f.source="all");
    if(state.q) addA("“"+state.q+"”","k1",()=>{ state.q=""; $("q").value=""; });
    if(!act.childNodes.length) act.appendChild(el("span","filter-empty","All tickets in this focus"));
    const matches=visible().length;$("filter-summary").textContent=matches+" ticket"+(matches===1?"":"s")+" match · "+filterCount()+" selected";
    $("fclear").disabled=!filterCount();
    renderQuickFilters();
  }

  // Redraws keep your place on the page: a redraw that briefly makes the page shorter (lists emptied and
  // rebuilt) would otherwise send you back to the top while you scroll.
  function render(){
    const y=window.scrollY; renderNow();
    if(y&&Math.abs(window.scrollY-y)>1) window.scrollTo(0,Math.min(y,document.documentElement.scrollHeight-innerHeight));
  }
  // The list's width, measured before it is emptied (measuring an empty list makes the page jump up).
  let viewWidth=0;
  function renderNow(){
    if(!state.issues) return;
    if(!state.f.assignee.size) state.f.assignee=new Set(defaultAssigneeKeys(PEOPLE));
    // The proxy scopes developers by their authenticated ai1_ label. Do not
    // apply an invisible, editable developer filter on top of that scope.
    if(!IS_ADMIN){state.f.dev.clear();state.f.reporter.clear();state.f.priority.clear();state.f.type.clear();state.f.epic="";state.f.activity="any";}
    const t=todayStr(); $("today").textContent=fmtDate(t)+" "+t.slice(0,4);
    renderTiles(); renderFilters();
    if(workspace.renderPage()){ updateBulk(); return; }
    document.querySelectorAll(".seg [data-v]").forEach(b=>b.setAttribute("aria-pressed",String(b.dataset.v===state.view)));
    $("grpwrap").hidden=state.view!=="list"; $("grp").value=state.group||"";
    const items=visible(); const fd=focusDef();
    const keys=new Set(items.map(i=>i.key)); [...state.sel].forEach(k=>{ if(!keys.has(k)) state.sel.delete(k); });
    $("vtitle").textContent=fd.l; $("vcount").textContent=items.length+" ticket"+(items.length===1?"":"s")+(filterCount()?" · filtered":"");
    const hint=$("hint"); hint.hidden=state.view==="list"||state.view==="assignee";
    hint.textContent=state.view==="dev"?"Drag a card onto a developer to assign them. From one developer to another moves it; onto “No developer” removes that developer.":"Drag a card to another column to change its status. Jira only allows some moves; you'll see a message when one isn't allowed.";
    const v=$("view"); viewWidth=v.clientWidth; v.replaceChildren();
    if(!items.length){ const e=el("div","listwrap"); e.appendChild(el("div","empty","No tickets match. Pick another tile or clear some filters.")); v.appendChild(e); updateBulk(); return; }
    v.appendChild(state.view==="list"?listView(items,t):boardView(items,t,state.view));
    updateBulk();
  }

  // Sorting by pull requests: the most active one counts (open, draft, merged, closed); none sorts last.
  const PR_RANK={open:1,draft:2,merged:3,closed:4};
  const prRank=key=>{ const list=PRS[key]; if(!list||!list.length) return null; return Math.min(...list.map(p=>PR_RANK[p.state]||5)); };
  function sortItems(items){
    if(state.sort)return sortTickets(state.sort.field==="prs"?items.map(i=>({...i,prRank:prRank(i.key)})):items,state.sort,IS_ADMIN);
    const fd=state.focus;
    return items.slice().sort((a,b)=>{
      if(fd==="recent"||fd==="reply"||fd==="closed") return a.updated<b.updated?1:-1;
      if(fd==="approval"||fd==="nodev") return a.created<b.created?1:-1;
      const ad=a.due||"9999", bd=b.due||"9999"; return ad<bd?-1:ad>bd?1:(a.updated<b.updated?1:-1);
    });
  }

  function columnSortMenu(anchor,field){
    const p=$('pop');p.replaceChildren(el('h4',null,'Sort column'));p.setAttribute('role','menu');
    for(const [direction,label]of [['asc','Sort ascending'],['desc','Sort descending'],['','Clear sorting']]){const b=el('button','opt',label);b.type='button';b.setAttribute('role','menuitem');b.addEventListener('click',()=>{state.sort=direction?{field,direction}:null;state.pageIndex=0;try{localStorage.setItem('aion.sort.'+encodeURIComponent(MY_EMAIL),JSON.stringify(state.sort));}catch{}closePop();p.setAttribute('role','dialog');render();});p.append(b);}placePop(anchor);p.querySelector('button').focus();
  }
  function listView(items,t){
    const w=el("div","listwrap business-list"+(showTicketBriefs()?" with-ai-briefs":"")+" with-email");
    const tools=el('div','list-toolbar'),presets=el('div','seg');presets.setAttribute('aria-label','Ticket columns');
    for(const [mode,label]of [['work','Work view'],['all','All columns']]){const b=el('button','',label);b.type='button';b.setAttribute('aria-pressed',String(state.columnsMode===mode));b.addEventListener('click',()=>{state.columnsMode=mode;try{localStorage.setItem('aion.columns.'+encodeURIComponent(MY_EMAIL),mode);}catch{}render();});presets.append(b);}
    tools.append(presets,el('span','list-toolbar-hint','Right-click a header to sort'+(state.columnsMode==='all'?' · Scroll for more columns':'')));w.append(tools);
    const h=el("div","gr head"); const all=el("input","ck"); all.type="checkbox"; all.setAttribute("aria-label","Select all");
    all.checked=items.every(i=>state.sel.has(i.key)); all.addEventListener("change",()=>{ items.forEach(i=>all.checked?state.sel.add(i.key):state.sel.delete(i.key)); render(); });
    const hc=el("span","c-ck"); hc.appendChild(all); h.appendChild(hc);
    [["c-key","Ticket ID"],["c-ttl","Title / Priority"],["c-who","Assignee"],["c-rep","Reporter"],["c-dev","Developers"],["c-st","Status"],["c-due","Due date"],["c-cre","Created date"],["c-upd","Updated"],["c-note","Internal note"],["c-actions",""]].forEach(([c,x])=>h.appendChild(el("span",c,x)));
    if(showTicketBriefs()){const label=el("span","c-brief","AI brief");label.title="Generate a short AI explanation of each Jira ticket.";h.insertBefore(label,h.querySelector(".c-who"));}
    const businessColumns=[['clientName','Client',150],['subClientName','Project',150],['estimatedHours','Estimated hours',130],['actualHours','Actual hours',120],['workDone','Work done',220],...(IS_ADMIN?[['billing','Billing',130]]:[])];
    businessColumns.forEach(([key,label])=>h.appendChild(el('span','c-'+key,label)));
    if(GITHUB) h.appendChild(el('span','c-prs','Pull requests'));
    const sortMap={'c-key':'key','c-ttl':'summary','c-who':'assigneeName','c-rep':'reporter','c-dev':'developers','c-st':'status','c-due':'due','c-cre':'created','c-upd':'updated','c-prs':'prs'};
    for(const header of h.children){const key=sortMap[header.className]||businessColumns.find(c=>header.classList.contains('c-'+c[0]))?.[0];if(!key)continue;const label=header.textContent;header.replaceChildren();const b=el('button','column-sort',label+(state.sort?.field===key?(state.sort.direction==='asc'?' ↑':' ↓'):' ▾'));b.type='button';b.setAttribute('aria-label','Sort '+label);b.setAttribute('aria-haspopup','menu');b.addEventListener('click',()=>columnSortMenu(b,key));header.addEventListener('contextmenu',e=>{e.preventDefault();columnSortMenu(b,key);});header.append(b);}
    let widths=[28,92,300,...(showTicketBriefs()?[220]:[]),130,150,170,140,120,120,90,120,48,...businessColumns.map(c=>c[2]),...(GITHUB?[240]:[])];
    if(state.columnsMode!=='all'){
      // Work view fits the page width: each column has a minimum and shares the rest of the space.
      const {defs,hidden}=fitWorkColumns();workColumns=defs.map(d=>d[0]);
      applyWorkColumns(h);w.classList.add('work-columns');
      const min=defs.reduce((a,[,n])=>a+n,0)+10*(defs.length-1)+28;
      w.style.setProperty('--business-columns',defs.map(([,n,fr])=>fr?'minmax('+n+'px,'+fr+'fr)':n+'px').join(' '));w.style.setProperty('--business-width','max(100%, '+min+'px)');
      if(hidden.length){const names={'c-workDone':'Work done','c-actualHours':'Actual hours','c-billing':'Billing','c-prs':'Pull requests','c-estimatedHours':'Estimated hours','c-dev':'Developers','c-who':'Assignee'};tools.querySelector('.list-toolbar-hint').textContent='Hidden to fit: '+hidden.map(c=>names[c]).join(', ')+' · All columns shows them';}
    }else{
    w.style.setProperty('--business-columns',widths.map(n=>n+'px').join(' '));w.style.setProperty('--business-width',(widths.reduce((a,b)=>a+b,0)+10*(widths.length-1)+28)+'px');}
    w.appendChild(h);
    const allSorted=sortItems(items), pages=Math.max(1,Math.ceil(allSorted.length/state.pageSize));
    state.pageIndex=Math.min(state.pageIndex,pages-1);
    const sorted=allSorted.slice(state.pageIndex*state.pageSize,(state.pageIndex+1)*state.pageSize);
    if(state.group){
      const groups={}; const put=(k,name,link,i,ord)=>{ (groups[k]=groups[k]||{name,key:link,items:[],ord}).items.push(i); };
      sorted.forEach(i=>{ const g=state.group;
        if(g==="epic") put(i.parent?i.parent.key:"~",i.parent?i.parent.name:"No epic",i.parent?i.parent.key:"",i,i.parent?0:1);
        else if(g==="reporter") put("r:"+i.reporter,i.reporter,"",i,0);
        else if(g==="assignee") put("a:"+(i.assignee||i.assigneeName),i.assignee?PEOPLE[i.assignee].name:i.assigneeName,"",i,0);
        else if(g==="status") put("s:"+i.status,i.status,"",i,stIdx(i.status));
        else if(g==="dev"){ if(!i.devs.length) put("d:~","No developer","",i,-1); else i.devs.forEach(d=>put("d:"+d,"ai1_"+d,"",i,0)); }
      });
      Object.values(groups).sort((a,b)=>a.ord-b.ord||(state.group==="reporter"?b.items.length-a.items.length:0)||a.name.localeCompare(b.name)).forEach(gp=>{
        const gh=el("div","ghead"); const ck=el("input","ck"); ck.type="checkbox"; ck.setAttribute("aria-label","Select all in "+gp.name);
        ck.checked=gp.items.every(i=>state.sel.has(i.key)); ck.addEventListener("change",()=>{ gp.items.forEach(i=>ck.checked?state.sel.add(i.key):state.sel.delete(i.key)); render(); });
        gh.appendChild(ck); const nm=el("span","gname",gp.name); nm.dir="auto"; gh.appendChild(nm);
        if(state.group==="reporter") gh.insertBefore(el("span","av k6",initials(gp.name)),nm); if(gp.key){ const a=el("a","key",gp.key+" ↗"); a.href=SITE+"/browse/"+gp.key; a.target="_blank"; a.rel="noopener"; gh.appendChild(a); }
        gh.appendChild(el("span","gcount",gp.items.length+" ticket"+(gp.items.length===1?"":"s")));
        w.appendChild(gh); gp.items.forEach(i=>w.appendChild(gridRow(i,t)));
      });
    } else sorted.forEach(i=>w.appendChild(gridRow(i,t)));
    const pager=el("div","pagination"); pager.appendChild(el("span",null,`${items.length?state.pageIndex*state.pageSize+1:0}–${Math.min((state.pageIndex+1)*state.pageSize,items.length)} of ${items.length} tickets`));
    const size=el("select"); size.setAttribute("aria-label","Tickets per page"); [25,50,100].forEach(n=>size.appendChild(new Option(n+" per page",String(n)))); size.value=String(state.pageSize); size.addEventListener("change",()=>{state.pageSize=+size.value;state.pageIndex=0;render();}); pager.appendChild(size);
    const buttons=el("div","page-buttons"); const prev=el("button","btn","←"), next=el("button","btn","→"); prev.type=next.type="button"; prev.setAttribute("aria-label","Previous page"); next.setAttribute("aria-label","Next page"); prev.disabled=!state.pageIndex; next.disabled=state.pageIndex===pages-1;
    prev.addEventListener("click",()=>{state.pageIndex--;render();}); next.addEventListener("click",()=>{state.pageIndex++;render();}); buttons.append(prev,el("span",null,`${state.pageIndex+1} / ${pages}`),next);pager.appendChild(buttons);w.appendChild(pager);
    return w;
  }

  function keyLink(i){
    if(i.odoo){ const b=el("button","key odoo",i.key); b.type="button"; b.title="Odoo Helpdesk ticket #"+i.odooId; b.draggable=false; b.addEventListener("click",e=>{ e.stopPropagation(); openDrawer(i.key); }); return b; }
    if(i.internal){ const b=el("button","key int",i.key); b.type="button"; b.title="Internal ticket (not in Jira)"; b.draggable=false; b.addEventListener("click",e=>{ e.stopPropagation(); openDrawer(i.key); }); return b; } const a=el("a","key",i.key+" ↗"); a.href=ticketUrl(i.key); a.target="_blank"; a.rel="noopener"; a.title="Open in Jira"; a.draggable=false; a.addEventListener("click",e=>e.stopPropagation()); return a; }
  function tagsFor(i,t,withEpic){
    const tags=el("span","tags");
    if(i.internal) tags.appendChild(el("span","flag int","Internal"));
    if(i.odoo){ tags.appendChild(el("span","flag odoo","Odoo")); if(i.team) tags.appendChild(el("span","epic",i.team.replace(/^ai1 \| /,""))); }
    if(needsReply(i)) tags.appendChild(el("span","flag k6","needs reply"));
    const age=Math.round(dnum(t)-dnum(new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Jerusalem",year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date(i.created)))); if(age<=2&&i.cat!=="done") tags.appendChild(el("span","flag k7",age===0?"new today":"new "+age+"d"));
    if(/high|highest|critical|blocker/i.test(i.priority)) tags.appendChild(el("span","flag k2",i.priority));
    if(i.type==="Bug") tags.appendChild(el("span","flag k2","Bug"));
    if(dateRequests.activeFor(i.key)) tags.appendChild(el("span","date-pending-badge","Date request pending"));
    if(withEpic&&i.parent){ const ep=el("span","epic",i.parent.name); ep.dir="auto"; ep.title="Epic "+i.parent.key; tags.appendChild(ep); }
    return tags;
  }
  function devButton(i){
    if(!IS_ADMIN){ const ds=el("span","devcell c-dev"); i.devs.forEach(d=>ds.appendChild(el("span","dev "+devK(d),d))); return ds; }
    const dc=el("button","devcell c-dev"+(i.devs.length?"":" nodev")); dc.type="button"; dc.title="Assign developers";
    i.devs.forEach(d=>dc.appendChild(el("span","dev "+devK(d),d))); dc.appendChild(el("span","add",i.devs.length?"+":"+ assign"));
    dc.addEventListener("click",e=>{ e.stopPropagation(); devPopover(dc,[i.key],"set"); }); return dc;
  }
  function statusButton(i){ const sb=el("button","stbtn menu "+stK(i),i.status); sb.type="button"; sb.title="Change status"; sb.addEventListener("click",e=>{ e.stopPropagation(); statusPopover(sb,[i.key]); }); return sb; }
  function dueButton(i,t){
    const late=i.due&&i.due<t&&i.cat!=="done";
    if(i.odoo){ const sp=el("span","duebtn none","—"); sp.title="Odoo Helpdesk tickets don't use due dates here"; return sp; }
    const db=el("button","duebtn"+(late?" late":i.due===t?" today":!i.due?" none":""), i.due?(late?Math.round(dnum(t)-dnum(i.due))+"d late":i.due===t?"Today":fmtDate(i.due)):(dateRequests.all().some(r=>r.key===i.key&&(r.appliedDate||r.original?.due))?"Request date change":"+ set date"));
    db.type="button"; db.title=(i.due?"Due "+fmtDate(i.due)+" · ":"")+(!i.due?"Set initial due date":IS_ADMIN?"Change approved date":"Request date change"); db.addEventListener("click",e=>{ e.stopPropagation(); duePopover(db,[i.key]); }); return db;
  }
  function avatar(i){ const p=i.assignee?PEOPLE[i.assignee]:null; const a=el("span","av "+(i.assignee?"kp-"+i.assignee:"k8"),p?p.ini:"?"); a.title=p?p.name:i.assigneeName; return a; }
  function selBox(i,onChange){ const ck=el("input","ck"); ck.type="checkbox"; ck.checked=state.sel.has(i.key); ck.setAttribute("aria-label","Select "+i.key);
    ck.addEventListener("click",e=>e.stopPropagation()); ck.addEventListener("change",()=>{ ck.checked?state.sel.add(i.key):state.sel.delete(i.key); onChange(ck.checked); updateBulk(); }); return ck; }

  // Work view columns: [class, minimum px, share of the spare width]. When the list is narrower than the
  // minimums, the least needed columns are left out (in WORK_DROP order) so it never scrolls sideways;
  // All columns still shows everything.
  const workColumnDefs=()=>[['c-ck',28],['c-key',84],['c-ttl',170,2.6],['c-who',84,.8],['c-dev',88,.9],['c-st',104,.9],['c-due',72,.6],...(GITHUB?[['c-prs',104,1]]:[]),['c-clientName',96,1.1],['c-estimatedHours',62,.45],['c-actualHours',62,.45],['c-workDone',104,1.2],...(IS_ADMIN?[['c-billing',70,.55]]:[]),['c-note',44],['c-actions',36]];
  const WORK_DROP=['c-workDone','c-actualHours','c-billing','c-prs','c-estimatedHours','c-dev','c-who'];
  let workColumns=null;
  // Phones (under 900px) keep every column and scroll the list sideways inside its own box.
  function fitWorkColumns(){
    const width=(viewWidth||$("view").clientWidth||innerWidth)-16;let defs=workColumnDefs();const need=d=>d.reduce((a,[,n])=>a+n,0)+10*(d.length-1)+28,hidden=[];
    if(width>=884)for(const c of WORK_DROP){if(need(defs)<=width)break;if(defs.some(d=>d[0]===c)){defs=defs.filter(d=>d[0]!==c);hidden.push(c);}}
    return {defs,hidden,keys:defs.map(d=>d[0]).join()};
  }
  function applyWorkColumns(row){
    const order=workColumns||workColumnDefs().map(d=>d[0]);
    for(const child of [...row.children])child.hidden=!order.some(c=>child.classList.contains(c));
    for(const c of order){const child=[...row.children].find(n=>n.classList.contains(c));if(child)row.append(child);}
  }
  function gridRow(i,t){
    const r=el("div","gr item "+stK(i)+(state.sel.has(i.key)?" sel":""));
    const ckw=el("span","c-ck"); ckw.appendChild(selBox(i,on=>r.classList.toggle("sel",on))); r.appendChild(ckw);
    const kw=el("span","c-key"); kw.appendChild(keyLink(i));kw.appendChild(el("small","business-key-date",createdDate(i.created))); r.appendChild(kw);
    const tt=el("button","ttl c-ttl"); tt.type="button"; tt.title="Open details";
    const s=el("span","s",i.summary); s.dir="auto"; tt.appendChild(s);
    const tags=tagsFor(i,t,state.group!=="epic"); if(tags.childNodes.length) tt.appendChild(tags);
    if((state.focus==="reply"||state.focus==="recent"||state.f.activity==="reply")&&i.last){ const sn=el("span","snip"); sn.dir="auto"; sn.appendChild(el("b",null,i.last.author+" · "+ago(i.last.when)+": ")); sn.append(i.last.text); tt.appendChild(sn); }
    tt.addEventListener("click",()=>openDrawer(i.key)); r.appendChild(tt);
    if(showTicketBriefs())r.appendChild(ticketBriefs.renderCell(i));
    const canAsg=IS_ADMIN; const who=el(canAsg?"button":"span","who c-who"+(canAsg?" asg":"")); who.appendChild(avatar(i)); who.appendChild(el("span",null,i.assignee?PEOPLE[i.assignee].name:i.assigneeName));
    if(canAsg){ who.type="button"; who.title="Change assignee"; who.addEventListener("click",e=>{ e.stopPropagation(); assigneePopover(who,[i.key]); }); } r.appendChild(who);
    const rp=el("span","who c-rep"); rp.appendChild(el("span","av k6",initials(i.reporter))); const rn=el("span",null,i.reporter); rn.title=i.reporter; rp.appendChild(rn); r.appendChild(rp);
    r.appendChild(devButton(i));
    const sw=el("span","c-st"); sw.appendChild(statusButton(i)); r.appendChild(sw);
    const dw=el("span","c-due"); dw.appendChild(dueButton(i,t)); r.appendChild(dw);
    { const cr=el("span","upd c-cre",createdDate(i.created)); cr.title="Created "+fmtWhen(i.created).d+" "+fmtWhen(i.created).t+" (Asia/Jerusalem)"; cr.style.fontFamily="var(--mono)"; r.appendChild(cr); }
    r.appendChild(el("span","upd c-upd",ago(i.updated)));
    { const nb=el("button","notebtn c-note email-button","Internal note"); nb.type="button"; nb.setAttribute("aria-label","Internal note for "+i.key);nb.title=IS_ADMIN?"Email the developer directly (not posted in Jira)":"Send a private note to admins"; nb.addEventListener("click",e=>{ e.stopPropagation(); notePopover(nb,i.key); }); r.appendChild(nb); }

    const actions=el("span","c-actions"), menu=el("button","icon-btn row-menu","⋯");menu.type="button";menu.setAttribute("aria-label","Actions for "+i.key);menu.setAttribute("aria-haspopup","dialog");menu.addEventListener("click",()=>rowActions(menu,i));actions.appendChild(menu);r.appendChild(actions);
    for(const key of ['clientName','subClientName','estimatedHours','actualHours','workDone',...(IS_ADMIN?['billing']:[])]){const value=i[key],text=key==='billing'?(value==='not_billable'?'Not billable':value==='billable'?'Billable':'Not set'):value??'Not set';const f=key==='clientName'||key==='subClientName'?'client':key,edit=business.canQuickEdit(i,f);const c=el(edit?'button':'span','business-cell c-'+key+(edit?' cell-edit':''),String(text||'Not set'));if(edit){c.type='button';c.setAttribute('aria-label','Edit '+business.quickLabel(f)+' for '+i.key);c.addEventListener('click',e=>{e.stopPropagation();businessPopover(c,i,f);});}if(key==='workDone'){c.textContent=value?value.slice(0,100)+(value.length>100?'…':''):'Not set';c.title=value||'';}r.append(c);}
    if(GITHUB) r.appendChild(prCell(i));
    if(state.columnsMode!=='all'){applyWorkColumns(r);const client=r.querySelector('.c-clientName');if(i.subClientName)client.append(el('small','client-secondary',i.subClientName));}
    return r;
  }

  function rowActions(anchor,i){
    const p=$("pop");p.replaceChildren();p.appendChild(el("h4",null,i.key+" · Quick actions"));const body=el("div","body");p.appendChild(body);
    const action=(label,fn)=>{const b=el("button","opt",label);b.type="button";b.addEventListener("click",()=>{closePop();fn();});body.appendChild(b);};
    action("Open details",()=>openDrawer(i.key));
    action("Copy ticket link",async()=>{try{await navigator.clipboard.writeText(dashUrl(i.key));toast("Ticket link copied.");}catch(_){toast("Couldn't copy the link.",[],true);}});
    action("Change status",()=>statusPopover(anchor,[i.key]));if(!i.odoo)action(IS_ADMIN?"Change approved date":"Request date change",()=>duePopover(anchor,[i.key]));
    if(IS_ADMIN){action(i.odoo?"Change developer":"Assign developers",()=>devPopover(anchor,[i.key],"set"));if(!i.odoo)action("Change assignee",()=>assigneePopover(anchor,[i.key]));}action("Internal notes",()=>notePopover(anchor,i.key));
    if(!i.internal){const a=el("a","opt","Open in "+sourceName(i.key)+" ↗");a.href=ticketUrl(i.key);a.target="_blank";a.rel="noopener";body.appendChild(a);}
    placePop(anchor);body.querySelector("button")?.focus({preventScroll:true});
  }

  function shiftOf(c){ if(!c.from) return {txt:"first set",k:"k1"}; if(!c.to) return {txt:"cleared",k:"k8"}; const n=Math.round(dnum(c.to)-dnum(c.from)); if(n>0) return {txt:"+"+n+"d later",k:n>=7?"k2":"k3"}; if(n<0) return {txt:n+"d earlier",k:"k7"}; return {txt:"same",k:"k8"}; }
  async function fetchHistory(key){
    if(isOdoo(key)) return [];
    if(isInt(key)) return ((INT[key]&&INT[key].dueHistory)||[]).map(h=>({when:h.when,by:h.by,from:h.from,to:h.to}));
    const d=await jira.changelog(key); const hs=(d.changelog&&d.changelog.histories)||[]; const out=[];
    hs.forEach(h=>(h.items||[]).forEach(it=>{ if(it.field==="duedate"||it.fieldId==="duedate") out.push({when:h.created,by:(h.author&&h.author.displayName)||"Someone",from:it.from?String(it.from).slice(0,10):null,to:it.to?String(it.to).slice(0,10):null}); }));
    out.sort((a,b)=>a.when<b.when?1:-1); return out;
  }
  function renderDrawerHist(key){
    const box=$("d-hist"); box.replaceChildren(); const ch=dueChanges(key);
    if(!IS_ADMIN) return;
    if(!HIST[key]){ box.appendChild(el("span","msg","Loading…")); return; }
    if(!ch.length){ box.appendChild(el("span","msg","The due date has never been set or changed.")); return; }
    const tl=el("div","tl");
    ch.forEach(c=>{ const sh=shiftOf(c); const it=el("div","tli "+sh.k); const top=el("div","top"); const fw=fmtWhen(c.when);
      top.appendChild(el("b",null,fw.d+" "+fw.t)); top.appendChild(el("span",null,"by "+c.by)); top.appendChild(el("span","shift "+sh.k,sh.txt)); it.appendChild(top);
      const chg=el("div","chg"); if(c.from) chg.appendChild(el("span","from",fmtDate(c.from))); else chg.appendChild(el("span","none","not set")); chg.appendChild(el("span",null,"→")); if(c.to) chg.appendChild(el("b",null,fmtDate(c.to))); else chg.appendChild(el("span","none","cleared")); it.appendChild(chg);
      tl.appendChild(it); });
    box.appendChild(tl);
  }

  let drag=null;
  function boardView(items,t,mode){
    const b=el("div","board"); const cols=[];
    if(mode==="dev"){
      cols.push({id:"__none",name:"No developer",k:"k2",items:items.filter(i=>!i.devs.length)});
      allDevs().forEach(d=>cols.push({id:d,name:"ai1_"+d,k:devK(d),items:items.filter(i=>i.devs.includes(d))}));
    } else if(mode==="status"){
      const sts=[...new Set(items.map(i=>i.status))];
      ["Open","Pending Approval","Dev Approved","In Development","Pending QA","In QA","Done Review"].forEach(s=>{ if(!sts.includes(s)) sts.push(s); });
      sts.sort((a,b)=>stIdx(a)-stIdx(b)).forEach(s=>cols.push({id:s,name:s,k:stK({status:s,cat:""}),items:items.filter(i=>i.status===s)}));
    } else {
      Object.keys(PEOPLE).forEach(k=>cols.push({id:k,name:PEOPLE[k].name,k:"kp-"+k,items:items.filter(i=>i.assignee===k),av:PEOPLE[k].ini}));
    }
    cols.forEach(c=>{
      const col=el("div","col "+c.k);
      const h=el("div","colh"); if(c.av) h.appendChild(el("span","av "+c.k,c.av)); h.appendChild(el("span",mode==="dev"?"mono":null,c.name));
      const over=c.items.filter(i=>i.due&&i.due<t&&i.cat!=="done").length; if(over) h.appendChild(el("span","warn",over+" late"));
      h.appendChild(el("span","c",String(c.items.length))); col.appendChild(h);
      const list=el("div","cards");
      sortItems(c.items).forEach(i=>list.appendChild(card(i,t,c.id,mode)));
      if(!c.items.length){ const e=el("div","boardhint",mode==="assignee"?"Nothing here":"Drop here"); e.style.padding="8px 4px"; list.appendChild(e); }
      col.appendChild(list);
      if(mode!=="assignee"){
        col.addEventListener("dragover",e=>{ if(!drag) return; e.preventDefault(); col.classList.add("over"); });
        col.addEventListener("dragleave",e=>{ if(!col.contains(e.relatedTarget)) col.classList.remove("over"); });
        col.addEventListener("drop",e=>{ e.preventDefault(); col.classList.remove("over"); if(!drag) return; const d=drag; drag=null; onDrop(d,c.id,mode); });
      }
      b.appendChild(col);
    });
    return b;
  }
  function card(i,t,colId,mode){
    const tint=mode==="status"?(i.devs[0]?devK(i.devs[0]):"k2"):stK(i);
    const c=el("div","card "+tint+(state.sel.has(i.key)?" sel":""));
    c.draggable=mode!=="assignee";
    c.addEventListener("dragstart",e=>{ const keys=state.sel.has(i.key)&&state.sel.size>1?[...state.sel]:[i.key]; drag={keys,from:colId}; c.classList.add("dragging"); try{ e.dataTransfer.setData("text/plain",i.key); e.dataTransfer.effectAllowed="move"; }catch(x){} });
    c.addEventListener("dragend",()=>{ c.classList.remove("dragging"); document.querySelectorAll(".col.over").forEach(x=>x.classList.remove("over")); setTimeout(()=>{ drag=null; },0); });
    const r1=el("div","row1"); r1.appendChild(keyLink(i)); if(mode!=="assignee") r1.appendChild(avatar(i)); r1.appendChild(selBox(i,on=>c.classList.toggle("sel",on))); c.appendChild(r1);
    const tt=el("button","t",i.summary); tt.type="button"; tt.dir="auto"; tt.addEventListener("click",()=>openDrawer(i.key)); c.appendChild(tt);
    const tags=tagsFor(i,t,true); if(tags.childNodes.length) c.appendChild(tags);
    const r3=el("div","row3");
    if(mode!=="status") r3.appendChild(statusButton(i));
    if(mode!=="dev") r3.appendChild(devButton(i));
    const db=dueButton(i,t); db.classList.add("sp"); r3.appendChild(db); c.appendChild(r3);
    { const nb=el("button","notebtn","✉ Internal notes"); nb.type="button"; nb.addEventListener("click",e=>{ e.stopPropagation(); notePopover(nb,i.key); }); c.appendChild(nb); }
    return c;
  }
  async function onDrop(d,target,mode){
    if(d.from===target) return;
    if(!IS_ADMIN&&mode!=="status") return;
    if(mode==="dev"){
      const ops=d.keys.map(k=>{ const i=issueByKey(k); if(!i) return null; const want=new Set(i.devs);
        if(d.from!=="__none") want.delete(d.from);
        if(target!=="__none") want.add(target);
        const same=want.size===i.devs.length&&[...want].every(x=>i.devs.includes(x)); if(same) return null;
        return {key:k,added:[...want].filter(x=>!i.devs.includes(x)),run:()=>setDevs(k,want),patch:devsPatch(want)};
      }).filter(Boolean);
      if(!ops.length){ toast("Nothing to change."); return; }
      await runBatch(ops,target==="__none"?"Developer removed":"Assigned to ai1_"+target);
    } else if(mode==="status"){
      toast("Checking allowed moves…");
      const ops=[], skipped=[];
      await Promise.all(d.keys.map(async k=>{ const i=issueByKey(k); if(i&&i.status===target) return;
        try{ const trs=await getTransitions(k); const tr=trs.find(x=>x.to&&x.to.name&&x.to.name.toLowerCase()===target.toLowerCase());
          if(tr) ops.push({key:k,run:()=>doTransition(k,tr.id),patch:statusPatch(tr.to.name,tr.to.statusCategory&&tr.to.statusCategory.key)}); else skipped.push(k+": can't go from "+(i?i.status:"its status")+" straight to "+target);
        }catch(err){ skipped.push(k+": "+errorText(err)); } }));
      if(ops.length) await runBatch(ops,"Moved to "+target);
      if(skipped.length) setTimeout(()=>toast("Not moved",skipped,true),ops.length?3300:0);
    }
  }
  function updateBulk(){ const n=state.sel.size; $("bulk").hidden=n===0; $("b-count").textContent=n+" selected"; }

  let popAnchor=null;
  function closePop(){ $("pop").classList.remove("wide","modal"); $("pop").hidden=true; $("pop").replaceChildren(); popAnchor=null; popScrim.hidden=true; }
  // A large form (new or edited internal ticket) opens as a centered window that stays open while scrolling;
  // it closes with Cancel, ✕ or Esc. popAnchor stays empty, so clicks and scrolling elsewhere leave it open.
  const popScrim=el("div","pop-scrim"); popScrim.hidden=true; document.body.appendChild(popScrim);
  function openModal(){ const p=$("pop"); p.classList.remove("wide"); p.classList.add("modal"); p.style.left=p.style.top=""; p.hidden=false; popAnchor=null; popScrim.hidden=false; }
  // Esc on a form with something typed asks first, so the text isn't lost by accident.
  const modalTyped=()=>[...$("pop").querySelectorAll("input[type=text],input:not([type]),textarea")].some(n=>n.value.trim()&&!n.readOnly);
  function placePop(anchor){
    const p=$("pop"); p.hidden=false; popAnchor=anchor;
    const r=anchor.getBoundingClientRect(), w=p.offsetWidth, h=p.offsetHeight, vw=document.documentElement.clientWidth, vh=window.innerHeight;
    let left=Math.min(Math.max(16,r.left),vw-w-16), top=r.bottom+6; if(top+h>vh-12) top=Math.max(12,r.top-h-6);
    p.style.left=left+"px"; p.style.top=top+"px";
  }
  document.addEventListener("mousedown",e=>{ const p=$("pop"); if(!p.hidden&&!p.contains(e.target)&&popAnchor&&!popAnchor.contains(e.target)) closePop(); });
  document.addEventListener("keydown",e=>{ if(e.key==="Escape"){ if(!$("pop").hidden){ if($("pop").classList.contains("modal")&&modalTyped()&&!confirm("Close this form? What you typed will be lost.")) return; closePop(); } else if(!$("drawer").hidden) closeDrawer(); } });
  window.addEventListener("scroll",()=>{ if($("pop").hidden||$("pop").classList.contains("modal"))return;if(!popAnchor?.isConnected){closePop();return;}const bounds=popAnchor.getBoundingClientRect();if(bounds.bottom<0||bounds.top>innerHeight)closePop();else placePop(popAnchor); },{passive:true});

  function devPopover(anchor,keys,mode){
    const p=$("pop"); p.replaceChildren(); const one=keys.length===1&&mode==="set";
    p.appendChild(el("h4",null,one?"Developers on "+keys[0]:mode==="add"?"Add developers to "+keys.length+" tickets":"Remove developers from "+keys.length+" tickets"));
    const body=el("div","body"); p.appendChild(body);
    const chosen=new Set(one?(issueByKey(keys[0])||{devs:[]}).devs:[]);
    const counts={}; keys.forEach(k=>{ const i=issueByKey(k); (i?i.devs:[]).forEach(d=>counts[d]=(counts[d]||0)+1); });
    const names=new Set(allDevs()); chosen.forEach(d=>names.add(d));
    function addOpt(d){ const o=el("label","opt"); const c=el("input","ck"); c.type="checkbox"; c.checked=chosen.has(d); c.dataset.dev=d;
      c.addEventListener("change",()=>c.checked?chosen.add(d):chosen.delete(d)); o.appendChild(c); o.appendChild(el("span","dev "+devK(d),"ai1_"+d)); if(!one&&counts[d]) o.appendChild(el("span","cnt",counts[d]+" of "+keys.length)); body.appendChild(o); }
    [...names].sort().forEach(addOpt);
    const foot=el("div","foot");
    if(mode!=="remove"){
      const inp=el("input","inp"); inp.placeholder="Other name"; inp.style.width="110px"; inp.setAttribute("aria-label","Other developer name");
      const add=el("button","btn","Add"); add.type="button";
      const doAdd=()=>{ const v=inp.value.trim().replace(/^ai1_/i,"").replace(/\s+/g,"").toLowerCase(); if(!v) return; chosen.add(v); if(!names.has(v)){ names.add(v); addOpt(v); } else { const c=[...body.querySelectorAll("input")].find(x=>x.dataset.dev===v); if(c) c.checked=true; } inp.value=""; };
      add.addEventListener("click",doAdd); inp.addEventListener("keydown",e=>{ if(e.key==="Enter"){ e.preventDefault(); doAdd(); } });
      foot.appendChild(inp); foot.appendChild(add);
    }
    const save=el("button","btn primary sp",mode==="remove"?"Remove":"Save"); save.type="button";
    save.addEventListener("click",async()=>{ closePop();
      const ops=keys.map(k=>{ const i=issueByKey(k); const cur=new Set(i?i.devs:[]); let want;
        if(mode==="set") want=new Set(chosen); else if(mode==="add"){ want=new Set(cur); chosen.forEach(d=>want.add(d)); } else want=new Set([...cur].filter(d=>!chosen.has(d)));
        const same=want.size===cur.size&&[...want].every(d=>cur.has(d));
        return same?null:{key:k,added:[...want].filter(d=>!cur.has(d)),run:()=>setDevs(k,want),patch:devsPatch(want)}; }).filter(Boolean);
      if(!ops.length){ toast("Nothing to change."); return; }
      await runBatch(ops,mode==="remove"?"Developers removed":"Developers saved"); });
    foot.appendChild(save); p.appendChild(foot); placePop(anchor);
  }
  function duePopover(anchor,keys){
    if(keys.some(isOdoo)){toast("Odoo tickets use Odoo's SLA deadline, which can't be changed from here.");return;}
    if(keys.length!==1){toast("Choose one ticket to request or approve a date change.");return;}
    dateRequests.formRequest(keys[0]);
  }
  const initialsOf=n=>String(n||"?").split(/\s+/).filter(Boolean).map(x=>x[0]).join("").slice(0,2).toUpperCase()||"?";
  function assignOps(keys,id,name){ return keys.map(k=>{ const i=issueByKey(k); if(i&&i.assigneeId===id) return null; if(isOdoo(k)) return null; if(isInt(k)) return BYID[id]?{key:k,run:async()=>{await business.ensureBilling(k);return internalApi.update(k,{assignee:BYID[id]});}}:null; if(id===INTERNAL_ASSIGNEE)return null; return {key:k,run:async()=>{await business.ensureBilling(k);return jira.edit(k,{assignee:id?{accountId:id}:null},{assigneeName:id?name:"Unassigned"});}}; }).filter(Boolean); }
  async function doAssign(keys,id,name){
    const base=assignOps(keys,id,name).map(o=>({...o,patch:assigneePatch(id,name)})), ops=base; if(!ops.length){ toast("Already assigned to "+name+"."); return {ok:0,fail:0}; }
    const r=await runBatch(ops,"Assigned to "+name);
    if(r.ok&&id&&!BYID[id]) setTimeout(()=>toast(name+" isn't "+teamNames()+", so "+(r.ok===1?"this ticket":"these tickets")+" will leave the dashboard."),3300);
    return r;
  }
  // Client, hours, work done and billing edited from the list, without opening the ticket.
  function businessPopover(anchor,i,f){
    const p=$("pop"); p.replaceChildren(); p.appendChild(el("h4",null,i.key+" · "+business.quickLabel(f)));
    const body=el("div","body"); p.appendChild(body); placePop(anchor);
    business.quickEdit(body,i.key,f,()=>{ closePop(); mergeIssues(); saveCache(); render(); toast(i.key+": "+business.quickLabel(f)+" saved"); }).then(()=>{ if(popAnchor===anchor) placePop(anchor); });
  }
  function assigneePopover(anchor,keys){
    const p=$("pop"); p.replaceChildren(); p.appendChild(el("h4",null,keys.length===1?"Assign "+keys[0]+" to":"Assign "+keys.length+" tickets to"));
    const body=el("div","body"); p.appendChild(body);
    const one=keys.length===1?issueByKey(keys[0]):null;
    const opt=(id,name,note,k)=>{ const b=el("button","opt"); b.type="button"; b.appendChild(el("span","av "+(k||"k8"),initialsOf(name))); b.appendChild(el("span",null,name));
      b.appendChild(el("span","cnt",one&&one.assigneeId===id?"current":note||""));
      b.addEventListener("click",async()=>{ closePop(); await doAssign(keys,id,name); }); body.appendChild(b); };
    Object.keys(PEOPLE).filter(k=>k!==INTERNAL_ASSIGNEE||keys.every(isInt)).forEach(k=>opt(PEOPLE[k].id,PEOPLE[k].name,"team","kp-"+k));
    const extra=new Map(); keys.forEach(k=>{ const i=issueByKey(k); if(i&&i.reporterId&&!BYID[i.reporterId]) extra.set(i.reporterId,i.reporter); });
    extra.forEach((n,id)=>opt(id,n,"reporter","k6"));
    const foot=el("div","foot"); const inp=el("input","inp"); inp.placeholder="Search anyone in Jira…"; inp.style.flex="1"; inp.setAttribute("aria-label","Search Jira users");
    const res=el("div","body"); res.style.maxHeight="160px";
    let t=null; inp.addEventListener("input",()=>{ clearTimeout(t); const q=inp.value.trim(); if(q.length<2){ res.replaceChildren(); return; } t=setTimeout(async()=>{ res.replaceChildren(el("div","note","Searching…"));
      try{ const r=await jira.users(q); const list=(Array.isArray(r)?r:[]).filter(u=>u.active!==false&&u.accountType!=="app"); res.replaceChildren();
        if(!list.length) res.appendChild(el("div","note","No one found."));
        list.forEach(u=>{ const b=el("button","opt"); b.type="button"; b.appendChild(el("span",null,u.displayName)); if(u.emailAddress) b.appendChild(el("span","cnt",u.emailAddress));
          b.addEventListener("click",async()=>{ closePop(); await doAssign(keys,u.accountId,u.displayName); }); res.appendChild(b); });
      }catch(err){ res.replaceChildren(el("div","note",errorText(err))); } },300); });
    foot.appendChild(inp); p.appendChild(foot); p.appendChild(res); placePop(anchor);
  }
  async function userNotePopover(anchor,key){
    const i=issueByKey(key);if(!i)return;
    const p=$("pop");p.replaceChildren();p.classList.add("wide");
    p.appendChild(el("h4",null,"Internal note · "+key+" · to people in the dashboard, not posted in Jira"));
    const body=el("div","body");p.appendChild(body);
    const f1=el("div","fld");f1.appendChild(el("label",null,"To"));const rc=el("div","rcpts");rc.textContent="Loading admins…";f1.appendChild(rc);body.appendChild(f1);
    const f3=el("div","fld"),subj=el("input","inp");subj.id="user-note-subject";subj.maxLength=200;subj.value="Internal note: "+key+" – "+i.summary;const sl=el("label",null,"Subject");sl.htmlFor=subj.id;f3.append(sl,subj);body.append(f3);
    const f4=el("div","fld"),ta=el("textarea","inp");ta.id="user-note-body";ta.maxLength=5000;ta.dir="auto";ta.placeholder="Write your note to the admins…";const nl=el("label",null,"Note");nl.htmlFor=ta.id;f4.append(nl,ta);body.append(f4);
    const f5=el("label","tgl"),details=el("input","ck");details.type="checkbox";details.checked=true;f5.append(details," Include ticket details and link");body.append(f5);
    const foot=el("div","foot"),msg=el("span","msg"),send=el("button","btn primary sp","Send email");send.type="button";send.disabled=true;msg.setAttribute("role","status");foot.append(msg,send);p.append(foot);placePop(anchor);ta.focus();
    const chosen=new Set();let recipients=[],id=crypto.randomUUID();
    const changed=()=>{id=crypto.randomUUID();};ta.addEventListener("input",changed);subj.addEventListener("input",changed);details.addEventListener("change",changed);
    try{const result=await api("/ticket-notes?key="+encodeURIComponent(key));if(!p.contains(send))return;recipients=result.recipients||[];rc.replaceChildren();
      for(const person of recipients){const on=person.role!=="user";if(on)chosen.add(person.email);const chip=el("button","fc",person.name+(person.role==="admin"?" · admin":""));chip.type="button";chip.title=person.email;chip.setAttribute("aria-label",person.name);chip.setAttribute("aria-pressed",String(on));chip.onclick=()=>{chosen.has(person.email)?chosen.delete(person.email):chosen.add(person.email);chip.setAttribute("aria-pressed",String(chosen.has(person.email)));changed();};rc.append(chip);}
      send.disabled=!recipients.length;if(!recipients.length)msg.textContent="No one else is in the dashboard yet.";placePop(anchor);
    }catch(error){if(p.contains(send)){rc.textContent="";msg.textContent=error.message;msg.className="msg err";}}
    send.onclick=async()=>{if(!chosen.size){msg.textContent="Pick at least one person.";return;}if(!ta.value.trim()){msg.textContent="Write the note first.";ta.focus();return;}
      send.disabled=true;send.textContent="Sending…";ta.disabled=subj.disabled=details.disabled=true;rc.querySelectorAll("button").forEach(b=>b.disabled=true);
      try{const result=await api("/ticket-notes",{method:"POST",body:{key,id,text:ta.value.trim(),subject:subj.value.trim(),includeDetails:details.checked,recipients:[...chosen]}});if(p.contains(send))closePop();toast(result.note.notification==="sent"?"Internal note emailed.":"Internal note saved. Email delivery was not confirmed.",recipients.filter(r=>chosen.has(r.email)).map(r=>r.name));}
      catch(error){msg.textContent=error.message;msg.className="msg err";send.disabled=false;send.textContent="Send email";ta.disabled=subj.disabled=details.disabled=false;rc.querySelectorAll("button").forEach(b=>b.disabled=false);}
    };
  }
  function notePopover(anchor,key){
    if(!IS_ADMIN){userNotePopover(anchor,key);return;}
    const i=issueByKey(key); if(!i) return;
    const p=$("pop"); p.replaceChildren(); p.classList.add("wide");
    p.appendChild(el("h4",null,"Internal note · "+key+" · email only, not posted in Jira"));
    const body=el("div","body"); p.appendChild(body);
    const f1=el("div","fld"); f1.appendChild(el("label",null,"To")); const rc=el("div","rcpts"); f1.appendChild(rc); body.appendChild(f1);
    const chosen=new Set(i.devs.filter(d=>DEV_EMAIL[d]));
    Object.keys(DEV_EMAIL).sort().forEach(d=>{ const c=el("button","fc "+devK(d)); c.type="button"; c.appendChild(el("span","sw")); c.appendChild(el("span",null,"ai1_"+d)); if(i.devs.includes(d)) c.appendChild(el("span","cnt","on ticket"));
      c.setAttribute("aria-pressed",String(chosen.has(d))); c.title=DEV_EMAIL[d];
      c.addEventListener("click",()=>{ chosen.has(d)?chosen.delete(d):chosen.add(d); c.setAttribute("aria-pressed",String(chosen.has(d))); }); rc.appendChild(c); });
    // Everyone else in the dashboard, besides the developer list above.
    const fp=el("div","fld"); fp.appendChild(el("label",null,"Dashboard people")); const pp=el("div","rcpts"); pp.textContent="Loading…"; fp.appendChild(pp); body.appendChild(fp);
    const people=new Set();
    api("/ticket-notes?key="+encodeURIComponent(key)).then(r=>{ if(!p.contains(pp)) return; pp.replaceChildren(); const devMails=new Set(Object.values(DEV_EMAIL).map(e=>String(e).toLowerCase()));
      const list=(r.recipients||[]).filter(x=>!devMails.has(String(x.email).toLowerCase())); if(!list.length) pp.textContent="Everyone is in the developer list above.";
      list.forEach(x=>{ const c=el("button","fc",x.name+(x.role==="admin"?" · admin":"")); c.type="button"; c.title=x.email; c.setAttribute("aria-pressed","false"); c.addEventListener("click",()=>{ people.has(x.email)?people.delete(x.email):people.add(x.email); c.setAttribute("aria-pressed",String(people.has(x.email))); }); pp.appendChild(c); });
    }).catch(()=>{ if(p.contains(pp)) pp.textContent="Couldn't load the dashboard people."; });
    const f2=el("div","fld"); f2.appendChild(el("label",null,"Also send to (optional, comma separated)")); const extra=el("input","inp"); extra.type="text"; extra.placeholder="name@aione.biz"; f2.appendChild(extra); body.appendChild(f2);
    const f3=el("div","fld"); f3.appendChild(el("label",null,"Subject")); const subj=el("input","inp"); subj.value="Internal note: "+key+" – "+i.summary; f3.appendChild(subj); body.appendChild(f3);
    const f4=el("div","fld"); f4.appendChild(el("label",null,"Note")); const ta=el("textarea","inp"); ta.dir="auto"; ta.placeholder="Write your note to the developer…"; f4.appendChild(ta); body.appendChild(f4);
    const f5=el("label","tgl"); f5.style.padding="2px 12px 8px"; const cc=el("input","ck"); cc.type="checkbox"; cc.checked=true; f5.appendChild(cc); f5.append(" Include ticket details and link"); body.appendChild(f5);
    const foot=el("div","foot"); const msg=el("span","msg"); const send=el("button","btn primary sp",MAIL?"Send email":"Open in Outlook"); send.type="button"; send.title=MAIL?"Sends right away, in your name. Replies come to your inbox.":"Opens a ready-made email in your mail app. Check it and press Send there.";
    send.addEventListener("click",async()=>{
      const to=[...new Set([...chosen].map(d=>DEV_EMAIL[d]).concat([...people],extra.value.split(/[,;\s]+/).map(x=>x.trim()).filter(x=>/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(x))))];
      const text=ta.value.trim();
      if(!to.length){ msg.textContent="Pick at least one person."; msg.className="msg err"; return; }
      if(!text){ msg.textContent="Write the note first."; msg.className="msg err"; ta.focus(); return; }
      const names=[...chosen].map(devFirstName), subject=subj.value.trim()||("Internal note: "+key);
      if(!MAIL){
        let plain="Hi "+(names.length?names.join(", "):"team")+",\n\n"+text+"\n";
        if(cc.checked) plain+="\n---\nTicket: "+key+" – "+i.summary+"\n"+dashUrl(key)+(isInt(key)?"":"\nIn "+sourceName(key)+": "+ticketUrl(key))+"\nStatus: "+i.status+" · Due: "+(i.due?fmtDate(i.due):"Not set")+" · Assignee: "+(i.assignee?PEOPLE[i.assignee].name:i.assigneeName)+(i.parent?" · Epic: "+i.parent.name:"")+"\n";
        plain+="\nThanks,\n"+ME+"\n";
        openEmail(to,subject,plain);
        closePop(); toast("Email opened in Outlook. Check it and press Send there.",to); return;
      }
      send.disabled=true; send.textContent="Sending…"; msg.textContent="";
      let html="<p>Hi "+esc(names.length?names.join(", "):"team")+",</p>"+text.split(/\n{2,}/).map(par=>"<p>"+esc(par).replace(/\n/g,"<br>")+"</p>").join("");
      if(cc.checked) html+="<hr><p><b>Ticket:</b> <a href=\""+esc(dashUrl(key))+"\">"+esc(key)+"</a> – "+esc(i.summary)+(isInt(key)?"":" (<a href=\""+esc(ticketUrl(key))+"\">"+sourceName(key)+"</a>)")+"<br><b>Status:</b> "+esc(i.status)+" · <b>Due:</b> "+esc(i.due?fmtDate(i.due):"Not set")+" · <b>Assignee:</b> "+esc(i.assignee?PEOPLE[i.assignee].name:i.assigneeName)+(i.parent?" · <b>Epic:</b> "+esc(i.parent.name):"")+"</p>";
      html+="<p>Thanks,<br>"+esc(ME)+"</p>";
      try{ await api("/mail",{method:"POST",body:{to,subject,html}});
        closePop(); toast("Internal note sent to "+to.length+" recipient"+(to.length===1?"":"s"),to);
      }catch(err){ send.disabled=false; send.textContent="Send email"; msg.className="msg err";
        msg.textContent=err.code==="network"?"The server didn't confirm. Ask the recipient before sending again.":err.message; }
    });
    foot.appendChild(msg); foot.appendChild(send); p.appendChild(foot); placePop(anchor); ta.focus();
  }
  async function getTransitions(key){
    if(isOdoo(key)){ const d=await odooDetail(key); return (d.stages||[]).filter(s=>s.name!==d.ticket.status).map(s=>({id:s.id,name:"Move to "+s.name,to:{name:s.name,statusCategory:{key:s.cat}}})); }
    if(isInt(key)){ const t=INT[key]; return INT_STATUSES.filter(s=>!t||s.name!==t.status).map(s=>({id:s.name,name:s.name==="Closed"?"Close":"Move to "+s.name,to:{name:s.name,statusCategory:{key:s.cat}}})); }
    // Jira's allowed moves depend on the current status: kept for 5 minutes per ticket and status.
    const i=loadedIssue(key), id=key+"|"+(i?i.status:""), hit=TRANS[id];
    if(hit&&Date.now()-hit.at<300000) return hit.list;
    const d=(await jira.transitions(key))||{}, list=(d.transitions||[]).filter(x=>x.isAvailable!==false); TRANS[id]={at:Date.now(),list}; return list; }
  const TRANS={};
  async function statusPopover(anchor,keys){
    const p=$("pop"); p.replaceChildren(); p.appendChild(el("h4",null,keys.length===1?"Move "+keys[0]+" to":"Move "+keys.length+" tickets to"));
    const body=el("div","body"); body.appendChild(el("div","note","Loading allowed statuses…")); p.appendChild(body); placePop(anchor); const my=anchor;
    try{
      const per={}, queue=keys.slice(), workers=[];
      for(let w=0;w<4;w++) workers.push((async()=>{ while(queue.length){ const k=queue.shift(); try{ per[k]=await getTransitions(k); }catch(e){ per[k]=[]; } } })());
      await Promise.all(workers); if(popAnchor!==my) return;
      const byT={}; keys.forEach(k=>(per[k]||[]).forEach(tr=>{ const name=(tr.to&&tr.to.name)||tr.name; (byT[name]=byT[name]||{name,cat:(tr.to&&tr.to.statusCategory&&tr.to.statusCategory.key)||"",label:tr.name,items:[]}).items.push({key:k,id:tr.id}); }));
      body.replaceChildren(); const groups=Object.values(byT).sort((a,b)=>b.items.length-a.items.length||stIdx(a.name)-stIdx(b.name));
      if(!groups.length){ body.appendChild(el("div","note","No status moves are available.")); return; }
      groups.forEach(g=>{ const b=el("button","opt"); b.type="button"; b.appendChild(el("span",null,"→")); b.appendChild(el("span","stbtn "+stK({status:g.name,cat:g.cat}),g.name));
        b.appendChild(el("span","cnt",keys.length>1?g.items.length+" of "+keys.length:g.label));
        b.addEventListener("click",async()=>{ closePop(); await runBatch(g.items.map(it=>({key:it.key,run:()=>doTransition(it.key,it.id),patch:statusPatch(g.name,g.cat)})),"Moved to "+g.name);
          const sk=keys.length-g.items.length; if(sk>0) setTimeout(()=>toast(sk+" ticket"+(sk===1?"":"s")+" can't move to "+g.name+" from their current status."),3300); });
        body.appendChild(b); });
      placePop(my);
    }catch(err){ body.replaceChildren(el("div","note",errorText(err))); }
  }
  const selected=()=>[...state.sel];
  $("b-adddev").addEventListener("click",e=>devPopover(e.currentTarget,selected(),"add"));
  $("b-rmdev").addEventListener("click",e=>devPopover(e.currentTarget,selected(),"remove"));
  $("b-due").textContent="Date request";
  $("b-due").addEventListener("click",e=>duePopover(e.currentTarget,selected()));
  $("b-status").addEventListener("click",e=>statusPopover(e.currentTarget,selected()));
  $("b-asg").addEventListener("click",e=>assigneePopover(e.currentTarget,selected()));
  $("b-clear").addEventListener("click",()=>{ state.sel.clear(); render(); });

  let toastTimer=null;
  // links: optional [{label,href,title}] shown as buttons; a toast with links stays until closed.
  function toast(title,list,isErr,links){ const t=$("toast"); t.replaceChildren(el("span","t",title)); t.className="toast"+(isErr?" err":"")+(links&&links.length?" sticky":"");
    if(list&&list.length){ const ul=el("ul"); list.forEach(x=>ul.appendChild(el("li",null,x))); t.appendChild(ul); }
    if(links&&links.length){ const box=el("div","links"); links.forEach(l=>{ const a=el("a","btn primary",l.label); a.href=l.href; if(l.title) a.title=l.title; box.appendChild(a); }); t.appendChild(box);
      const x=el("button","x","✕"); x.type="button"; x.setAttribute("aria-label","Close"); x.addEventListener("click",()=>{ t.hidden=true; }); t.appendChild(x); }
    t.hidden=false; clearTimeout(toastTimer); if(!(links&&links.length)) toastTimer=setTimeout(()=>t.hidden=true,isErr?9000:3000); }
  // Changes running right now (the auto-refresh waits for them).
  let batchBusy=0;
  // Runs ops ({key, run, patch?, added?}). Each op's patch shows on the page at once; up to 4 tickets are
  // changed at the same time; then only those tickets are re-read.
  async function runBatch(ops,okText){
    batchBusy++; let ok=0, started=0; const fails=[], done=[], queue=ops.slice();
    ops.forEach(o=>{ if(o.patch) o._p=patchIssue(o.key,o.patch); });
    const showDrawerStatus=()=>{ const i=dz.key&&issueByKey(dz.key); if(i&&ops.some(o=>o.key===dz.key)){ $("d-status").textContent=i.status; $("d-status").className="stbtn "+stK(i); } };
    if(PENDING.size){ mergeIssues(); renderIfIdle(); showDrawerStatus(); }
    // The ticket's allowed status moves change with it.
    const runOne=async op=>{ try{ const r=await op.run(); if(r&&r.ticket&&r.ticket.internal) putInternal(r.ticket); }
      finally{ Object.keys(TRANS).forEach(id=>{ if(id.startsWith(op.key+"|")) delete TRANS[id]; }); } };
    let stop=false;
    const worker=async()=>{ while(queue.length&&!stop){ const op=queue.shift(); started++; if(ops.length>1) toast("Updating "+started+" of "+ops.length+"…");
      try{try{await runOne(op);}catch(error){if(error.code!=="billing_required"||!IS_ADMIN||isOdoo(op.key))throw error;await business.ensureBilling(op.key);await runOne(op);} ok++; done.push(op); }
      catch(err){ if(op._p) unpatch(op.key,op._p); const amb=err&&err.code==="network"; fails.push(op.key+": "+(amb?"Jira didn't confirm, check the ticket":errorText(err))); if(err&&err.code==="session") stop=true; } } };
    await Promise.all(Array.from({length:Math.min(4,ops.length)},worker));
    batchBusy--;
    if(fails.length) toast(okText+" on "+ok+" of "+ops.length+". These need a look:",fails,true); else toast(okText+(ops.length>1?" on "+ok+" tickets":"")+".");
    const toNotify=done.filter(o=>o.added&&o.added.length);
    if(toNotify.length&&notifyOn) setTimeout(()=>notifyDevs(toNotify),fails.length?4000:1500);
    mergeIssues(); renderIfIdle(); showDrawerStatus();
    const open=dz.key;
    refreshKeys(ops.map(o=>o.key)).then(()=>{ if(open&&dz.key===open&&!fails.some(f=>f.startsWith(open+":"))) loadDetail(open); });
    return {ok,fail:fails.length};
  }
  const devFirstName=d=>d==="bashar.k"?"Bashar":d.charAt(0).toUpperCase()+d.slice(1);
  const esc=s=>String(s==null?"":s).replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
  // Without email sending set up on the proxy: opens a ready-made email in the person's mail app (Outlook).
  const mailtoHref=(to,subject,body)=>"mailto:"+to.join(",")+"?subject="+encodeURIComponent(subject.slice(0,250))+"&body="+encodeURIComponent(body);
  function openEmail(to,subject,body){ const a=document.createElement("a"); a.href=mailtoHref(to,subject,body); a.click(); }
  // After developers are added: emails each new developer (or, without email sending, offers a ready-made email per developer).
  async function notifyDevs(ops){
    const byDev={}; ops.forEach(o=>o.added.forEach(d=>{ (byDev[d]=byDev[d]||[]).push(o.key); }));
    const links=[], skipped=[], sent=[], failed=[];
    for(const d of Object.keys(byDev)){
      const to=DEV_EMAIL[d]; if(!to){ skipped.push("ai1_"+d+": no email on file"); continue; }
      const keys=byDev[d], items=keys.map(k=>issueByKey(k)).filter(Boolean);
      const subject=keys.length===1?("New Jira assignment: "+keys[0]+(items[0]?" – "+items[0].summary:"")):("New Jira assignments: "+keys.length+" tickets");
      if(MAIL){
        const rows=items.map(i=>"<tr><td><a href=\""+esc(dashUrl(i.key))+"\">"+esc(i.key)+"</a>"+(i.internal?"":" (<a href=\""+esc(ticketUrl(i.key))+"\">"+sourceName(i.key)+"</a>)")+"</td><td>"+esc(i.summary)+"</td><td>"+esc(i.status)+"</td><td>"+esc(i.due?fmtDate(i.due):"Not set")+"</td><td>"+esc(i.parent?i.parent.name:"")+"</td><td>"+esc(i.reporter)+"</td></tr>").join("");
        const html="<p>Hi "+esc(devFirstName(d))+",</p><p>You have been assigned as the developer (ai1_"+esc(d)+") on the following Jira "+(keys.length===1?"ticket":"tickets")+":</p>"
          +"<table border=\"1\" cellpadding=\"6\" cellspacing=\"0\"><thead><tr><th>Ticket</th><th>Title</th><th>Status</th><th>Due date</th><th>Epic</th><th>Reporter</th></tr></thead><tbody>"+rows+"</tbody></table>"
          +"<p>Please review "+(keys.length===1?"it":"them")+" and request a due date in AION Team Control based on the development time.</p><p>Thanks,<br>"+esc(ME)+"</p>";
        try{ await api("/mail",{method:"POST",body:{to:[to],subject,html}}); sent.push("ai1_"+d+" ("+to+") · "+keys.join(", ")); }
        catch(err){ failed.push("ai1_"+d+": "+(err.code==="network"?"the server didn't confirm; ask the developer before resending":err.message)); }
        continue;
      }
      const rows=items.map(i=>"• "+i.key+" – "+i.summary+"\n  "+dashUrl(i.key)+"\n  Status: "+i.status+" · Due: "+(i.due?fmtDate(i.due):"Not set")+(i.parent?" · Epic: "+i.parent.name:"")+" · Reporter: "+i.reporter).join("\n\n");
      const body="Hi "+devFirstName(d)+",\n\nYou have been assigned as the developer (ai1_"+d+") on the following Jira "+(keys.length===1?"ticket":"tickets")+":\n\n"+rows
        +"\n\nPlease review "+(keys.length===1?"it":"them")+" and set a due date in Jira based on the development time.\n\nThanks,\n"+ME+"\n";
      links.push({label:"Email ai1_"+d,href:mailtoHref([to],subject,body),title:to+" · "+keys.join(", ")});
    }
    if(MAIL){
      if(failed.length||skipped.length) toast("Emails: "+sent.length+" sent"+(failed.length?", "+failed.length+" failed":""),sent.concat(failed,skipped),!!failed.length);
      else if(sent.length) toast("Email sent to "+sent.length+" developer"+(sent.length===1?"":"s"),sent);
      return;
    }
    if(links.length) toast("Let "+(links.length===1?"the developer":"the developers")+" know? Each button opens a ready-made email in Outlook.",skipped,false,links);
    else if(skipped.length) toast("No email sent",skipped,true);
  }
  function showState(msg,isErr){ const s=$("pagestate"); s.hidden=!msg; s.className="state"+(isErr?" err":""); s.textContent=msg||""; }
  function errorText(err){ const c=err&&err.code;
    if(c==="too_large"||c==="bad_request"||c==="forbidden"||c==="not_found") return err.message;
    if(c==="session") return "Your sign-in has expired. Sign in again.";
    if(c==="network") return "Can't reach the AION server. Check your connection and try again.";
    if(c==="rate_limited") return "Jira is busy. Wait a moment and try again.";
    if(c==="jira") return "Jira refused: "+(err.message||"unknown error");
    return "Couldn't reach Jira"+(err&&err.message?": "+err.message:"."); }
  function mergeIssues(){ const m=new Map(); state.mainIssues.forEach(i=>m.set(i.key,i)); state.closedIssues.forEach(i=>{ if(!m.has(i.key)) m.set(i.key,i); }); state.internalIssues.forEach(i=>m.set(i.key,i)); state.odooIssues.forEach(i=>m.set(i.key,i)); state.issues=[...m.values()].map(withPending).map(i=>({...business.decorate(i),pendingDateRequest:!!dateRequests.activeFor(i.key)})); }
  let closedBusy=false;
  async function loadClosed(){
    if(closedBusy) return; const days=state.closedDays; closedBusy=true;
    try{
      const list=await searchAll('project = '+PROJECT+' AND issuetype != Epic AND statusCategory = Done AND updated >= -'+days+'d ORDER BY updated DESC',FIELDS);
      state.closedIssues=list.map(norm); await business.load(list.map(i=>i.key));mergeIssues(); saveCache(); loadPrs(list.map(i=>i.key)); if($("pop").hidden&&!drag) render();
    }catch(err){ if(state.focus==="closed") toast("Couldn't load closed tickets",[errorText(err)],true); }
    finally{ closedBusy=false; if(state.closedDays!==days) loadClosed(); }
  }
  // The last loaded tickets are kept in this browser (per person, removed on sign-out), so opening the
  // dashboard shows them at once and refreshes in the background.
  let LAST_CFG=null;
  const cacheKey=()=>"aion.cache.v1."+((getSession()||{}).email||"");
  function saveCache(){ try{ localStorage.setItem(cacheKey(),JSON.stringify({at:Date.now(),cfg:LAST_CFG,main:state.mainIssues,closed:state.closedIssues,internal:state.internalIssues,odoo:state.odooIssues,INT})); }catch(_){} }
  function readCache(){ try{ const c=JSON.parse(localStorage.getItem(cacheKey())||"null"); if(c&&c.cfg&&Date.now()-c.at<7*86400000) return c; }catch(_){} return null; }
  // Ticket fields (client, hours) load once the proxy's /config is in; start() replaces this.
  let businessReady=Promise.resolve();
  // Tickets changed from this page, so a full refresh that started before the change can't bring old data back.
  const changed=[];
  const renderIfIdle=()=>{ if($("pop").hidden&&!drag) render(); };
  async function doReload(){
    const started=Date.now();
    try{ const [issues]=await Promise.all([searchAll(JQL,FIELDS),loadInternal(),loadOdoo(),dateRequests.load()]);
      state.mainIssues=issues.map(norm); mergeIssues(); showState("");
      lastLoad=Date.now(); $("updated").textContent="updated "+new Date().toLocaleTimeString([], {hour:"2-digit",minute:"2-digit"});
      // Show the tickets straight away; their client and hours fill in a moment later (unless a client filter needs them).
      if(!Object.values(state.businessFilter||{}).some(Boolean)) renderIfIdle();
      setTimeout(()=>loadClosed(),0); loadPrs(issues.map(i=>i.key));
      await businessReady; await business.load([...issues.map(i=>i.key),...state.internalIssues.map(i=>i.key)]);
      mergeIssues(); saveCache(); renderIfIdle();
      if(dz.key)dateRequests.renderDrawer(dz.key);
      const since=changed.filter(c=>c.at>=started).map(c=>c.key); if(since.length) await refreshKeys(since);
    }catch(err){ showState(errorText(err),true); }
  }
  // A refresh asked for while one is running runs right after it (so a new ticket is never missed).
  let reloading=null, reloadQueued=null;
  function reload(){
    if(!reloading){ reloading=doReload().finally(()=>{ reloading=null; }); return reloading; }
    return reloadQueued||(reloadQueued=reloading.then(()=>{ reloadQueued=null; return reload(); }));
  }
  // Re-reads only these tickets after a change, so the page updates in a moment instead of reloading everything.
  async function refreshKeys(keys){
    keys=[...new Set(keys)]; const at=Date.now(); keys.forEach(key=>changed.push({key,at})); changed.splice(0,Math.max(0,changed.length-200));
    const jk=keys.filter(k=>!isInt(k)&&!isOdoo(k));
    try{
      await Promise.all([
        (async()=>{ for(let n=0;n<jk.length;n+=100){ const part=jk.slice(n,n+100), list=(await searchAll("key in ("+part.join(",")+")",FIELDS)).map(norm);
          // A ticket that was just changed counts as recently updated, so it belongs with the main list.
          state.mainIssues=state.mainIssues.filter(i=>!part.includes(i.key)).concat(list); state.closedIssues=state.closedIssues.filter(i=>!part.includes(i.key)); } })(),
        keys.some(isInt)?loadInternal():null,
        keys.some(isOdoo)?loadOdoo():null,
        businessReady.then(()=>business.load(keys.filter(k=>!isOdoo(k))))
      ]);
      mergeIssues(); saveCache(); renderIfIdle(); loadPrs(jk);
    }catch(_){ await reload(); }
  }
  // Changes shown on the page before the loaded data has them. Jira's search can lag a few seconds behind an
  // edit, so a change stays on top of the loaded ticket until the data matches it (at most 2 minutes), or
  // until it fails.
  const PENDING=new Map();
  function patchIssue(key,fn){ const p={fn,until:Date.now()+120000}; PENDING.set(key,[...(PENDING.get(key)||[]),p]); return p; }
  function unpatch(key,p){ const list=(PENDING.get(key)||[]).filter(x=>x!==p); if(list.length) PENDING.set(key,list); else PENDING.delete(key); }
  function withPending(i){
    const list=PENDING.get(i.key); if(!list) return i;
    const same=(a,b)=>JSON.stringify(Array.isArray(a)?[...a].sort():a??null)===JSON.stringify(Array.isArray(b)?[...b].sort():b??null);
    // A change is done once its main field (fn.match) is in the loaded data.
    const live=list.filter(p=>{ if(p.until<Date.now()) return false; const want=p.fn(i); return (p.fn.match||Object.keys(want)).some(k=>!same(want[k],i[k])); });
    if(live.length) PENDING.set(i.key,live); else PENDING.delete(i.key);
    return live.reduce((x,p)=>({...x,...p.fn(x)}),i);
  }
  // The ticket as last loaded, without changes still on their way.
  const loadedIssue=key=>[state.mainIssues,state.internalIssues,state.odooIssues,state.closedIssues].map(list=>list.find(i=>i.key===key)).find(Boolean);
  // An internal ticket as the proxy just returned it (after creating or changing it).
  function putInternal(t){
    if(!t||!isInt(t.key)) return; INT[t.key]=t; HIST[t.key]={updated:t.updated,changes:(t.dueHistory||[]).map(h=>({when:h.when,by:h.by,from:h.from,to:h.to}))};
    state.internalIssues=state.internalIssues.filter(i=>i.key!==t.key).concat(normInternal(t));
  }
  const matching=(fn,...keys)=>Object.assign(fn,{match:keys});
  const statusPatch=(name,cat)=>matching(i=>({status:name,cat:cat||i.cat}),"status");
  const devsPatch=want=>matching(i=>({devs:[...want],labels:labelsWith(i.labels||[],new Set(want))}),"devs");
  const assigneePatch=(id,name)=>matching(()=>({assignee:BYID[id]||null,assigneeId:id||null,assigneeName:id?name:"Unassigned"}),"assigneeId");
  $("refresh").addEventListener("click",async()=>{ const b=$("refresh"); b.disabled=true; b.textContent="Refreshing…"; await reload(); b.disabled=false; b.textContent="Refresh"; });

  document.querySelectorAll(".seg [data-v]").forEach(b=>b.addEventListener("click",()=>{ state.view=b.dataset.v; try{localStorage.setItem("aion.view",state.view);}catch(e){} render(); }));
  $("notify").checked=notifyOn; $("notify").addEventListener("change",e=>{ notifyOn=e.target.checked; try{localStorage.setItem("aion.notify",notifyOn?"1":"0");}catch(x){} toast(notifyOn?(MAIL?"Developers will be emailed when assigned.":"You'll be offered an email to developers when you assign them."):"Assignment emails are off."); });
  $("grp").addEventListener("change",e=>{ state.group=e.target.value; try{localStorage.setItem("aion.group",state.group);}catch(x){} render(); });
  $("ticket-filters-toggle").addEventListener("click",()=>{ticketFiltersOpen=!ticketFiltersOpen;try{localStorage.setItem(ticketFiltersKey,ticketFiltersOpen?"1":"0");}catch{}renderFilters();});
  $("ftoggle").addEventListener("click",()=>{ state.fopen=!state.fopen; try{localStorage.setItem("aion.fopen",state.fopen?"1":"0");}catch(e){} renderFilters(); });
  $("fclear").addEventListener("click",()=>{ state.f=defaultFilters();state.businessFilter={}; state.q=""; $("q").value=""; state.sel.clear(); render(); });
  let qt=null; $("q").addEventListener("input",e=>{ clearTimeout(qt); qt=setTimeout(()=>{ state.q=e.target.value.trim(); render(); },150); });

  const dz={key:null,labels:[],devs:new Set()};
  // An open ticket is a step in the browser's history (#KEY), so Back closes it instead of leaving the dashboard.
  // keepHistory: switching straight to another ticket (its own step replaces this one).
  let drawerPushed=false, skipPop=false;
  function closeDrawer(force,keepHistory){ if(dz.key&&force!==true&&!drawerUI.allowClose())return false;ticketNotes.reset(dz.key);business.reset();workLog.reset();$("drawer").hidden=true;$("scrim").hidden=true;dz.key=null;drawerUI.close();
    if(!keepHistory){ if(drawerPushed){ drawerPushed=false; skipPop=true; history.back(); } else if(location.hash) history.replaceState(history.state,"",location.pathname+location.search); }
    return true; }
  window.addEventListener("popstate",()=>{
    if(skipPop){ skipPop=false; return; }
    // Back (or Forward) away from the open ticket's step closes it; a ticket with unsaved edits asks first.
    if(dz.key&&location.hash!=="#"+dz.key){ drawerPushed=false; if(!closeDrawer(false,true)){ history.pushState(history.state,"",location.pathname+location.search+"#"+dz.key); drawerPushed=true; } }
  });
  $("d-close").addEventListener("click",closeDrawer); $("scrim").addEventListener("click",closeDrawer);
  function setMsg(id,text,ok){ const m=$(id); m.textContent=text||""; m.className="msg"+(text?(ok?" ok":" err"):""); }
  function renderDevChips(){ const box=$("d-devs"); box.replaceChildren(); const names=new Set(allDevs()); dz.devs.forEach(d=>names.add(d));
    [...names].sort().forEach(d=>{ const c=el("button","fc "+devK(d)); c.type="button"; c.appendChild(el("span","sw")); c.appendChild(el("span",null,"ai1_"+d)); c.setAttribute("aria-pressed",String(dz.devs.has(d)));
      c.addEventListener("click",()=>{ dz.devs.has(d)?dz.devs.delete(d):dz.devs.add(d); c.setAttribute("aria-pressed",String(dz.devs.has(d))); setMsg("d-devmsg",""); }); box.appendChild(c); }); }
  const fact=(dt,dd)=>{ const w=el("div"); w.appendChild(el("dt",null,dt)); w.appendChild(el("dd",null,dd||"—")); return w; };
  const drawerFull=()=>{ try{ return localStorage.getItem("aion.drawer.full")!=="0"; }catch(_){ return true; } };
  function applyDrawerSize(){ const full=drawerFull(); $("drawer").classList.toggle("full",full); $("d-size").textContent=full?"Side panel":"Full screen"; }
  $("d-size").addEventListener("click",()=>{ try{ localStorage.setItem("aion.drawer.full",drawerFull()?"0":"1"); }catch(_){} applyDrawerSize(); });
  applyDrawerSize();
  function openDrawer(key){ setTimeout(()=>{ if(dz.key===key) renderPrs(key); },0);
    if(dz.key&&dz.key!==key&&!closeDrawer(false,true))return;
    if(location.hash!=="#"+key){ const url=location.pathname+location.search+"#"+key; if(drawerPushed) history.replaceState(history.state,"",url); else { history.pushState(history.state,"",url); drawerPushed=true; } }
    const opening=!dz.key;dz.key=key;
    if(opening){drawerUI.open();$("d-reply").value="";commentMentions.reset();$("d-newdev").value="";}
    ticketHistory.reset();drawerUI.select("overview");$("d-aidesc-out").hidden=true;$("d-aidesc-out").replaceChildren();dateRequests.renderDrawer(key);
    closePop(); dz.key=key; const i=issueByKey(key);
    $("drawer").hidden=false; $("scrim").hidden=false; $("drawer").classList.toggle("is-int",isInt(key)); $("drawer").classList.toggle("is-odoo",isOdoo(key));
    $("d-key").textContent=key+(isInt(key)?"":" ↗"); $("d-key").href=$("d-open").href=ticketUrl(key); if(isInt(key)) $("d-key").removeAttribute("href");
    $("d-title").textContent=i?i.summary:key; $("d-status").textContent=i?i.status:""; $("d-status").className="stbtn "+(i?stK(i):"");
    $("d-facts").replaceChildren(); $("d-desc").replaceChildren(el("span",null,"Loading…")); $("d-comments").replaceChildren(); $("d-ccount").textContent=""; $("d-trans").replaceChildren(el("span","msg","Loading…"));
    ["d-devmsg","d-duemsg","d-cmsg"].forEach(id=>setMsg(id,"")); $("d-att").replaceChildren(el("span","msg","Loading…")); $("d-acount").textContent=""; $("d-asgname").textContent=i?i.assigneeName:""; $("d-after").replaceChildren(new Option("Keep current assignee",""));    dz.labels=i?i.labels.slice():[]; dz.devs=new Set(i?i.devs:[]); renderDevChips(); $("d-due").value=i&&i.due?i.due:"";
    $("d-body").scrollTop=0; $("d-close").focus(); renderDrawerHist(key); loadDetail(key);
  }
  async function loadTransitions(key){
    try{ const trs=await getTransitions(key); if(dz.key!==key) return; const box=$("d-trans"); box.replaceChildren();
      if(!trs.length){ box.appendChild(el("span","msg","No moves available from this status.")); return; }
      trs.forEach(tr=>{ const name=(tr.to&&tr.to.name)||tr.name; const b=el("button","stbtn "+stK({status:name,cat:(tr.to&&tr.to.statusCategory&&tr.to.statusCategory.key)||""}),"→ "+name); b.type="button"; b.title=tr.name;
        b.addEventListener("click",()=>runBatch([{key,run:()=>doTransition(key,tr.id),patch:statusPatch(name,tr.to&&tr.to.statusCategory&&tr.to.statusCategory.key)}],"Moved to "+name)); box.appendChild(b); });
    }catch(err){ if(dz.key===key) $("d-trans").replaceChildren(el("span","msg err",errorText(err))); }
  }
  async function loadDetail(key){
    business.renderEditor(key);
    workLog.render(key);
    loadTransitions(key);
    if(isInt(key)){ renderInternal(key); return; }
    $("d-reply").placeholder="Write a comment or answer…";
    if(isOdoo(key)){ renderOdoo(key); return; }
    if(IS_ADMIN) fetchHistory(key).then(ch=>{ const i=issueByKey(key); HIST[key]={updated:i?i.updated:"",changes:ch}; if(dz.key===key) renderDrawerHist(key); }).catch(()=>{ if(dz.key===key&&!HIST[key]) $("d-hist").replaceChildren(el("span","msg err","Couldn't load the history.")); });
    // Comments posted from the dashboard are written by the proxy's Jira account; the local history knows who wrote them.
    const logged=api("/ticket-log?key="+encodeURIComponent(key)).catch(()=>({events:[]}));
    try{ const list=await searchAll("key = "+key,["summary","description","status","assignee","reporter","labels","duedate","created","updated","priority","issuetype","comment","parent","attachment"],true);
      if(dz.key!==key) return; const raw=list[0]; if(!raw){ $("d-desc").replaceChildren(el("span",null,"Ticket not found.")); return; }
      const f=raw.fields||{}, ni=norm(raw);
      $("d-title").textContent=f.summary||key; $("d-status").textContent=ni.status; $("d-status").className="stbtn "+stK(ni);
      $("d-facts").replaceChildren(fact("Assignee",(f.assignee&&f.assignee.displayName)||"Unassigned"),fact("Reporter",(f.reporter&&f.reporter.displayName)||""),fact("Epic",ni.parent?ni.parent.name:""),fact("Type",ni.type),fact("Priority",ni.priority),fact("Created date",createdDate(f.created)),fact("Updated",ago(f.updated)),fact("Due",f.duedate?fmtDate(f.duedate):"not set"));
      dz.labels=(f.labels||[]).slice(); dz.devs=new Set(ni.devs); renderDevChips(); $("d-due").value=f.duedate||"";
      const pictures={key,attachments:f.attachment||[]};
      $("d-desc").replaceChildren(richNode(f.description,pictures));
      renderAttachments(f.attachment||[]);
      { const an=(f.assignee&&f.assignee.displayName)||"Unassigned"; const ak=BYID[f.assignee&&f.assignee.accountId]; const box=$("d-asgname"); box.replaceChildren(el("span","av "+(ak?"kp-"+ak:"k8"),initialsOf(an)),el("span",null,an)); }
      { const sel=$("d-after"); sel.replaceChildren(new Option("Keep current assignee",""));
        const seen=new Set(); const add=(id,n,tag)=>{ if(!id||seen.has(id)||(f.assignee&&f.assignee.accountId===id)) return; seen.add(id); sel.appendChild(new Option(n+(tag?" ("+tag+")":""),id+"|"+n)); };
        if(f.reporter) add(f.reporter.accountId,f.reporter.displayName,"reporter");
        ((f.comment&&f.comment.comments)||[]).slice().reverse().forEach(c=>{ if(c.author&&!BYID[c.author.accountId]) add(c.author.accountId,c.author.displayName,"commented"); });
        for(const k in PEOPLE) add(PEOPLE[k].id,PEOPLE[k].name,""); }
      const cm=(f.comment&&f.comment.comments)||[]; $("d-ccount").textContent="("+((f.comment&&f.comment.total)||cm.length)+")";
      const box=$("d-comments"); box.replaceChildren(); if(!cm.length) box.appendChild(el("div","msg","No comments yet."));
      const writers=Object.fromEntries(((await logged).events||[]).filter(e=>e.commentId).map(e=>[String(e.commentId),e.by&&e.by.name])); if(dz.key!==key) return;
      cm.forEach(c=>{ const aid=c.author&&c.author.accountId, name=writers[String(c.id)]||(c.author&&c.author.displayName)||"Someone";
        const cd=el("div","cmt"+(BYID[aid]?" mine":" ext")); const meta=el("div","cmeta"); meta.appendChild(el("b",null,name)); meta.appendChild(el("span",null,ago(c.created)));
        const rb=el("button","linkbtn sp","Reply"); rb.type="button"; rb.addEventListener("click",()=>{ const t=$("d-reply"); if(!t.value.trim()) t.value=name.split(" ")[0]+", "; t.focus(); t.scrollIntoView({block:"center",behavior:"smooth"}); });
        meta.appendChild(rb); cd.appendChild(meta); const b=richNode(c.body,pictures); b.classList.add("rich"); b.dir="auto"; cd.appendChild(b); box.appendChild(cd); });
    }catch(err){ if(dz.key===key) $("d-desc").replaceChildren(el("span","msg err",errorText(err))); }
  }
  // Drawer contents for an internal ticket (all data is already loaded).
  // Drawer contents for an Odoo ticket: details, description and chatter come from Odoo.
  async function renderOdoo(key){
    const i=issueByKey(key); $("d-odoo").href=(i&&i.odooUrl)||"#";
    try{
      const d=await odooDetail(key,true); if(dz.key!==key) return; const t=d.ticket, c=t.customer||{};
      $("d-title").textContent=t.summary; $("d-status").textContent=t.status; $("d-status").className="stbtn "+stK({status:t.status,cat:t.statusCat});
      $("d-facts").replaceChildren(fact("Type","Odoo Helpdesk"),fact("Customer",c.name&&c.email?c.name+" <"+c.email+">":(c.name||c.email)),fact("Developer",(t.devs||[]).map(x=>"ai1_"+x).join(", ")||t.developerName||"not assigned"),fact("Team",t.team),fact("Priority",t.priority),fact("Created",ago(t.created)),fact("Updated",ago(t.updated)),fact("SLA deadline",t.due?fmtDate(t.due):"none"),fact("Odoo ref","#"+t.ref));
      dz.labels=(t.devs||[]).map(x=>"ai1_"+x); dz.devs=new Set(t.devs||[]); renderDevChips();
      $("d-desc").replaceChildren(richNode(d.description||""));
      const box=$("d-comments"); box.replaceChildren(); $("d-ccount").textContent="("+d.messages.length+")";
      if(!d.messages.length) box.appendChild(el("div","msg","No messages yet."));
      d.messages.forEach(m=>{ const cd=el("div","cmt"+(m.note?" mine":" ext")); const meta=el("div","cmeta"); meta.appendChild(el("b",null,m.author)); meta.appendChild(el("span",null,ago(m.when)+(m.note?" · internal note":m.email?" · email":""))); cd.appendChild(meta); const b=richNode(m.body); b.classList.add("rich"); b.dir="auto"; cd.appendChild(b); box.appendChild(cd); });
      $("d-reply").placeholder="Write an internal note (saved in Odoo's chatter, not emailed to the customer)…";
    }catch(err){ if(dz.key===key) $("d-desc").replaceChildren(el("span","msg err",errorText(err))); }
  }
  function renderInternal(key){
    const t=INT[key]; if(!t){ $("d-desc").replaceChildren(el("span",null,"Ticket not found.")); return; }
    const ni=normInternal(t);
    $("d-title").textContent=t.summary; $("d-status").textContent=t.status; $("d-status").className="stbtn "+stK(ni);
    $("d-facts").replaceChildren(fact("Type","Internal (not in Jira)"),fact("Assignee",ni.assigneeName),fact("Priority",t.priority),fact("Developers",(t.devs||[]).map(d=>"ai1_"+d).join(", ")),fact("Opened by",t.createdBy&&t.createdBy.name),fact("Created date",createdDate(t.created)),fact("Updated",ago(t.updated)),fact("Due",t.due?fmtDate(t.due):"not set"),fact("Closed",t.closedAt?ago(t.closedAt):""));
    dz.labels=ni.labels.slice(); dz.devs=new Set(ni.devs); renderDevChips(); $("d-due").value=t.due||"";
    HIST[key]={updated:t.updated,changes:(t.dueHistory||[]).map(h=>({when:h.when,by:h.by,from:h.from,to:h.to}))}; renderDrawerHist(key);
    { const box=$("d-asgname"); box.replaceChildren(el("span","av "+(ni.assignee?"kp-"+ni.assignee:"k8"),initialsOf(ni.assigneeName)),el("span",null,ni.assigneeName)); }
    const d=el("div","plain",t.description||""); if(!t.description){ d.textContent="No description."; d.style.color="var(--muted)"; } $("d-desc").replaceChildren(d);
    renderIntAttachments(key);
    const cm=t.comments||[]; $("d-ccount").textContent="("+cm.length+")";
    const box=$("d-comments"); box.replaceChildren(); if(!cm.length) box.appendChild(el("div","msg","No comments yet."));
    cm.forEach(c=>{ const name=(c.author&&c.author.name)||"Someone";
      const cd=el("div","cmt mine"); const meta=el("div","cmeta"); meta.appendChild(el("b",null,name)); meta.appendChild(el("span",null,ago(c.created)));
      const rb=el("button","linkbtn sp","Reply"); rb.type="button"; rb.addEventListener("click",()=>{ const ta=$("d-reply"); if(!ta.value.trim()) ta.value=name.split(" ")[0]+", "; ta.focus(); });
      meta.appendChild(rb); cd.appendChild(meta); const b=commentWithPictures(key,c.body); b.dir="auto"; cd.appendChild(b); box.appendChild(cd); });
  }
  // Attachments on internal tickets: stored by the proxy; downloads go through it with your sign-in.
  function renderIntAttachments(key){
    const t=INT[key], atts=(t&&t.attachments)||[], box=$("i-att"); box.replaceChildren(); $("i-acount").textContent="("+atts.length+")";
    if(!atts.length){ box.appendChild(el("span","msg","No attachments yet.")); return; }
    atts.slice().sort((a,b)=>a.created<b.created?1:-1).forEach(a=>{
      const ext=(String(a.filename).split(".").pop()||"").slice(0,4).toUpperCase(); const mt=a.mimeType||"";
      const k=/image/.test(mt)?"k5":/pdf/.test(mt)?"k2":/zip|compressed|rar/.test(mt)?"k4":/sheet|excel|csv/.test(mt)?"k7":/word|document/.test(mt)?"k1":"k8";
      const row=el("div","att "+k); row.appendChild(el("span","ic",ext||"FILE"));
      const mid=el("div"); mid.style.minWidth="0"; const nm=el("div","nm",a.filename); nm.dir="auto"; mid.appendChild(nm);
      const fw=fmtWhen(a.created); mid.appendChild(el("div","mt",fmtSize(a.size)+" · "+((a.author&&a.author.name)||"")+" · "+fw.d+" "+fw.t)); row.appendChild(mid);
      const acts=el("div","inline");
      if(canPreview(a.mimeType,a.filename)){ const pv=el("button","btn primary","Preview"); pv.type="button"; pv.addEventListener("click",()=>previewFile({name:a.filename,type:a.mimeType,load:()=>apiFile("/internal/"+key+"/attachments/"+a.id)})); acts.appendChild(pv); }
      const dl=el("button","btn","Download"); dl.type="button";
      dl.addEventListener("click",async()=>{ dl.disabled=true; dl.textContent="Downloading…";
        try{ const res=await apiFile("/internal/"+key+"/attachments/"+a.id); const url=URL.createObjectURL(await res.blob());
          const link=document.createElement("a"); link.href=url; link.download=a.filename; document.body.appendChild(link); link.click(); link.remove(); setTimeout(()=>URL.revokeObjectURL(url),60000); }
        catch(err){ toast("Download failed",[errorText(err)],true); }
        dl.disabled=false; dl.textContent="Download"; });
      acts.appendChild(dl);
      if(IS_ADMIN||(a.author&&a.author.email===MY_EMAIL)){
        const rm=el("button","btn danger","Remove"); rm.type="button";
        rm.addEventListener("click",async()=>{ if(!confirm("Remove "+a.filename+"?")) return;
          try{ const r=await apiFile("/internal/"+key+"/attachments/"+a.id,{method:"DELETE"}); INT[key]=(await r.json()).ticket; renderIntAttachments(key); toast("Attachment removed."); }
          catch(err){ toast("Not removed",[errorText(err)],true); } });
        acts.appendChild(rm);
      }
      row.appendChild(acts); box.appendChild(row);
    });
  }
  // Files added to a Jira ticket go to Jira as they are, through the proxy (up to 4 MB each).
  $("j-file").addEventListener("change",async e=>{
    const key=dz.key, files=[...e.target.files]; e.target.value=""; if(!key||isInt(key)||isOdoo(key)||!files.length) return;
    const msg=$("j-attmsg"), idle=msg.textContent; let ok=0; const fails=[];
    for(const [n,f] of files.entries()){
      if(f.size>4*1024*1024){ fails.push(f.name+": bigger than 4 MB"); continue; }
      msg.className="msg"; msg.textContent="Uploading "+(n+1)+" of "+files.length+": "+f.name+"…";
      try{ await apiFile("/jira/issue/"+key+"/attachments?name="+encodeURIComponent(f.name),{method:"POST",body:f,type:f.type||"application/octet-stream"}); ok++; }
      catch(err){ fails.push(f.name+": "+errorText(err)); }
    }
    msg.textContent=idle; msg.className="msg";
    if(fails.length) toast((ok?ok+" added to Jira. ":"")+"Not added:",fails,true); else toast(ok===1?"Attachment added to Jira.":ok+" attachments added to Jira.");
    if(ok&&dz.key===key){ loadDetail(key); refreshKeys([key]); }
  });
  $("i-file").addEventListener("change",async e=>{
    const key=dz.key, files=[...e.target.files]; e.target.value=""; if(!key||!isInt(key)||!files.length) return;
    const msg=$("i-attmsg"); let ok=0; const fails=[];
    for(const [n,f] of files.entries()){
      if(f.size>4*1024*1024){ fails.push(f.name+": bigger than 4 MB"); continue; }
      msg.className="msg"; msg.textContent="Uploading "+(n+1)+" of "+files.length+": "+f.name+"…";
      try{ const r=await apiFile("/internal/"+key+"/attachments?name="+encodeURIComponent(f.name),{method:"POST",body:f,type:f.type||"application/octet-stream"}); INT[key]=(await r.json()).ticket; ok++; }
      catch(err){ fails.push(f.name+": "+errorText(err)); }
    }
    msg.textContent="Up to 4 MB each."; msg.className="msg";
    if(dz.key===key) renderIntAttachments(key);
    if(fails.length) toast((ok?ok+" added. ":"")+"Not added:",fails,true); else toast(ok===1?"Attachment added.":ok+" attachments added.");
  });
  // Form for a new internal ticket, or (with key) for editing one's title, description and priority.
  function internalPopover(anchor,key){
    const t=key?INT[key]:null;
    const p=$("pop"); p.replaceChildren(); p.classList.add("wide");
    const head=el("div","modal-head"); head.appendChild(el("h4",null,t?"Edit "+key:"New internal ticket · not sent to Jira"));
    const x=el("button","icon-btn","✕"); x.type="button"; x.setAttribute("aria-label","Close"); x.addEventListener("click",()=>{ if(!modalTyped()||confirm("Close this form? What you typed will be lost.")) closePop(); }); head.appendChild(x); p.appendChild(head);
    const body=el("div","body"); p.appendChild(body);
    const fld=(label,node)=>{ const f=el("div","fld"); f.appendChild(el("label",null,label)); f.appendChild(node); body.appendChild(f); return node; };
    const title=fld("Title",el("input","inp")); title.value=t?t.summary:""; title.dir="auto";
    const desc=fld("Description",el("textarea","inp")); desc.value=t?t.description||"":""; desc.dir="auto"; desc.placeholder="What needs doing…";
    { const ai=el("button","btn ai-suggest","✧ Suggest with AI"), note=el("span","msg"); ai.type="button";
      ai.addEventListener("click",async()=>{ if(!t&&!title.value.trim()){ note.className="msg err"; note.textContent="Write a title first."; title.focus(); return; }
        ai.disabled=true; note.className="msg"; note.textContent="Writing…";
        try{ const r=await api("/ai-describe",{method:"POST",body:t?{key,description:desc.value}:{title:title.value,description:desc.value}}); desc.value=r.suggestion; note.textContent="Suggested by AI: check and change it as you like."; desc.focus(); }
        catch(err){ note.className="msg err"; note.textContent=errorText(err); } finally{ ai.disabled=false; } });
      const row=el("div","inline"); row.append(ai,note); desc.closest(".fld").appendChild(row); }
    const prio=fld("Priority",el("select","fsel")); INT_PRIORITIES.forEach(x=>prio.appendChild(new Option(x,x))); prio.value=t?t.priority:"Medium";
    let devs=null, due=null, asg=null;
    if(!t){
      // Assignee: Karim, Youssef or Rami, like the Jira tickets. Youssef is pre-selected.
      asg=fld("Assignee",el("select","fsel")); asg.appendChild(new Option("Choose…",""));
      Object.keys(PEOPLE).forEach(k=>asg.appendChild(new Option(PEOPLE[k].name,k)));
      asg.value=INTERNAL_ASSIGNEE;
      if(!IS_ADMIN)asg.disabled=true;
      if(IS_ADMIN){
        devs=new Set(); const rc=el("div","rcpts");
        allDevs().forEach(d=>{ const c=el("button","fc "+devK(d)); c.type="button"; c.appendChild(el("span","sw")); c.appendChild(el("span",null,"ai1_"+d)); c.setAttribute("aria-pressed","false");
          c.addEventListener("click",()=>{ devs.has(d)?devs.delete(d):devs.add(d); c.setAttribute("aria-pressed",String(devs.has(d))); }); rc.appendChild(c); });
        fld("Developer(s)",rc);
      } else fld("Developer",el("span","dev "+devK(MY_DEV),"ai1_"+MY_DEV+" (you)"));
      body.appendChild(el("p","date-context","Create the ticket first, then request or approve its due date."));
    }
    const newFields=!t?business.createFields(body,{creating:true}):null;
    const foot=el("div","foot"); const msg=el("span","msg"); const save=el("button","btn primary sp",t?"Save":"Create ticket"); save.type="button";
    save.addEventListener("click",async()=>{
      if(!title.value.trim()){ msg.textContent="Write a title."; msg.className="msg err"; title.focus(); return; }
      if(devs&&!devs.size){ msg.textContent="Pick at least one developer."; msg.className="msg err"; return; }
      if(asg&&!asg.value&&Object.keys(PEOPLE).length){ msg.textContent="Choose the assignee."; msg.className="msg err"; asg.focus(); return; }
      save.disabled=true; msg.textContent="";
      try{
        if(t){ const r=await internalApi.update(key,{summary:title.value,description:desc.value,priority:prio.value}); closePop(); toast("Saved."); putInternal(r.ticket); mergeIssues(); saveCache(); render(); if(dz.key===key) loadDetail(key); return; }
        await businessReady; if(!business.enabled())throw new Error("Deploy the updated backend before creating tickets.");
        const r=await internalApi.create({metadata:newFields.read(),summary:title.value,description:desc.value,priority:prio.value,devs:devs?[...devs]:[MY_DEV],...(asg&&asg.value?{assignee:asg.value}:{})});
        closePop(); toast(r.ticket.key+" created.");
        // On the page at once; its client and hours follow from refreshKeys.
        putInternal(r.ticket); mergeIssues(); saveCache(); render(); openDrawer(r.ticket.key); refreshKeys([r.ticket.key]);
        if(IS_ADMIN&&notifyOn&&r.ticket.devs.length) setTimeout(()=>notifyDevs([{key:r.ticket.key,added:r.ticket.devs}]),1500);
      }catch(err){ save.disabled=false; msg.textContent=errorText(err); msg.className="msg err"; }
    });
    const cancel=el("button","btn","Cancel"); cancel.type="button"; cancel.addEventListener("click",()=>{ if(!modalTyped()||confirm("Close this form? What you typed will be lost.")) closePop(); });
    foot.appendChild(msg); foot.appendChild(cancel); foot.appendChild(save); p.appendChild(foot); openModal(); title.focus();
  }
  $("new-int").addEventListener("click",e=>internalPopover(e.currentTarget));
  $("d-edit").addEventListener("click",e=>{ if(dz.key&&isInt(dz.key)) internalPopover(e.currentTarget,dz.key); });
  $("d-del").addEventListener("click",async()=>{ const key=dz.key; if(!key||!isInt(key)) return;
    if(!confirm("Delete "+key+"? This can't be undone. To finish a ticket, close it instead.")) return;
    try{ await internalApi.remove(key); closeDrawer(true); toast(key+" deleted."); delete INT[key]; state.internalIssues=state.internalIssues.filter(i=>i.key!==key); state.sel.delete(key); mergeIssues(); saveCache(); render(); }catch(err){ toast("Not deleted",[errorText(err)],true); } });
  function fmtSize(b){ if(b==null) return ""; if(b<1024) return b+" B"; if(b<1048576) return Math.round(b/1024)+" KB"; return (b/1048576).toFixed(1)+" MB"; }
  // Preview (shown inside the dashboard) and Download buttons for one attachment.
  function fileActions(key,name,type,load){
    const acts=el("div","acts");
    if(canPreview(type,name)){ const pv=el("button","btn primary","Preview"); pv.type="button"; pv.addEventListener("click",()=>previewFile({name,type,load})); acts.appendChild(pv); }
    const dl=el("button","btn","Download"); dl.type="button";
    dl.addEventListener("click",async()=>{ dl.disabled=true; dl.textContent="Downloading…";
      try{ const url=URL.createObjectURL(await (await load()).blob()); const link=document.createElement("a"); link.href=url; link.download=name; document.body.appendChild(link); link.click(); link.remove(); setTimeout(()=>URL.revokeObjectURL(url),60000); }
      catch(err){ toast("Download failed",[errorText(err)],true); }
      dl.disabled=false; dl.textContent="Download"; });
    acts.appendChild(dl); return acts;
  }
  function renderAttachments(atts){ const key=dz.key;
    const box=$("d-att"); box.replaceChildren(); $("d-acount").textContent="("+atts.length+")";
    if(!atts.length){ box.appendChild(el("span","msg","No attachments on this ticket.")); return; }
    atts.slice().sort((a,b)=>a.created<b.created?1:-1).forEach(a=>{
      const ext=(String(a.filename).split(".").pop()||"").slice(0,4).toUpperCase(); const mt=a.mimeType||"";
      const k=/image/.test(mt)?"k5":/pdf/.test(mt)?"k2":/zip|compressed|rar/.test(mt)?"k4":/sheet|excel|csv/.test(mt)?"k7":/word|document/.test(mt)?"k1":"k8";
      const row=el("div","att "+k); row.appendChild(el("span","ic",ext||"FILE"));
      const mid=el("div"); mid.style.minWidth="0"; const nm=el("div","nm",a.filename); nm.dir="auto"; mid.appendChild(nm);
      const fw=fmtWhen(a.created); mid.appendChild(el("div","mt",fmtSize(a.size)+" · "+((a.author&&a.author.displayName)||"")+" · "+fw.d+" "+fw.t)); row.appendChild(mid);
      row.appendChild(fileActions(key,a.filename,a.mimeType,()=>apiFile("/jira/issue/"+key+"/attachments/"+a.id))); box.appendChild(row);
    });
  }
  // Suggest description with AI: the AI writes one from the title, description and comments; you can
  // adjust it, then replace the ticket's description (recorded with your name), copy it, or dismiss it.
  $("d-aidesc").addEventListener("click",async()=>{
    const key=dz.key, out=$("d-aidesc-out"), btn=$("d-aidesc"); if(!key||isOdoo(key)) return;
    btn.disabled=true; out.hidden=false; out.replaceChildren(el("p","msg","Writing a description…"));
    try{
      const r=await api("/ai-describe",{method:"POST",body:{key}}); if(dz.key!==key) return;
      const text=el("textarea","inp ai-desc-text"); text.value=r.suggestion; text.dir="auto"; text.rows=Math.min(16,Math.max(6,r.suggestion.split("\n").length+1)); text.setAttribute("aria-label","Suggested description");
      const msg=el("span","msg"), acts=el("div","inline");
      const replace=el("button","btn primary","Replace description"); replace.type="button";
      replace.addEventListener("click",async()=>{ const value=text.value.trim(); if(!value){ msg.textContent="The description is empty."; return; }
        if(!confirm("Replace the ticket's description with this one?")) return;
        replace.disabled=true; msg.className="msg"; msg.textContent="Saving…";
        try{ if(isInt(key)) putInternal((await internalApi.update(key,{description:value})).ticket); else await api("/jira/issue/"+key+"/description",{method:"PUT",body:{text:value,source:"ai"}});
          out.hidden=true; out.replaceChildren(); toast(key+": description replaced."); if(dz.key===key) loadDetail(key); refreshKeys([key]); }
        catch(err){ replace.disabled=false; msg.className="msg err"; msg.textContent=errorText(err); } });
      const copy=el("button","btn","Copy"); copy.type="button"; copy.addEventListener("click",async()=>{ try{ await navigator.clipboard.writeText(text.value); msg.className="msg"; msg.textContent="Copied."; }catch(_){ msg.textContent="Couldn't copy."; } });
      const dismiss=el("button","btn","Dismiss"); dismiss.type="button"; dismiss.addEventListener("click",()=>{ out.hidden=true; out.replaceChildren(); });
      acts.append(replace,copy,dismiss,msg);
      out.replaceChildren(el("p","msg","Suggested by AI from the ticket's title, description and comments. Check it, change anything you like, then replace."),text,acts);
    }catch(err){ if(dz.key===key) out.replaceChildren(el("p","msg err",errorText(err))); }
    finally{ btn.disabled=false; }
  });
  $("d-note").addEventListener("click",e=>{ if(dz.key) notePopover(e.currentTarget,dz.key); });
  $("d-comment-note").addEventListener("click",e=>{ if(dz.key) notePopover(e.currentTarget,dz.key); });
  $("d-asg").addEventListener("click",e=>{ if(dz.key) assigneePopover(e.currentTarget,[dz.key]); });
  $("d-adddev").addEventListener("click",()=>{ const v=$("d-newdev").value.trim().replace(/^ai1_/i,"").replace(/\s+/g,"").toLowerCase(); if(!v){ setMsg("d-devmsg","Type a name first.",false); return; } dz.devs.add(v); $("d-newdev").value=""; renderDevChips(); setMsg("d-devmsg","Added ai1_"+v+". Press Save developers.",true); });
  $("d-newdev").addEventListener("keydown",e=>{ if(e.key==="Enter"){ e.preventDefault(); $("d-adddev").click(); } });
  $("d-savedevs").addEventListener("click",async()=>{ const key=dz.key; if(!key) return; const labels=labelsWith(dz.labels,new Set(dz.devs)); const prev=new Set(dz.labels.filter(isDevLabel).map(devOf)); const want=new Set(dz.devs); const r=await runBatch([{key,added:[...dz.devs].filter(d=>!prev.has(d)),run:()=>(isOdoo(key)?odooApi.update(key,{devs:[...want]}):isInt(key)?internalApi.update(key,{devs:[...want]}):jira.edit(key,{labels})),patch:devsPatch(want)}],"Developers saved"); setMsg("d-devmsg",r.fail?"Not saved.":"Saved.",!r.fail); });
  const commentMentions=createCommentMentions({textarea:$("d-reply"),search:q=>jira.users(q),enabled:()=>!!dz.key&&!isInt(dz.key)&&!isOdoo(dz.key)});
  // Pictures in a comment: uploaded to the ticket right away (Jira or internal) and put in the text the way
  // Jira does it (!name|thumbnail!), so they show inside the comment in Jira and here once it is sent.
  // Paste (Ctrl+V), drag onto the comment box, or the Add picture button.
  function insertAtCursor(ta,text){ const a=ta.selectionStart??ta.value.length, b=ta.selectionEnd??a; ta.value=ta.value.slice(0,a)+text+ta.value.slice(b); ta.selectionStart=ta.selectionEnd=a+text.length; ta.dispatchEvent(new Event("input",{bubbles:true})); ta.focus(); }
  async function addCommentPictures(files){
    const key=dz.key, ta=$("d-reply"); if(!key||isOdoo(key)) return;
    for(const f of [...files].filter(f=>/^image\//.test(f.type))){
      if(f.size>4*1024*1024){ setMsg("d-cmsg",(f.name||"The picture")+" is bigger than 4 MB.",false); continue; }
      // Pasted pictures are all called image.png: a unique name keeps each one apart in the ticket.
      const ext=((f.type.split("/")[1]||"png").replace("jpeg","jpg").replace(/[^a-z0-9]/g,""))||"png";
      const stem=(f.name&&!/^image\.(png|jpe?g|gif|webp)$/i.test(f.name)?f.name.replace(/\.[^.]+$/,""):"picture").replace(/[^\w.-]+/g,"-").slice(0,60);
      const name=stem+"-"+new Date().toISOString().replace(/\D/g,"").slice(0,14)+"."+ext;
      setMsg("d-cmsg","Uploading "+name+"…",true);
      try{
        const r=await apiFile((isInt(key)?"/internal/":"/jira/issue/")+key+"/attachments?name="+encodeURIComponent(name),{method:"POST",body:f,type:f.type}), data=await r.json();
        let saved=name;
        if(isInt(key)){ INT[key]=data.ticket; saved=((data.ticket.attachments||[]).at(-1)||{}).filename||name; renderIntAttachments(key); }
        else saved=((data.attachments||[])[0]||{}).filename||name;
        if(dz.key!==key) return;
        insertAtCursor(ta,(ta.value&&!/\n$/.test(ta.value.slice(0,ta.selectionStart))?"\n":"")+"!"+saved+(isInt(key)?"":"|thumbnail")+"!\n");
        setMsg("d-cmsg","Picture added: it shows in the comment once you send it.",true);
      }catch(err){ setMsg("d-cmsg","Picture not added: "+errorText(err),false); }
    }
  }
  $("d-reply").addEventListener("paste",e=>{ const pics=[...((e.clipboardData&&e.clipboardData.files)||[])].filter(f=>/^image\//.test(f.type)); if(!pics.length) return; e.preventDefault(); addCommentPictures(pics); });
  $("d-reply").addEventListener("dragover",e=>{ if([...((e.dataTransfer&&e.dataTransfer.items)||[])].some(i=>i.kind==="file")) e.preventDefault(); });
  $("d-reply").addEventListener("drop",e=>{ const pics=[...((e.dataTransfer&&e.dataTransfer.files)||[])].filter(f=>/^image\//.test(f.type)); if(!pics.length) return; e.preventDefault(); addCommentPictures(pics); });
  $("c-img").addEventListener("change",e=>{ const files=[...e.target.files]; e.target.value=""; addCommentPictures(files); });
  // An internal ticket's comment text with its !name! picture markers shown as the pictures.
  function commentWithPictures(key,body){
    const box=el("div","plain rich"), atts=((INT[key]||{}).attachments)||[], text=String(body||""), marker=/!([^!\n|]+?)(?:\|[^!\n]*)?!/g; let at=0, m;
    while((m=marker.exec(text))){ const a=atts.find(x=>x.filename===m[1]); if(!a||!isImage(a)) continue; box.append(text.slice(at,m.index), inlineImage(a,key)); at=m.index+m[0].length; }
    box.append(text.slice(at)); return box;
  }
  $("d-send").addEventListener("click",async()=>{ const key=dz.key, text=(isInt(key)||isOdoo(key))?$("d-reply").value.trim():commentMentions.text(); if(!key) return; if(!text){ setMsg("d-cmsg","Write something first.",false); return; } const after=$("d-after").value; const r=await runBatch([{key,run:()=>doComment(key,text)}],"Comment added"); if(!r.fail){$("d-reply").value="";commentMentions.reset();} setMsg("d-cmsg",r.fail?"Not sent.":"Sent.",!r.fail);
    if(!r.fail&&after){ const ix=after.indexOf("|"); const aid=after.slice(0,ix), aname=after.slice(ix+1); const r2=await doAssign([key],aid,aname); setMsg("d-cmsg",r2.fail?"Comment sent, but the assignee didn't change.":"Sent and assigned to "+aname+".",!r2.fail); } });

  setInterval(()=>{ const a=$("auto"); if(!a||!lastLoad) return; const left=Math.max(0,120-Math.round((Date.now()-lastLoad)/1000)); a.textContent="next refresh in "+(left>=60?Math.floor(left/60)+"m "+(left%60)+"s":left+"s");
    if(Date.now()-lastLoad>120000&&document.visibilityState==="visible"&&!batchBusy&&!reloading&&$("pop").hidden&&!drag){ lastLoad=Date.now(); reload(); } },1000);
  $("signout").addEventListener("click",()=>signOut());
  // The Work view re-fits its columns when the window size changes.
  let resizeTimer=null; window.addEventListener("resize",()=>{ clearTimeout(resizeTimer); resizeTimer=setTimeout(()=>{ if(state.issues&&state.view==="list"&&state.columnsMode!=="all"&&$("pop").hidden&&!drag&&workColumns&&(viewWidth=$("view").clientWidth,fitWorkColumns()).keys!==workColumns.join()) render(); },150); });
  const ticketHistory=createTicketHistory({api,getIssue:()=>issueByKey(dz.key),allowed:()=>IS_ADMIN&&!!dz.key&&!isOdoo(dz.key)&&!$("drawer").hidden,personName:k=>(PEOPLE[k]&&PEOPLE[k].name)||k,formatTime:value=>{const time=fmtWhen(value);return time.d+" "+time.t;}});
  const drawerUI=createIssueDrawer({canViewHistory:()=>IS_ADMIN,canViewFullHistory:()=>IS_ADMIN&&!!dz.key&&!isOdoo(dz.key),onSelect:id=>{if(id==="history")ticketHistory.load(dz.key);if(id==="notes")ticketNotes.load(dz.key);},isDirty:()=>{if(business.dirty(dz.key)||ticketNotes.dirty(dz.key))return true;const issue=issueByKey(dz.key);if(!issue)return !!$("d-reply").value.trim();return !!$("d-reply").value.trim()||!!$("d-newdev").value.trim()||dz.devs.size!==issue.devs.length||issue.devs.some(d=>!dz.devs.has(d));}});
  const ticketNotes=createTicketNotes({api,isAdmin:IS_ADMIN});
  const dueDateHistory=createDueDateHistory({api,tickets:()=>state.issues||[],internal:key=>INT[key],openIssue:openDrawer});
  const dateRequests=createDateRequests({api,renderHistory:target=>dueDateHistory.render(target),context:()=>({admin:IS_ADMIN,email:MY_EMAIL,ticket:issueByKey}),openIssue:openDrawer,onApplied:(key,due)=>{patchIssue(key,matching(()=>({due:due||null}),"due"));mergeIssues();renderIfIdle();if(dz.key===key)$("d-due").value=due||"";},onChange:key=>{if(dz.key)dateRequests.renderDrawer(dz.key);return (key?refreshKeys([key]):reload()).then(()=>{if(dz.key){dateRequests.renderDrawer(dz.key);loadDetail(dz.key);}});}});
  state.businessFilter={};
  // Log work → Odoo timesheets: ticket section, form, corrections, and the Work log page.
  const workLog=createWorkLog({api,isAdmin:()=>IS_ADMIN,me:()=>({name:(getSession()||{}).name||ME,email:MY_EMAIL}),errorText,toast,openIssue:openDrawer,onLogged:key=>refreshKeys([key])});
  $("d-logwork").addEventListener("click",()=>{ if(dz.key) workLog.openFor(dz.key,$("d-title").textContent); });
  const business=createTicketBusiness({api,context:()=>({admin:IS_ADMIN,email:MY_EMAIL,key:dz.key,tickets:()=>state.issues||[]}),onChange:keys=>{if(keys)return refreshKeys(keys);mergeIssues();saveCache();render();},openIssue:openDrawer});
  $('b-client').addEventListener('click',()=>business.bulk(selected()).catch(err=>toast('Client assignment failed',[errorText(err)],true)));
  // Changes that didn't go through, kept to retry, and the API keys' state (Sync errors page).
  const syncErrors=createSyncErrors({api,onApiWrite,isAdmin:()=>IS_ADMIN,storageKey:()=>"aion.syncErrors."+encodeURIComponent((getSession()||{}).email||""),formatTime:v=>{const w=fmtWhen(v);return w.d+" "+w.t;},
    onRetried:key=>refreshKeys([key]),
    onChange:()=>{ const n=syncErrors?syncErrors.count():0, c=$("nav-error-count"); if(c){ c.textContent=String(n); c.hidden=!n; } if(workspace&&workspace.route().page==="errors"&&state.issues&&$("pop").hidden) render(); }});
  const workspace=createWorkspace({state,context:()=>({renderErrors:target=>syncErrors.render(target),admin:IS_ADMIN,dev:MY_DEV,email:MY_EMAIL,people:PEOPLE,name:ME,internal:INTERNAL,filterCount:filterCount(),dateRequests:dateRequests.all(),pendingDates:dateRequests.pendingCount(),renderReports:target=>business.renderReports(target),renderCatalog:target=>business.renderCatalog(target),renderWorkLog:target=>workLog.renderPage(target),renderRequests:(target,options)=>dateRequests.render(target,options)}),render,openIssue:openDrawer,today:todayStr,allowedItems:()=>(state.issues||[]).filter(i=>passFilters(i,todayStr())),canLeave:()=>{ if(!dz.key) return true; if(!closeDrawer(false,true)) return false; drawerPushed=false; if(location.hash) history.replaceState(history.state,"",location.pathname+location.search); return true; }});
  const aiAssistant=createAIAssistant({openIssue:openDrawer,beforeOpen:()=>{if(dz.key&&!closeDrawer())return false;closePop();return true;}});
  const ticketBriefs=createTicketBriefs({api});
  const assigneeFilter=createAssigneeFilter({getSelection:()=>state.f.assignee,getOptions:()=>assigneeOptions(PEOPLE),getDefaults:()=>defaultAssigneeKeys(PEOPLE),getCounts:()=>countBy("assignee",i=>assigneeFilterKey(i,PEOPLE)),onApply:selected=>{state.f.assignee=selected;state.sel.clear();state.pageIndex=0;render();}});
  $("create-ticket").addEventListener("click",e=>internalPopover(e.currentTarget));
  document.querySelector(".account-panel").appendChild($("notify").closest("label"));
  window.addEventListener("hashchange",()=>{try{const key=decodeURIComponent(location.hash.slice(1));if(issueByKey(key))openDrawer(key);}catch(_){} });
  async function start(){
    const s=getSession(); if(!s){ signOut(true); return; }
    $("me").textContent=s.email; ME=s.email.split("@")[0].replace(/^./,c=>c.toUpperCase());
    $("today").textContent=fmtDate(todayStr())+" "+todayStr().slice(0,4);
    // Show the last loaded tickets straight away, then refresh.
    const cached=readCache();
    if(cached){
      applyConfig(cached.cfg); workspace.configure();
      state.mainIssues=cached.main||[]; state.closedIssues=cached.closed||[]; state.internalIssues=cached.internal||[]; state.odooIssues=cached.odoo||[]; INT=cached.INT||{}; Object.values(INT).forEach(t=>{ if(!HIST[t.key]) HIST[t.key]={updated:t.updated,changes:(t.dueHistory||[]).map(h=>({when:h.when,by:h.by,from:h.from,to:h.to}))}; });
      mergeIssues(); showState(""); $("updated").textContent="saved "+new Date(cached.at).toLocaleTimeString([], {hour:"2-digit",minute:"2-digit"})+" · refreshing…"; render();
    }
    try{ const cfg=await api("/config"); if(!cached||JSON.stringify(cfg)!==JSON.stringify(cached.cfg)){ applyConfig(cfg); workspace.configure(); }
      // The client list loads while the tickets do; ticket fields wait for it (see doReload).
      businessReady=business.configure(cfg).then(()=>{if(!business.enabled())toast("Backend update required",["Deploy the updated proxy to enable ticket fields and validated status changes."],true);}).catch(err=>toast("Couldn't load clients",[errorText(err)],true)); }
    catch(err){ if(!cached){ showState(errorText(err),true); $("updated").textContent="not connected"; return; } }
    // A linked ticket opens once its fields are set up: from the saved copy if it has it, otherwise after loading.
    const openFromHash=()=>{ try{const h=decodeURIComponent(location.hash.slice(1));if(/^[A-Z][A-Z0-9_]*-\d+$/.test(h)&&issueByKey(h)&&dz.key!==h)openDrawer(h);}catch(_){} };
    const opened=cached&&(openFromHash(),dz.key!==null);
    await reload();
    // Show how many changes failed (and, for administrators, API key problems) next to Sync errors.
    syncErrors.reload(); if(IS_ADMIN) syncErrors.loadKeys();
    if(!opened) openFromHash();
  }
  start();
