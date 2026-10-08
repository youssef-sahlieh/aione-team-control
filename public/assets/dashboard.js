// AION Team Control dashboard. Jira data comes through the AION proxy (worker/), which checks the
// sign-in and holds the Jira token. Team details (people, developers, emails) come from the proxy too,
// so they aren't in this public code.
import { api, getSession, signOut } from "./session.js";

  // Filled in from the proxy's /config after sign-in (see applyConfig).
  let SITE="", PROJECT="", PEOPLE={}, DEVS=[], DEV_EMAIL={}, DEV_COLOR={}, BYID={}, JQL="", ME="", MAIL=false;
  let notifyOn=true; try{ notifyOn=localStorage.getItem("aion.notify")!=="0"; }catch(e){}
  const devK=d=>DEV_COLOR[d]||("k"+(1+[...d].reduce((a,c)=>a+c.charCodeAt(0),0)%8));
  const STATUS_ORDER=["open","pending approval","dev approved","in development","reopened","pending qa","in qa","done review","resolved","closed"];
  const stIdx=s=>{ const i=STATUS_ORDER.indexOf(s.toLowerCase()); return i<0?99:i; };
  const FIELDS=["summary","status","assignee","labels","duedate","created","updated","priority","issuetype","comment","parent","reporter"];
  function applyConfig(cfg){
    SITE=cfg.site; PROJECT=cfg.project; MAIL=!!cfg.mail; PEOPLE=cfg.people||{}; DEVS=cfg.devs||[]; DEV_EMAIL=cfg.devEmails||{}; DEV_COLOR=cfg.devColors||{};
    BYID={}; for(const k in PEOPLE) BYID[PEOPLE[k].id]=k;
    const IDS=Object.values(PEOPLE).map(p=>'"'+p.id+'"').join(",");
    JQL='project = '+PROJECT+' AND assignee in ('+IDS+') AND issuetype != Epic AND (statusCategory != Done OR updated >= -30d) ORDER BY updated DESC';
    $("team").textContent=Object.values(PEOPLE).map(p=>p.name).join(" · ");
  }
  const teamNames=()=>{ const n=Object.values(PEOPLE).map(p=>p.name); return n.length>1?n.slice(0,-1).join(", ")+" or "+n[n.length-1]:n.join(""); };
  let lastLoad=0;
  const NEW_STATUSES=["open","pending approval"];
  const HIST={}; let histBusy=false, histDone=0, histTotal=0;

  // Jira actions, all through the proxy.
  const jira={
    search:(jql,fields,nextPageToken)=>api("/jira/search",{method:"POST",body:{jql,fields,maxResults:100,nextPageToken}}),
    edit:(key,fields)=>api("/jira/issue/"+key,{method:"PUT",body:{fields}}),
    transitions:key=>api("/jira/issue/"+key+"/transitions"),
    transition:(key,id)=>api("/jira/issue/"+key+"/transitions",{method:"POST",body:{id}}),
    comment:(key,text)=>api("/jira/issue/"+key+"/comment",{method:"POST",body:{text}}),
    changelog:key=>api("/jira/issue/"+key+"/changelog"),
    users:q=>api("/jira/users?q="+encodeURIComponent(q))
  };
  // Jira's API returns descriptions and comments as structured documents; the proxy also asks for
  // the HTML versions (renderedFields), which the existing display code expects.
  function withRendered(raw){
    const r=raw.renderedFields||{}, f=Object.assign({},raw.fields||{});
    f.description=typeof r.description==="string"?r.description:(typeof f.description==="string"?f.description:"");
    if(f.comment){ const rc=(r.comment&&r.comment.comments)||[]; f.comment=Object.assign({},f.comment,{comments:(f.comment.comments||[]).map((c,i)=>Object.assign({},c,{body:rc[i]&&typeof rc[i].body==="string"?rc[i].body:(typeof c.body==="string"?c.body:"")}))}); }
    return Object.assign({},raw,{fields:f});
  }
  async function searchAll(jql,fields){
    let r=await jira.search(jql,fields); let list=(r.issues||[]).slice(), g=0;
    while(r.isLast===false&&r.nextPageToken&&g<10){ g++; r=await jira.search(jql,fields,r.nextPageToken); list=list.concat(r.issues||[]); }
    return list.map(withRendered);
  }
  const fmtWhen=iso=>{ try{ const d=new Date(iso); return {d:d.toLocaleDateString("en-GB",{day:"numeric",month:"short",year:"numeric",timeZone:"Asia/Jerusalem"}),t:d.toLocaleTimeString("en-GB",{hour:"2-digit",minute:"2-digit",timeZone:"Asia/Jerusalem"})}; }catch(e){ return {d:iso.slice(0,10),t:iso.slice(11,16)}; } };
  const dueChanges=k=>(HIST[k]&&HIST[k].changes)||[];
  const changedWithin=(k,days)=>dueChanges(k).some(c=>Date.parse(c.when)>=Date.now()-days*86400000);

  const $=id=>document.getElementById(id);
  const el=(tag,cls,text)=>{const e=document.createElement(tag); if(cls) e.className=cls; if(text!=null) e.textContent=text; return e;};

  function todayStr(){ try{return new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Jerusalem",year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date());}catch(e){return new Date().toISOString().slice(0,10);} }
  const dayMs=86400000, dnum=s=>Date.parse(s+"T00:00:00Z")/dayMs;
  const fmtDate=s=>s?new Date(s+"T00:00:00Z").toLocaleDateString("en-GB",{day:"numeric",month:"short",timeZone:"UTC"}):"";
  function ago(iso){ if(!iso) return ""; const m=(Date.now()-new Date(iso))/60000;
    if(m<60) return Math.max(1,Math.round(m))+"m ago"; if(m<1440) return Math.round(m/60)+"h ago"; if(m<10080) return Math.round(m/1440)+"d ago";
    return new Date(iso).toLocaleDateString("en-GB",{day:"numeric",month:"short"}); }

  const isDevLabel=l=>/^ai1_/i.test(l), devOf=l=>l.slice(4).toLowerCase();
  function labelsWith(labels,wanted){
    const out=labels.filter(l=>!isDevLabel(l)), have=new Set();
    labels.filter(isDevLabel).forEach(l=>{ const d=devOf(l); if(wanted.has(d)&&!have.has(d)){ out.push(l); have.add(d); } });
    wanted.forEach(d=>{ if(!have.has(d)) out.push("ai1_"+d); });
    return out;
  }

  const ALLOWED=new Set(["P","BR","STRONG","B","EM","I","U","S","DEL","UL","OL","LI","A","H1","H2","H3","H4","H5","H6","CODE","PRE","BLOCKQUOTE","TABLE","THEAD","TBODY","TR","TD","TH","HR"]);
  // Jira's HTML carries inline styles; drop them before parsing (they're never shown, and the page's security policy reports each one).
  const noStyles=h=>String(h||"").replace(/<style[\s\S]*?<\/style>/gi,"").replace(/\sstyle\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi,"");
  const toText=h=>(new DOMParser().parseFromString(noStyles(h),"text/html").body.textContent||"").replace(/\s+/g," ").trim();
  function richNode(body){
    const box=el("div"); const s=String(body||"").trim();
    if(!s){ const e=el("span",null,"No text."); e.style.color="var(--muted)"; box.appendChild(e); return box; }
    if(!/^</.test(s)){ box.className="plain"; box.textContent=s; return box; }
    const doc=new DOMParser().parseFromString(noStyles(s),"text/html");
    (function walk(src,dst){ src.childNodes.forEach(n=>{
      if(n.nodeType===3){ dst.appendChild(document.createTextNode(n.nodeValue)); return; }
      if(n.nodeType!==1) return; const t=n.tagName;
      if(n.getAttribute("data-type")==="media"){ dst.appendChild(el("span","att","attachment"+(n.getAttribute("data-alt")?": "+n.getAttribute("data-alt"):""))); return; }
      if(t==="SCRIPT"||t==="STYLE"||t==="IFRAME") return;
      if(t==="IMG"){ dst.appendChild(el("span","att","image")); return; }
      if(ALLOWED.has(t)){ const c=document.createElement(t); if(t==="A"){ const h=n.getAttribute("href")||""; if(/^https?:\/\//i.test(h)){ c.href=h; c.target="_blank"; c.rel="noopener"; } } dst.appendChild(c); walk(n,c); }
      else walk(n,dst);
    }); })(doc.body,box);
    return box;
  }

  function norm(raw){
    const f=raw.fields||{}, labels=f.labels||[];
    const aid=f.assignee&&f.assignee.accountId;
    const cm=(f.comment&&f.comment.comments)||[], last=cm.length?cm[cm.length-1]:null;
    return {
      key:raw.key, summary:f.summary||"(no summary)",
      status:(f.status&&f.status.name)||"", cat:(f.status&&f.status.statusCategory&&f.status.statusCategory.key)||"",
      assignee:BYID[aid]||null, assigneeName:(f.assignee&&f.assignee.displayName)||"Unassigned",
      labels, devs:[...new Set(labels.filter(isDevLabel).map(devOf))], due:f.duedate||null,
      created:(f.created||"").slice(0,10), updated:f.updated||"",
      priority:(f.priority&&f.priority.name)||"", type:(f.issuetype&&f.issuetype.name)||"",
      reporter:(f.reporter&&f.reporter.displayName)||"Unknown", reporterId:(f.reporter&&f.reporter.accountId)||null, assigneeId:aid||null,
      parent:f.parent?{key:f.parent.key,name:(f.parent.fields&&f.parent.fields.summary)||f.parent.key}:null,
      last:last?{author:(last.author&&last.author.displayName)||"Someone", fromTeam:!!BYID[last.author&&last.author.accountId], when:last.created, text:toText(last.body)}:null
    };
  }
  const isNew=i=>NEW_STATUSES.includes(i.status.toLowerCase());
  const stK=i=>{ const s=(i.status||"").toLowerCase(); if(i.cat==="done"||s==="resolved"||s==="closed") return "k7"; if(s==="open") return "k1"; if(s==="pending approval") return "k4"; if(s==="dev approved") return "k5"; if(s==="in development") return "k3"; if(s.includes("qa")) return "k6"; if(s==="reopened") return "k2"; return "k8"; };
  const issueByKey=k=>(state.issues||[]).find(i=>i.key===k);
  const allDevs=()=>{ const s=new Set(DEVS); (state.issues||[]).forEach(i=>i.devs.forEach(d=>s.add(d))); return [...s].sort(); };
  const needsReply=i=>i.last&&!i.last.fromTeam&&Date.parse(i.updated)>=Date.now()-(typeof state!=="undefined"?state.updDays:3)*dayMs;

  const F=()=>({reporter:new Set(),assignee:new Set(),dev:new Set(),status:new Set(),type:new Set(),priority:new Set(),epic:"",due:"any",activity:"any"});
  const state={issues:null,focus:"open",f:F(),q:"",view:"list",group:"",sel:new Set(),fopen:true,hperiod:7,updDays:3,dueDays:7,closedDays:30,mainIssues:[],closedIssues:[]};
  try{ const u=+localStorage.getItem("aion.upd"), d=+localStorage.getItem("aion.due"); if(u>=1&&u<=30) state.updDays=u; if(d>=1&&d<=90) state.dueDays=d; const cd=+localStorage.getItem("aion.closed"); if(cd>=1&&cd<=365) state.closedDays=cd; }catch(e){}
  try{ const v=localStorage.getItem("aion.view"); if(v) state.view=v; if(localStorage.getItem("aion.fopen")==="0") state.fopen=false; const gg=localStorage.getItem("aion.group"); if(gg!==null) state.group=gg; }catch(e){}

  const FOCUS=[
    {id:"open",k:"k1",l:"All open",h:"Everything not done",f:i=>i.cat!=="done"},
    {id:"nodev",k:"k2",l:"No developer",h:"Needs an ai1_ label",f:i=>i.cat!=="done"&&!i.devs.length},
    {id:"reply",k:"k6",l:"Needs a reply",h:"Last comment from outside",f:i=>i.cat!=="done"&&needsReply(i)},
    {id:"overdue",k:"k2",l:"Overdue",h:"Due date passed",f:(i,t)=>i.cat!=="done"&&i.due&&i.due<t},
    {id:"today",k:"k3",l:"Due today",h:"Finish by end of day",f:(i,t)=>i.cat!=="done"&&i.due===t},
    {id:"approval",k:"k4",l:"Waiting approval",h:"Open · Pending Approval",f:i=>i.cat!=="done"&&isNew(i)},
    {id:"nodue",k:"k5",l:"No due date",h:"Open, no date set",f:i=>i.cat!=="done"&&!i.due},
    {id:"recent",k:"k7",l:"Updated",range:"updDays",max:30,h:"Recent activity",f:i=>i.cat!=="done"&&Date.parse(i.updated)>=Date.now()-state.updDays*dayMs},
    {id:"duechg",k:"k3",l:"Due date moved",range:"dueDays",max:90,h:"Changed recently",f:i=>i.cat!=="done"&&changedWithin(i.key,state.dueDays)},
    {id:"closed",k:"k8",l:"Closed",range:"closedDays",max:365,step:7,h:"All closed AION tickets",f:i=>i.cat==="done"&&Date.parse(i.updated)>=Date.now()-state.closedDays*dayMs}
  ];
  const DUE_OPTS=[["any","Any"],["overdue","Overdue"],["today","Today"],["week","Next 7 days"],["later","Later"],["none","No date"]];
  const ACT_OPTS=[["any","Any"],["reply","Needs reply"],["new3","Opened ≤ 3 days"],["upd1","Updated today"]];

  function passFilters(i,t,skip){
    const f=state.f;
    if(skip!=="reporter"&&f.reporter.size&&!f.reporter.has(i.reporter)) return false;
    if(skip!=="assignee"&&f.assignee.size&&!f.assignee.has(i.assignee||"other")) return false;
    if(skip!=="dev"&&f.dev.size){ if(![...f.dev].some(d=>d==="__none"?!i.devs.length:i.devs.includes(d))) return false; }
    if(skip!=="status"&&f.status.size&&!f.status.has(i.status)) return false;
    if(skip!=="type"&&f.type.size&&!f.type.has(i.type)) return false;
    if(skip!=="priority"&&f.priority.size&&!f.priority.has(i.priority||"None")) return false;
    if(f.epic&&!(f.epic==="none"?!i.parent:i.parent&&i.parent.key===f.epic)) return false;
    if(f.due!=="any"){ const d=i.due;
      if(f.due==="none"&&d) return false; if(f.due==="overdue"&&!(d&&d<t)) return false; if(f.due==="today"&&d!==t) return false;
      if(f.due==="week"&&!(d&&d>t&&dnum(d)<=dnum(t)+7)) return false; if(f.due==="later"&&!(d&&dnum(d)>dnum(t)+7)) return false; }
    if(f.activity==="reply"&&!needsReply(i)) return false;
    if(f.activity==="new3"&&!(dnum(t)-dnum(i.created)<=3)) return false;
    if(f.activity==="upd1"&&!(i.updated&&Date.parse(i.updated)>=Date.now()-dayMs)) return false;
    const q=state.q.toLowerCase(); if(q&&!(i.key.toLowerCase().includes(q)||i.reporter.toLowerCase().includes(q)||i.summary.toLowerCase().includes(q)||(i.parent&&i.parent.name.toLowerCase().includes(q)))) return false;
    return true;
  }
  const focusDef=()=>FOCUS.find(x=>x.id===state.focus)||FOCUS[0];
  function visible(skip){ const t=todayStr(), fd=focusDef(); return (state.issues||[]).filter(i=>fd.f(i,t)&&passFilters(i,t,skip)); }
  function filterCount(){ const f=state.f; return f.reporter.size+f.assignee.size+f.dev.size+f.status.size+f.type.size+f.priority.size+(f.epic?1:0)+(f.due!=="any"?1:0)+(f.activity!=="any"?1:0)+(state.q?1:0); }

  function renderTiles(){
    const t=todayStr(), box=$("tiles"); box.replaceChildren();
    const base=(state.issues||[]).filter(i=>passFilters(i,t));
    FOCUS.forEach(fd=>{
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
      box.appendChild(b);
    });
  }

  function section(title,k,anyFn){ const s=el("div","fsec "+k); const h=el("h4",null,title); if(anyFn){ const a=el("button","any","Any"); a.type="button"; a.addEventListener("click",()=>{ anyFn(); state.sel.clear(); render(); }); h.appendChild(a); } s.appendChild(h); return s; }
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
    const g=$("fgrid"); g.replaceChildren(); g.hidden=!state.fopen;
    $("ftoggle").textContent=state.fopen?"Hide filters":"Show filters"; $("ftoggle").setAttribute("aria-expanded",String(state.fopen));
    const f=state.f;
    let s=section("Assignee","k4",()=>f.assignee.clear()); let cs=el("div","chips");
    const ca=countBy("assignee",i=>i.assignee||"other");
    Object.keys(PEOPLE).forEach(k=>cs.appendChild(chip(PEOPLE[k].name,"kp-"+k,f.assignee.has(k),ca[k]||0,()=>toggleSet(f.assignee,k),false,PEOPLE[k].ini)));
    if(ca.other||f.assignee.has("other")) cs.appendChild(chip("Others","k8",f.assignee.has("other"),ca.other||0,()=>toggleSet(f.assignee,"other"),false,"+"));
    s.appendChild(cs); g.appendChild(s);

    s=section("Reporter","k6",()=>f.reporter.clear()); cs=el("div","chips");
    const cr=countBy("reporter",i=>i.reporter); const reps=new Set(Object.keys(cr)); f.reporter.forEach(x=>reps.add(x));
    [...reps].sort((a,b)=>(cr[b]||0)-(cr[a]||0)||a.localeCompare(b)).forEach(r=>cs.appendChild(chip(r,"k6",f.reporter.has(r),cr[r]||0,()=>toggleSet(f.reporter,r),false,initials(r))));
    s.appendChild(cs); g.appendChild(s);

    s=section("Developer (ai1_)","k1",()=>f.dev.clear()); cs=el("div","chips");
    const cd=countBy("dev",i=>i.devs.length?i.devs:["__none"]);
    cs.appendChild(chip("No developer","k2",f.dev.has("__none"),cd["__none"]||0,()=>toggleSet(f.dev,"__none"),true));
    allDevs().forEach(d=>cs.appendChild(chip(d,devK(d),f.dev.has(d),cd[d]||0,()=>toggleSet(f.dev,d),true)));
    s.appendChild(cs); g.appendChild(s);

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
    const eps={}; (state.issues||[]).forEach(i=>{ if(i.parent) eps[i.parent.key]=i.parent.name; });
    Object.entries(eps).sort((a,b)=>a[1].localeCompare(b[1])).forEach(([k,n])=>sel.appendChild(new Option(n+" ("+k+")",k)));
    sel.value=f.epic; sel.addEventListener("change",()=>{ f.epic=sel.value; state.sel.clear(); render(); });
    s.appendChild(sel); g.appendChild(s);

    const act=$("active"); act.replaceChildren();
    const addA=(label,k,rm)=>{ const c=el("span","achip "+k,label); const x=el("button",null,"✕"); x.type="button"; x.setAttribute("aria-label","Remove "+label); x.addEventListener("click",()=>{ rm(); state.sel.clear(); render(); }); c.appendChild(x); act.appendChild(c); };
    f.reporter.forEach(v=>addA("Reporter: "+v,"k6",()=>f.reporter.delete(v)));
    f.assignee.forEach(v=>addA(PEOPLE[v]?PEOPLE[v].name:(v==="other"?"Other assignees":v),"kp-"+v,()=>f.assignee.delete(v)));
    f.dev.forEach(v=>addA(v==="__none"?"No developer":"ai1_"+v,v==="__none"?"k2":devK(v),()=>f.dev.delete(v)));
    f.status.forEach(v=>addA(v,stK({status:v,cat:""}),()=>f.status.delete(v)));
    f.type.forEach(v=>addA(v,"k7",()=>f.type.delete(v)));
    f.priority.forEach(v=>addA(v,"k2",()=>f.priority.delete(v)));
    if(f.epic) addA(f.epic==="none"?"No epic":(eps[f.epic]||f.epic),"k8",()=>f.epic="");
    if(f.due!=="any") addA("Due: "+DUE_OPTS.find(x=>x[0]===f.due)[1],"k3",()=>f.due="any");
    if(f.activity!=="any") addA(ACT_OPTS.find(x=>x[0]===f.activity)[1],"k6",()=>f.activity="any");
    if(state.q) addA("“"+state.q+"”","k1",()=>{ state.q=""; $("q").value=""; });
    if(!act.childNodes.length){ const n=el("span",null,"None yet. Click any chip below to filter."); n.style.color="var(--muted)"; n.style.fontSize="13px"; act.appendChild(n); }
    $("fclear").disabled=!filterCount();
  }

  function render(){
    if(!state.issues) return;
    const t=todayStr(); $("today").textContent=fmtDate(t)+" "+t.slice(0,4);
    renderTiles(); renderFilters();
    document.querySelectorAll(".seg [data-v]").forEach(b=>b.setAttribute("aria-pressed",String(b.dataset.v===state.view)));
    $("grpwrap").hidden=state.view!=="list"; $("grp").value=state.group||"";
    const items=visible(); const fd=focusDef();
    const keys=new Set(items.map(i=>i.key)); [...state.sel].forEach(k=>{ if(!keys.has(k)) state.sel.delete(k); });
    $("vtitle").textContent=fd.l; $("vcount").textContent=items.length+" ticket"+(items.length===1?"":"s")+(filterCount()?" · filtered":"");
    const hint=$("hint"); hint.hidden=state.view==="list"||state.view==="assignee";
    hint.textContent=state.view==="dev"?"Drag a card onto a developer to assign them. From one developer to another moves it; onto “No developer” removes that developer.":"Drag a card to another column to change its status. Jira only allows some moves; you'll see a message when one isn't allowed.";
    const v=$("view"); v.replaceChildren();
    if(state.view==="history"){ hint.hidden=true; $("grpwrap").hidden=true; v.appendChild(historyView(items)); updateBulk(); return; }
    if(!items.length){ const e=el("div","listwrap"); e.appendChild(el("div","empty","No tickets match. Pick another tile or clear some filters.")); v.appendChild(e); updateBulk(); return; }
    v.appendChild(state.view==="list"?listView(items,t):boardView(items,t,state.view));
    updateBulk();
  }

  function sortItems(items){
    const fd=state.focus;
    return items.slice().sort((a,b)=>{
      if(fd==="recent"||fd==="reply"||fd==="closed") return a.updated<b.updated?1:-1;
      if(fd==="approval"||fd==="nodev") return a.created<b.created?1:-1;
      const ad=a.due||"9999", bd=b.due||"9999"; return ad<bd?-1:ad>bd?1:(a.updated<b.updated?1:-1);
    });
  }

  function listView(items,t){
    const w=el("div","listwrap");
    const h=el("div","gr head"); const all=el("input","ck"); all.type="checkbox"; all.setAttribute("aria-label","Select all");
    all.checked=items.every(i=>state.sel.has(i.key)); all.addEventListener("change",()=>{ items.forEach(i=>all.checked?state.sel.add(i.key):state.sel.delete(i.key)); render(); });
    const hc=el("span","c-ck"); hc.appendChild(all); h.appendChild(hc);
    [["c-key","Key"],["c-ttl","Ticket"],["c-who","Assignee"],["c-rep","Reporter"],["c-dev","Developers"],["c-st","Status"],["c-due","Due"],["c-cre","Created"],["c-upd","Updated"],["c-note",""]].forEach(([c,x])=>h.appendChild(el("span",c,x)));
    w.appendChild(h);
    const sorted=sortItems(items);
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
    return w;
  }

  function keyLink(i){ const a=el("a","key",i.key+" ↗"); a.href=SITE+"/browse/"+i.key; a.target="_blank"; a.rel="noopener"; a.title="Open in Jira"; a.draggable=false; a.addEventListener("click",e=>e.stopPropagation()); return a; }
  function tagsFor(i,t,withEpic){
    const tags=el("span","tags");
    if(needsReply(i)) tags.appendChild(el("span","flag k6","needs reply"));
    const age=Math.round(dnum(t)-dnum(i.created)); if(age<=2&&i.cat!=="done") tags.appendChild(el("span","flag k7",age===0?"new today":"new "+age+"d"));
    if(/high|highest|critical|blocker/i.test(i.priority)) tags.appendChild(el("span","flag k2",i.priority));
    if(i.type==="Bug") tags.appendChild(el("span","flag k2","Bug"));
    { const n=dueChanges(i.key).filter(c=>c.from).length; if(n>=1){ const f=el("span","flag "+(n>=2?"k2":"k3"),"due moved ×"+n); f.title="Due date changed "+n+" time"+(n===1?"":"s")+" after it was first set"; tags.appendChild(f); } }
    if(withEpic&&i.parent){ const ep=el("span","epic",i.parent.name); ep.dir="auto"; ep.title="Epic "+i.parent.key; tags.appendChild(ep); }
    return tags;
  }
  function devButton(i){
    const dc=el("button","devcell c-dev"+(i.devs.length?"":" nodev")); dc.type="button"; dc.title="Assign developers";
    i.devs.forEach(d=>dc.appendChild(el("span","dev "+devK(d),d))); dc.appendChild(el("span","add",i.devs.length?"+":"+ assign"));
    dc.addEventListener("click",e=>{ e.stopPropagation(); devPopover(dc,[i.key],"set"); }); return dc;
  }
  function statusButton(i){ const sb=el("button","stbtn menu "+stK(i),i.status); sb.type="button"; sb.title="Change status"; sb.addEventListener("click",e=>{ e.stopPropagation(); statusPopover(sb,[i.key]); }); return sb; }
  function dueButton(i,t){
    const late=i.due&&i.due<t&&i.cat!=="done";
    const db=el("button","duebtn"+(late?" late":i.due===t?" today":!i.due?" none":""), i.due?(late?Math.round(dnum(t)-dnum(i.due))+"d late":i.due===t?"Today":fmtDate(i.due)):"+ set date");
    db.type="button"; db.title=(i.due?"Due "+fmtDate(i.due)+" · ":"")+"Set due date"; db.addEventListener("click",e=>{ e.stopPropagation(); duePopover(db,[i.key]); }); return db;
  }
  function avatar(i){ const p=i.assignee?PEOPLE[i.assignee]:null; const a=el("span","av "+(i.assignee?"kp-"+i.assignee:"k8"),p?p.ini:"?"); a.title=p?p.name:i.assigneeName; return a; }
  function selBox(i,onChange){ const ck=el("input","ck"); ck.type="checkbox"; ck.checked=state.sel.has(i.key); ck.setAttribute("aria-label","Select "+i.key);
    ck.addEventListener("click",e=>e.stopPropagation()); ck.addEventListener("change",()=>{ ck.checked?state.sel.add(i.key):state.sel.delete(i.key); onChange(ck.checked); updateBulk(); }); return ck; }

  function gridRow(i,t){
    const r=el("div","gr item "+stK(i)+(state.sel.has(i.key)?" sel":""));
    const ckw=el("span","c-ck"); ckw.appendChild(selBox(i,on=>r.classList.toggle("sel",on))); r.appendChild(ckw);
    const kw=el("span","c-key"); kw.appendChild(keyLink(i)); r.appendChild(kw);
    const tt=el("button","ttl c-ttl"); tt.type="button"; tt.title="Open details";
    const s=el("span","s",i.summary); s.dir="auto"; tt.appendChild(s);
    const tags=tagsFor(i,t,state.group!=="epic"); if(tags.childNodes.length) tt.appendChild(tags);
    if((state.focus==="reply"||state.focus==="recent"||state.f.activity==="reply")&&i.last){ const sn=el("span","snip"); sn.dir="auto"; sn.appendChild(el("b",null,i.last.author+" · "+ago(i.last.when)+": ")); sn.append(i.last.text); tt.appendChild(sn); }
    tt.addEventListener("click",()=>openDrawer(i.key)); r.appendChild(tt);
    const who=el("button","who c-who asg"); who.type="button"; who.title="Change assignee"; who.appendChild(avatar(i)); who.appendChild(el("span",null,i.assignee?PEOPLE[i.assignee].name:i.assigneeName));
    who.addEventListener("click",e=>{ e.stopPropagation(); assigneePopover(who,[i.key]); }); r.appendChild(who);
    const rp=el("span","who c-rep"); rp.appendChild(el("span","av k6",initials(i.reporter))); const rn=el("span",null,i.reporter); rn.title=i.reporter; rp.appendChild(rn); r.appendChild(rp);
    r.appendChild(devButton(i));
    const sw=el("span","c-st"); sw.appendChild(statusButton(i)); r.appendChild(sw);
    const dw=el("span","c-due"); dw.appendChild(dueButton(i,t)); r.appendChild(dw);
    { const cr=el("span","upd c-cre",fmtDate(i.created)); cr.title="Created "+i.created; cr.style.fontFamily="var(--mono)"; r.appendChild(cr); }
    r.appendChild(el("span","upd c-upd",ago(i.updated)));
    { const nb=el("button","notebtn c-note","✉ Internal notes"); nb.type="button"; nb.title="Email the developer directly (not posted in Jira)"; nb.addEventListener("click",e=>{ e.stopPropagation(); notePopover(nb,i.key); }); r.appendChild(nb); }
    return r;
  }

  function shiftOf(c){ if(!c.from) return {txt:"first set",k:"k1"}; if(!c.to) return {txt:"cleared",k:"k8"}; const n=Math.round(dnum(c.to)-dnum(c.from)); if(n>0) return {txt:"+"+n+"d later",k:n>=7?"k2":"k3"}; if(n<0) return {txt:n+"d earlier",k:"k7"}; return {txt:"same",k:"k8"}; }
  function historyView(items){
    const w=el("div","hist");
    const hh=el("div","hhead"); hh.appendChild(el("b",null,"Period"));
    const seg=el("div","seg"); [[1,"Today"],[7,"7 days"],[30,"30 days"],[3650,"All"]].forEach(([d,l])=>{ const b=el("button",null,l); b.type="button"; b.setAttribute("aria-pressed",String(state.hperiod===d)); b.addEventListener("click",()=>{ state.hperiod=d; render(); }); seg.appendChild(b); });
    hh.appendChild(seg);
    const prog=el("span","prog",histBusy?"Loading history "+histDone+" of "+histTotal+"…":"History loaded for "+Object.keys(HIST).length+" tickets"); hh.appendChild(prog);
    const rb=el("button","btn","Reload history"); rb.type="button"; rb.disabled=histBusy; rb.addEventListener("click",()=>loadHistory(true)); hh.appendChild(rb);
    w.appendChild(hh);
    const since=state.hperiod===1?Date.parse(todayStr()+"T00:00:00+03:00"):Date.now()-state.hperiod*dayMs;
    const rows=[]; items.forEach(i=>dueChanges(i.key).forEach(c=>{ if(Date.parse(c.when)>=since) rows.push({i,c}); }));
    rows.sort((a,b)=>a.c.when<b.c.when?1:-1);
    const h=el("div","hr head"); [["h-when","Changed at"],["h-key","Key"],["h-ttl","Ticket"],["h-by","Changed by"],["h-chg","Due date"],["h-shift","Shift"]].forEach(([c,x])=>h.appendChild(el("span",c,x))); w.appendChild(h);
    if(!rows.length){ w.appendChild(el("div","empty",histBusy?"Loading due date history…":"No due date changes in this period for the tickets shown.")); return w; }
    rows.forEach(({i,c})=>{
      const sh=shiftOf(c); const r=el("div","hr item "+sh.k);
      const fw=fmtWhen(c.when); const wh=el("span","when h-when",fw.d); wh.appendChild(el("small",null,fw.t+" · "+ago(c.when))); r.appendChild(wh);
      const kw=el("span","h-key"); kw.appendChild(keyLink(i)); r.appendChild(kw);
      const tt=el("button","ttl h-ttl"); tt.type="button"; const s=el("span","s",i.summary); s.dir="auto"; tt.appendChild(s);
      const tg=el("span","tags"); tg.appendChild(el("span","stbtn "+stK(i),i.status)); tg.appendChild(el("span","dev "+(i.assignee?"kp-"+i.assignee:"k8"),i.assignee?PEOPLE[i.assignee].name:i.assigneeName)); i.devs.forEach(d=>tg.appendChild(el("span","dev "+devK(d),d))); tt.appendChild(tg);
      tt.addEventListener("click",()=>openDrawer(i.key)); r.appendChild(tt);
      r.appendChild(el("span","who h-by",c.by));
      const ch=el("span","chg h-chg"); if(c.from) ch.appendChild(el("span","from",fmtDate(c.from))); else ch.appendChild(el("span","none","not set")); ch.appendChild(el("span",null,"→")); if(c.to) ch.appendChild(el("b",null,fmtDate(c.to))); else ch.appendChild(el("span","none","cleared")); r.appendChild(ch);
      r.appendChild(el("span","shift h-shift "+sh.k,sh.txt));
      w.appendChild(r);
    });
    return w;
  }
  async function fetchHistory(key){
    const d=await jira.changelog(key); const hs=(d.changelog&&d.changelog.histories)||[]; const out=[];
    hs.forEach(h=>(h.items||[]).forEach(it=>{ if(it.field==="duedate"||it.fieldId==="duedate") out.push({when:h.created,by:(h.author&&h.author.displayName)||"Someone",from:it.from?String(it.from).slice(0,10):null,to:it.to?String(it.to).slice(0,10):null}); }));
    out.sort((a,b)=>a.when<b.when?1:-1); return out;
  }
  async function loadHistory(force){
    if(histBusy||!state.issues) return;
    const todo=state.issues.filter(i=>i.cat!=="done").filter(i=>force||!HIST[i.key]||HIST[i.key].updated!==i.updated);
    if(!todo.length) return;
    histBusy=true; histDone=0; histTotal=todo.length; if(state.view==="history") render();
    const q=todo.slice(); const workers=[];
    for(let w=0;w<4;w++) workers.push((async()=>{ while(q.length){ const i=q.shift(); try{ HIST[i.key]={updated:i.updated,changes:await fetchHistory(i.key)}; }catch(err){ if(err&&err.code==="session"){ q.length=0; showState(errorText(err),true); } } histDone++; if(histDone%8===0&&state.view==="history"&&$("pop").hidden) render(); } })());
    await Promise.all(workers); histBusy=false;
    if($("pop").hidden&&!drag) render();
  }
  function renderDrawerHist(key){
    const box=$("d-hist"); box.replaceChildren(); const ch=dueChanges(key);
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
    if(mode==="dev"){
      const ops=d.keys.map(k=>{ const i=issueByKey(k); if(!i) return null; const want=new Set(i.devs);
        if(d.from!=="__none") want.delete(d.from);
        if(target!=="__none") want.add(target);
        const same=want.size===i.devs.length&&[...want].every(x=>i.devs.includes(x)); if(same) return null;
        return {key:k,added:[...want].filter(x=>!i.devs.includes(x)),run:()=>jira.edit(k,{labels:labelsWith(i.labels,want)})};
      }).filter(Boolean);
      if(!ops.length){ toast("Nothing to change."); return; }
      await runBatch(ops,target==="__none"?"Developer removed":"Assigned to ai1_"+target);
    } else if(mode==="status"){
      toast("Checking allowed moves…");
      const ops=[], skipped=[];
      for(const k of d.keys){ const i=issueByKey(k); if(i&&i.status===target) continue;
        try{ const trs=await getTransitions(k); const tr=trs.find(x=>x.to&&x.to.name&&x.to.name.toLowerCase()===target.toLowerCase());
          if(tr) ops.push({key:k,run:()=>jira.transition(k,tr.id)}); else skipped.push(k+": can't go from "+(i?i.status:"its status")+" straight to "+target);
        }catch(err){ skipped.push(k+": "+errorText(err)); } }
      if(ops.length) await runBatch(ops,"Moved to "+target);
      if(skipped.length) setTimeout(()=>toast("Not moved",skipped,true),ops.length?3300:0);
    }
  }
  function updateBulk(){ const n=state.sel.size; $("bulk").hidden=n===0; $("b-count").textContent=n+" selected"; }

  let popAnchor=null;
  function closePop(){ $("pop").classList.remove("wide"); $("pop").hidden=true; $("pop").replaceChildren(); popAnchor=null; }
  function placePop(anchor){
    const p=$("pop"); p.hidden=false; popAnchor=anchor;
    const r=anchor.getBoundingClientRect(), w=p.offsetWidth, h=p.offsetHeight, vw=document.documentElement.clientWidth, vh=window.innerHeight;
    let left=Math.min(Math.max(16,r.left),vw-w-16), top=r.bottom+6; if(top+h>vh-12) top=Math.max(12,r.top-h-6);
    p.style.left=left+"px"; p.style.top=top+"px";
  }
  document.addEventListener("mousedown",e=>{ const p=$("pop"); if(!p.hidden&&!p.contains(e.target)&&popAnchor&&!popAnchor.contains(e.target)) closePop(); });
  document.addEventListener("keydown",e=>{ if(e.key==="Escape"){ if(!$("pop").hidden) closePop(); else if(!$("drawer").hidden) closeDrawer(); } });
  window.addEventListener("scroll",()=>{ if(!$("pop").hidden) closePop(); },{passive:true});

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
        return same?null:{key:k,added:[...want].filter(d=>!cur.has(d)),run:()=>jira.edit(k,{labels:labelsWith(i?i.labels:[],want)})}; }).filter(Boolean);
      if(!ops.length){ toast("Nothing to change."); return; }
      await runBatch(ops,mode==="remove"?"Developers removed":"Developers saved"); });
    foot.appendChild(save); p.appendChild(foot); placePop(anchor);
  }
  function duePopover(anchor,keys){
    const p=$("pop"); p.replaceChildren();
    p.appendChild(el("h4",null,keys.length===1?"Due date for "+keys[0]:"Due date for "+keys.length+" tickets"));
    const body=el("div","body"); body.style.padding="4px 12px 10px"; body.style.gap="10px";
    const inp=el("input","inp"); inp.type="date"; inp.setAttribute("aria-label","Due date"); const one=keys.length===1?issueByKey(keys[0]):null; if(one&&one.due) inp.value=one.due;
    const quick=el("div","quick"); const t=todayStr();
    [["Today",0],["Tomorrow",1],["+3 days",3],["+1 week",7],["+2 weeks",14]].forEach(([l,n])=>{ const b=el("button",null,l); b.type="button"; b.addEventListener("click",()=>{ inp.value=new Date((dnum(t)+n)*dayMs).toISOString().slice(0,10); }); quick.appendChild(b); });
    body.appendChild(inp); body.appendChild(quick); p.appendChild(body);
    const foot=el("div","foot"); const clr=el("button","btn danger","Clear date"); clr.type="button";
    clr.addEventListener("click",async()=>{ closePop(); await runBatch(keys.map(k=>({key:k,run:()=>jira.edit(k,{duedate:null})})),"Due date cleared"); });
    const save=el("button","btn primary sp","Save"); save.type="button";
    save.addEventListener("click",async()=>{ const v=inp.value; if(!/^\d{4}-\d{2}-\d{2}$/.test(v)){ inp.focus(); return; } closePop(); await runBatch(keys.map(k=>({key:k,run:()=>jira.edit(k,{duedate:v})})),"Due date set to "+fmtDate(v)); });
    foot.appendChild(clr); foot.appendChild(save); p.appendChild(foot); placePop(anchor); inp.focus();
  }
  const initialsOf=n=>String(n||"?").split(/\s+/).filter(Boolean).map(x=>x[0]).join("").slice(0,2).toUpperCase()||"?";
  function assignOps(keys,id){ return keys.map(k=>{ const i=issueByKey(k); if(i&&i.assigneeId===id) return null; return {key:k,run:()=>jira.edit(k,{assignee:id?{accountId:id}:null})}; }).filter(Boolean); }
  async function doAssign(keys,id,name){
    const ops=assignOps(keys,id); if(!ops.length){ toast("Already assigned to "+name+"."); return {ok:0,fail:0}; }
    const r=await runBatch(ops,"Assigned to "+name);
    if(r.ok&&id&&!BYID[id]) setTimeout(()=>toast(name+" isn't "+teamNames()+", so "+(r.ok===1?"this ticket":"these tickets")+" will leave the dashboard."),3300);
    return r;
  }
  function assigneePopover(anchor,keys){
    const p=$("pop"); p.replaceChildren(); p.appendChild(el("h4",null,keys.length===1?"Assign "+keys[0]+" to":"Assign "+keys.length+" tickets to"));
    const body=el("div","body"); p.appendChild(body);
    const one=keys.length===1?issueByKey(keys[0]):null;
    const opt=(id,name,note,k)=>{ const b=el("button","opt"); b.type="button"; b.appendChild(el("span","av "+(k||"k8"),initialsOf(name))); b.appendChild(el("span",null,name));
      b.appendChild(el("span","cnt",one&&one.assigneeId===id?"current":note||""));
      b.addEventListener("click",async()=>{ closePop(); await doAssign(keys,id,name); }); body.appendChild(b); };
    Object.keys(PEOPLE).forEach(k=>opt(PEOPLE[k].id,PEOPLE[k].name,"team","kp-"+k));
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
  function notePopover(anchor,key){
    const i=issueByKey(key); if(!i) return;
    const p=$("pop"); p.replaceChildren(); p.classList.add("wide");
    p.appendChild(el("h4",null,"Internal note · "+key+" · email only, not posted in Jira"));
    const body=el("div","body"); p.appendChild(body);
    const f1=el("div","fld"); f1.appendChild(el("label",null,"To")); const rc=el("div","rcpts"); f1.appendChild(rc); body.appendChild(f1);
    const chosen=new Set(i.devs.filter(d=>DEV_EMAIL[d]));
    Object.keys(DEV_EMAIL).sort().forEach(d=>{ const c=el("button","fc "+devK(d)); c.type="button"; c.appendChild(el("span","sw")); c.appendChild(el("span",null,"ai1_"+d)); if(i.devs.includes(d)) c.appendChild(el("span","cnt","on ticket"));
      c.setAttribute("aria-pressed",String(chosen.has(d))); c.title=DEV_EMAIL[d];
      c.addEventListener("click",()=>{ chosen.has(d)?chosen.delete(d):chosen.add(d); c.setAttribute("aria-pressed",String(chosen.has(d))); }); rc.appendChild(c); });
    const f2=el("div","fld"); f2.appendChild(el("label",null,"Also send to (optional, comma separated)")); const extra=el("input","inp"); extra.type="text"; extra.placeholder="name@aione.biz"; f2.appendChild(extra); body.appendChild(f2);
    const f3=el("div","fld"); f3.appendChild(el("label",null,"Subject")); const subj=el("input","inp"); subj.value="Internal note: "+key+" – "+i.summary; f3.appendChild(subj); body.appendChild(f3);
    const f4=el("div","fld"); f4.appendChild(el("label",null,"Note")); const ta=el("textarea","inp"); ta.dir="auto"; ta.placeholder="Write your note to the developer…"; f4.appendChild(ta); body.appendChild(f4);
    const f5=el("label","tgl"); f5.style.padding="2px 12px 8px"; const cc=el("input","ck"); cc.type="checkbox"; cc.checked=true; f5.appendChild(cc); f5.append(" Include ticket details and link"); body.appendChild(f5);
    const foot=el("div","foot"); const msg=el("span","msg"); const send=el("button","btn primary sp",MAIL?"Send email":"Open in Outlook"); send.type="button"; send.title=MAIL?"Sends from your mailbox right away (shows in your Sent Items).":"Opens a ready-made email in your mail app. Check it and press Send there.";
    send.addEventListener("click",async()=>{
      const to=[...new Set([...chosen].map(d=>DEV_EMAIL[d]).concat(extra.value.split(/[,;\s]+/).map(x=>x.trim()).filter(x=>/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(x))))];
      const text=ta.value.trim();
      if(!to.length){ msg.textContent="Pick at least one developer."; msg.className="msg err"; return; }
      if(!text){ msg.textContent="Write the note first."; msg.className="msg err"; ta.focus(); return; }
      const names=[...chosen].map(devFirstName), subject=subj.value.trim()||("Internal note: "+key);
      if(!MAIL){
        let plain="Hi "+(names.length?names.join(", "):"team")+",\n\n"+text+"\n";
        if(cc.checked) plain+="\n---\nTicket: "+key+" – "+i.summary+"\n"+SITE+"/browse/"+key+"\nStatus: "+i.status+" · Due: "+(i.due?fmtDate(i.due):"Not set")+" · Assignee: "+(i.assignee?PEOPLE[i.assignee].name:i.assigneeName)+(i.parent?" · Epic: "+i.parent.name:"")+"\n";
        plain+="\nThanks,\n"+ME+"\n";
        openEmail(to,subject,plain);
        closePop(); toast("Email opened in Outlook. Check it and press Send there.",to); return;
      }
      send.disabled=true; send.textContent="Sending…"; msg.textContent="";
      let html="<p>Hi "+esc(names.length?names.join(", "):"team")+",</p>"+text.split(/\n{2,}/).map(par=>"<p>"+esc(par).replace(/\n/g,"<br>")+"</p>").join("");
      if(cc.checked) html+="<hr><p><b>Ticket:</b> <a href=\""+esc(SITE)+"/browse/"+esc(key)+"\">"+esc(key)+"</a> – "+esc(i.summary)+"<br><b>Status:</b> "+esc(i.status)+" · <b>Due:</b> "+esc(i.due?fmtDate(i.due):"Not set")+" · <b>Assignee:</b> "+esc(i.assignee?PEOPLE[i.assignee].name:i.assigneeName)+(i.parent?" · <b>Epic:</b> "+esc(i.parent.name):"")+"</p>";
      html+="<p>Thanks,<br>"+esc(ME)+"</p>";
      try{ await api("/mail",{method:"POST",body:{to,subject,html}});
        closePop(); toast("Internal note sent to "+to.length+" recipient"+(to.length===1?"":"s"),to);
      }catch(err){ send.disabled=false; send.textContent="Send email"; msg.className="msg err";
        msg.textContent=err.code==="network"?"The server didn't confirm. Check your Sent Items before sending again.":err.message; }
    });
    foot.appendChild(msg); foot.appendChild(send); p.appendChild(foot); placePop(anchor); ta.focus();
  }
  async function getTransitions(key){ const d=(await jira.transitions(key))||{}; return (d.transitions||[]).filter(x=>x.isAvailable!==false); }
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
        b.addEventListener("click",async()=>{ closePop(); await runBatch(g.items.map(it=>({key:it.key,run:()=>jira.transition(it.key,it.id)})),"Moved to "+g.name);
          const sk=keys.length-g.items.length; if(sk>0) setTimeout(()=>toast(sk+" ticket"+(sk===1?"":"s")+" can't move to "+g.name+" from their current status."),3300); });
        body.appendChild(b); });
      placePop(my);
    }catch(err){ body.replaceChildren(el("div","note",errorText(err))); }
  }
  const selected=()=>[...state.sel];
  $("b-adddev").addEventListener("click",e=>devPopover(e.currentTarget,selected(),"add"));
  $("b-rmdev").addEventListener("click",e=>devPopover(e.currentTarget,selected(),"remove"));
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
  let batchBusy=false;
  async function runBatch(ops,okText){
    if(batchBusy){ toast("Another update is still running."); return {ok:0,fail:0}; }
    batchBusy=true; let ok=0; const fails=[]; const done=[];
    for(let n=0;n<ops.length;n++){ if(ops.length>1) toast("Updating "+(n+1)+" of "+ops.length+"…");
      try{ await ops[n].run(); ok++; done.push(ops[n]); }catch(err){ const amb=err&&err.code==="network"; fails.push(ops[n].key+": "+(amb?"Jira didn't confirm, check the ticket":errorText(err))); if(err&&err.code==="session") break; } }
    batchBusy=false;
    if(fails.length) toast(okText+" on "+ok+" of "+ops.length+". These need a look:",fails,true); else toast(okText+(ops.length>1?" on "+ok+" tickets":"")+".");
    const toNotify=done.filter(o=>o.added&&o.added.length);
    if(toNotify.length&&notifyOn) setTimeout(()=>notifyDevs(toNotify),fails.length?4000:1500);
    await reload(); if(dz.key) loadDetail(dz.key);
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
        const rows=items.map(i=>"<tr><td><a href=\""+esc(SITE)+"/browse/"+esc(i.key)+"\">"+esc(i.key)+"</a></td><td>"+esc(i.summary)+"</td><td>"+esc(i.status)+"</td><td>"+esc(i.due?fmtDate(i.due):"Not set")+"</td><td>"+esc(i.parent?i.parent.name:"")+"</td><td>"+esc(i.reporter)+"</td></tr>").join("");
        const html="<p>Hi "+esc(devFirstName(d))+",</p><p>You have been assigned as the developer (ai1_"+esc(d)+") on the following Jira "+(keys.length===1?"ticket":"tickets")+":</p>"
          +"<table border=\"1\" cellpadding=\"6\" cellspacing=\"0\"><thead><tr><th>Ticket</th><th>Title</th><th>Status</th><th>Due date</th><th>Epic</th><th>Reporter</th></tr></thead><tbody>"+rows+"</tbody></table>"
          +"<p>Please review "+(keys.length===1?"it":"them")+" and set a due date in Jira based on the development time.</p><p>Thanks,<br>"+esc(ME)+"</p>";
        try{ await api("/mail",{method:"POST",body:{to:[to],subject,html}}); sent.push("ai1_"+d+" ("+to+") · "+keys.join(", ")); }
        catch(err){ failed.push("ai1_"+d+": "+(err.code==="network"?"the server didn't confirm, check your Sent Items before resending":err.message)); }
        continue;
      }
      const rows=items.map(i=>"• "+i.key+" – "+i.summary+"\n  "+SITE+"/browse/"+i.key+"\n  Status: "+i.status+" · Due: "+(i.due?fmtDate(i.due):"Not set")+(i.parent?" · Epic: "+i.parent.name:"")+" · Reporter: "+i.reporter).join("\n\n");
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
    if(c==="session") return "Your sign-in has expired. Sign in again.";
    if(c==="network") return "Can't reach the AION server. Check your connection and try again.";
    if(c==="rate_limited") return "Jira is busy. Wait a moment and try again.";
    if(c==="jira") return "Jira refused: "+(err.message||"unknown error");
    return "Couldn't reach Jira"+(err&&err.message?": "+err.message:"."); }
  function mergeIssues(){ const m=new Map(); state.mainIssues.forEach(i=>m.set(i.key,i)); state.closedIssues.forEach(i=>{ if(!m.has(i.key)) m.set(i.key,i); }); state.issues=[...m.values()]; }
  let closedBusy=false;
  async function loadClosed(){
    if(closedBusy) return; const days=state.closedDays; closedBusy=true;
    try{
      const list=await searchAll('project = '+PROJECT+' AND issuetype != Epic AND statusCategory = Done AND updated >= -'+days+'d ORDER BY updated DESC',FIELDS);
      state.closedIssues=list.map(norm); mergeIssues(); if($("pop").hidden&&!drag) render();
    }catch(err){ if(state.focus==="closed") toast("Couldn't load closed tickets",[errorText(err)],true); }
    finally{ closedBusy=false; if(state.closedDays!==days) loadClosed(); }
  }
  let loading=false;
  async function reload(){
    if(loading) return; loading=true;
    try{ const issues=await searchAll(JQL,FIELDS);
      state.mainIssues=issues.map(norm); mergeIssues(); showState(""); setTimeout(()=>loadClosed(),0);
      lastLoad=Date.now(); $("updated").textContent="updated "+new Date().toLocaleTimeString([], {hour:"2-digit",minute:"2-digit"});
      if($("pop").hidden&&!drag) render();
      setTimeout(()=>loadHistory(false),0);
    }catch(err){ showState(errorText(err),true); } finally{ loading=false; }
  }
  $("refresh").addEventListener("click",async()=>{ const b=$("refresh"); b.disabled=true; b.textContent="Refreshing…"; await reload(); b.disabled=false; b.textContent="Refresh"; });

  document.querySelectorAll(".seg [data-v]").forEach(b=>b.addEventListener("click",()=>{ state.view=b.dataset.v; try{localStorage.setItem("aion.view",state.view);}catch(e){} render(); }));
  $("notify").checked=notifyOn; $("notify").addEventListener("change",e=>{ notifyOn=e.target.checked; try{localStorage.setItem("aion.notify",notifyOn?"1":"0");}catch(x){} toast(notifyOn?(MAIL?"Developers will be emailed when assigned.":"You'll be offered an email to developers when you assign them."):"Assignment emails are off."); });
  $("grp").addEventListener("change",e=>{ state.group=e.target.value; try{localStorage.setItem("aion.group",state.group);}catch(x){} render(); });
  $("ftoggle").addEventListener("click",()=>{ state.fopen=!state.fopen; try{localStorage.setItem("aion.fopen",state.fopen?"1":"0");}catch(e){} renderFilters(); });
  $("fclear").addEventListener("click",()=>{ state.f=F(); state.q=""; $("q").value=""; state.sel.clear(); render(); });
  let qt=null; $("q").addEventListener("input",e=>{ clearTimeout(qt); qt=setTimeout(()=>{ state.q=e.target.value.trim(); render(); },150); });

  const dz={key:null,labels:[],devs:new Set()};
  function closeDrawer(){ $("drawer").hidden=true; $("scrim").hidden=true; dz.key=null; }
  $("d-close").addEventListener("click",closeDrawer); $("scrim").addEventListener("click",closeDrawer);
  function setMsg(id,text,ok){ const m=$(id); m.textContent=text||""; m.className="msg"+(text?(ok?" ok":" err"):""); }
  function renderDevChips(){ const box=$("d-devs"); box.replaceChildren(); const names=new Set(allDevs()); dz.devs.forEach(d=>names.add(d));
    [...names].sort().forEach(d=>{ const c=el("button","fc "+devK(d)); c.type="button"; c.appendChild(el("span","sw")); c.appendChild(el("span",null,"ai1_"+d)); c.setAttribute("aria-pressed",String(dz.devs.has(d)));
      c.addEventListener("click",()=>{ dz.devs.has(d)?dz.devs.delete(d):dz.devs.add(d); c.setAttribute("aria-pressed",String(dz.devs.has(d))); setMsg("d-devmsg",""); }); box.appendChild(c); }); }
  const fact=(dt,dd)=>{ const w=el("div"); w.appendChild(el("dt",null,dt)); w.appendChild(el("dd",null,dd||"—")); return w; };
  function openDrawer(key){
    closePop(); dz.key=key; const i=issueByKey(key);
    $("drawer").hidden=false; $("scrim").hidden=false;
    $("d-key").textContent=key+" ↗"; $("d-key").href=$("d-open").href=SITE+"/browse/"+key;
    $("d-title").textContent=i?i.summary:key; $("d-status").textContent=i?i.status:""; $("d-status").className="stbtn "+(i?stK(i):"");
    $("d-facts").replaceChildren(); $("d-desc").replaceChildren(el("span",null,"Loading…")); $("d-comments").replaceChildren(); $("d-ccount").textContent=""; $("d-trans").replaceChildren(el("span","msg","Loading…"));
    ["d-devmsg","d-duemsg","d-cmsg"].forEach(id=>setMsg(id,"")); $("d-att").replaceChildren(el("span","msg","Loading…")); $("d-acount").textContent=""; $("d-asgname").textContent=i?i.assigneeName:""; $("d-after").replaceChildren(new Option("Keep current assignee","")); $("d-attadd").href=$("d-cattach").href=SITE+"/browse/"+key;
    dz.labels=i?i.labels.slice():[]; dz.devs=new Set(i?i.devs:[]); renderDevChips(); $("d-due").value=i&&i.due?i.due:"";
    $("d-body").scrollTop=0; $("d-close").focus(); renderDrawerHist(key); loadDetail(key);
  }
  async function loadTransitions(key){
    try{ const trs=await getTransitions(key); if(dz.key!==key) return; const box=$("d-trans"); box.replaceChildren();
      if(!trs.length){ box.appendChild(el("span","msg","No moves available from this status.")); return; }
      trs.forEach(tr=>{ const name=(tr.to&&tr.to.name)||tr.name; const b=el("button","stbtn "+stK({status:name,cat:(tr.to&&tr.to.statusCategory&&tr.to.statusCategory.key)||""}),"→ "+name); b.type="button"; b.title=tr.name;
        b.addEventListener("click",()=>runBatch([{key,run:()=>jira.transition(key,tr.id)}],"Moved to "+name)); box.appendChild(b); });
    }catch(err){ if(dz.key===key) $("d-trans").replaceChildren(el("span","msg err",errorText(err))); }
  }
  async function loadDetail(key){
    loadTransitions(key);
    fetchHistory(key).then(ch=>{ const i=issueByKey(key); HIST[key]={updated:i?i.updated:"",changes:ch}; if(dz.key===key) renderDrawerHist(key); }).catch(()=>{ if(dz.key===key&&!HIST[key]) $("d-hist").replaceChildren(el("span","msg err","Couldn't load the history.")); });
    try{ const list=await searchAll("key = "+key,["summary","description","status","assignee","reporter","labels","duedate","created","updated","priority","issuetype","comment","parent","attachment"]);
      if(dz.key!==key) return; const raw=list[0]; if(!raw){ $("d-desc").replaceChildren(el("span",null,"Ticket not found.")); return; }
      const f=raw.fields||{}, ni=norm(raw);
      $("d-title").textContent=f.summary||key; $("d-status").textContent=ni.status; $("d-status").className="stbtn "+stK(ni);
      $("d-facts").replaceChildren(fact("Assignee",(f.assignee&&f.assignee.displayName)||"Unassigned"),fact("Reporter",(f.reporter&&f.reporter.displayName)||""),fact("Epic",ni.parent?ni.parent.name:""),fact("Type",ni.type),fact("Priority",ni.priority),fact("Created",ago(f.created)),fact("Updated",ago(f.updated)),fact("Due",f.duedate?fmtDate(f.duedate):"not set"));
      dz.labels=(f.labels||[]).slice(); dz.devs=new Set(ni.devs); renderDevChips(); $("d-due").value=f.duedate||"";
      $("d-desc").replaceChildren(richNode(f.description));
      renderAttachments(f.attachment||[]);
      { const an=(f.assignee&&f.assignee.displayName)||"Unassigned"; const ak=BYID[f.assignee&&f.assignee.accountId]; const box=$("d-asgname"); box.replaceChildren(el("span","av "+(ak?"kp-"+ak:"k8"),initialsOf(an)),el("span",null,an)); }
      { const sel=$("d-after"); sel.replaceChildren(new Option("Keep current assignee",""));
        const seen=new Set(); const add=(id,n,tag)=>{ if(!id||seen.has(id)||(f.assignee&&f.assignee.accountId===id)) return; seen.add(id); sel.appendChild(new Option(n+(tag?" ("+tag+")":""),id+"|"+n)); };
        if(f.reporter) add(f.reporter.accountId,f.reporter.displayName,"reporter");
        ((f.comment&&f.comment.comments)||[]).slice().reverse().forEach(c=>{ if(c.author&&!BYID[c.author.accountId]) add(c.author.accountId,c.author.displayName,"commented"); });
        for(const k in PEOPLE) add(PEOPLE[k].id,PEOPLE[k].name,""); }
      const cm=(f.comment&&f.comment.comments)||[]; $("d-ccount").textContent="("+((f.comment&&f.comment.total)||cm.length)+")";
      const box=$("d-comments"); box.replaceChildren(); if(!cm.length) box.appendChild(el("div","msg","No comments yet."));
      cm.forEach(c=>{ const aid=c.author&&c.author.accountId, name=(c.author&&c.author.displayName)||"Someone";
        const cd=el("div","cmt"+(BYID[aid]?" mine":" ext")); const meta=el("div","cmeta"); meta.appendChild(el("b",null,name)); meta.appendChild(el("span",null,ago(c.created)));
        const rb=el("button","linkbtn sp","Reply"); rb.type="button"; rb.addEventListener("click",()=>{ const t=$("d-reply"); if(!t.value.trim()) t.value=name.split(" ")[0]+", "; t.focus(); t.scrollIntoView({block:"center",behavior:"smooth"}); });
        meta.appendChild(rb); cd.appendChild(meta); const b=richNode(c.body); b.classList.add("rich"); b.dir="auto"; cd.appendChild(b); box.appendChild(cd); });
    }catch(err){ if(dz.key===key) $("d-desc").replaceChildren(el("span","msg err",errorText(err))); }
  }
  function fmtSize(b){ if(b==null) return ""; if(b<1024) return b+" B"; if(b<1048576) return Math.round(b/1024)+" KB"; return (b/1048576).toFixed(1)+" MB"; }
  function renderAttachments(atts){
    const box=$("d-att"); box.replaceChildren(); $("d-acount").textContent="("+atts.length+")";
    if(!atts.length){ box.appendChild(el("span","msg","No attachments on this ticket.")); return; }
    atts.slice().sort((a,b)=>a.created<b.created?1:-1).forEach(a=>{
      const ext=(String(a.filename).split(".").pop()||"").slice(0,4).toUpperCase(); const mt=a.mimeType||"";
      const k=/image/.test(mt)?"k5":/pdf/.test(mt)?"k2":/zip|compressed|rar/.test(mt)?"k4":/sheet|excel|csv/.test(mt)?"k7":/word|document/.test(mt)?"k1":"k8";
      const row=el("div","att "+k); row.appendChild(el("span","ic",ext||"FILE"));
      const mid=el("div"); mid.style.minWidth="0"; const nm=el("div","nm",a.filename); nm.dir="auto"; mid.appendChild(nm);
      const fw=fmtWhen(a.created); mid.appendChild(el("div","mt",fmtSize(a.size)+" · "+((a.author&&a.author.displayName)||"")+" · "+fw.d+" "+fw.t)); row.appendChild(mid);
      const v=el("a","btn","Open / download"); v.href=SITE+"/secure/attachment/"+a.id+"/"+encodeURIComponent(a.filename); v.target="_blank"; v.rel="noopener"; v.style.textDecoration="none"; v.title="Opens in a new tab; you need to be signed in to Jira in that browser";
      row.appendChild(v); box.appendChild(row);
    });
  }
  $("d-note").addEventListener("click",e=>{ if(dz.key) notePopover(e.currentTarget,dz.key); });
  $("d-asg").addEventListener("click",e=>{ if(dz.key) assigneePopover(e.currentTarget,[dz.key]); });
  $("d-adddev").addEventListener("click",()=>{ const v=$("d-newdev").value.trim().replace(/^ai1_/i,"").replace(/\s+/g,"").toLowerCase(); if(!v){ setMsg("d-devmsg","Type a name first.",false); return; } dz.devs.add(v); $("d-newdev").value=""; renderDevChips(); setMsg("d-devmsg","Added ai1_"+v+". Press Save developers.",true); });
  $("d-newdev").addEventListener("keydown",e=>{ if(e.key==="Enter"){ e.preventDefault(); $("d-adddev").click(); } });
  $("d-savedevs").addEventListener("click",async()=>{ const key=dz.key; if(!key) return; const labels=labelsWith(dz.labels,new Set(dz.devs)); const prev=new Set(dz.labels.filter(isDevLabel).map(devOf)); const r=await runBatch([{key,added:[...dz.devs].filter(d=>!prev.has(d)),run:()=>jira.edit(key,{labels})}],"Developers saved"); setMsg("d-devmsg",r.fail?"Not saved.":"Saved.",!r.fail); });
  $("d-savedue").addEventListener("click",async()=>{ const key=dz.key, v=$("d-due").value; if(!key) return; if(!/^\d{4}-\d{2}-\d{2}$/.test(v)){ setMsg("d-duemsg","Pick a date first.",false); return; } const r=await runBatch([{key,run:()=>jira.edit(key,{duedate:v})}],"Due date set to "+fmtDate(v)); setMsg("d-duemsg",r.fail?"Not saved.":"Saved.",!r.fail); });
  $("d-cleardue").addEventListener("click",async()=>{ const key=dz.key; if(!key) return; const r=await runBatch([{key,run:()=>jira.edit(key,{duedate:null})}],"Due date cleared"); setMsg("d-duemsg",r.fail?"Not saved.":"Cleared.",!r.fail); });
  $("d-send").addEventListener("click",async()=>{ const key=dz.key, text=$("d-reply").value.trim(); if(!key) return; if(!text){ setMsg("d-cmsg","Write something first.",false); return; } const after=$("d-after").value; const r=await runBatch([{key,run:()=>jira.comment(key,text)}],"Comment added"); if(!r.fail) $("d-reply").value=""; setMsg("d-cmsg",r.fail?"Not sent.":"Sent.",!r.fail);
    if(!r.fail&&after){ const ix=after.indexOf("|"); const aid=after.slice(0,ix), aname=after.slice(ix+1); const r2=await doAssign([key],aid,aname); setMsg("d-cmsg",r2.fail?"Comment sent, but the assignee didn't change.":"Sent and assigned to "+aname+".",!r2.fail); } });

  setInterval(()=>{ const a=$("auto"); if(!a||!lastLoad) return; const left=Math.max(0,120-Math.round((Date.now()-lastLoad)/1000)); a.textContent="next refresh in "+(left>=60?Math.floor(left/60)+"m "+(left%60)+"s":left+"s");
    if(Date.now()-lastLoad>120000&&document.visibilityState==="visible"&&!batchBusy&&$("pop").hidden&&!drag){ lastLoad=Date.now(); reload(); } },1000);
  $("signout").addEventListener("click",signOut);
  async function start(){
    const s=getSession(); if(!s){ signOut(); return; }
    $("me").textContent=s.email; ME=s.email.split("@")[0].replace(/^./,c=>c.toUpperCase());
    $("today").textContent=fmtDate(todayStr())+" "+todayStr().slice(0,4);
    try{ applyConfig(await api("/config")); }
    catch(err){ showState(errorText(err),true); $("updated").textContent="not connected"; return; }
    await reload();
  }
  start();
