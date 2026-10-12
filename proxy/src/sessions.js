const json=(body,status=200)=>Response.json(body,{status,headers:{"Cache-Control":"no-store"}});
const random=()=>[...crypto.getRandomValues(new Uint8Array(32))].map(n=>n.toString(16).padStart(2,"0")).join("");
const claims=token=>{try{return JSON.parse(atob(token.split(".")[0].replace(/-/g,"+").replace(/_/g,"/")));}catch{return {};}};

export async function cookieSessionRequest(request,env,run,{readToken,makeToken}) {
  const url=new URL(request.url),path=url.pathname;
  const secure= !["localhost","127.0.0.1"].includes(url.hostname);
  const name=secure?"__Host-aion-session":"aion-session";
  const cookieValue=(request.headers.get("Cookie")||"").split(";").map(s=>s.trim()).find(s=>s.startsWith(name+"="))?.slice(name.length+1)||"";
  // Browser API sessions are exclusively cookie-based; legacy bearer credentials are refused.
  const headers=new Headers(request.headers);headers.delete("Authorization");
  if(cookieValue)headers.set("Authorization","Bearer "+cookieValue);
  const forwarded=new Request(request,{headers});
  const me=cookieValue?await readToken(env,"Bearer "+cookieValue):null;
  const c=me?claims(cookieValue):{};
  const stored=me&&c.sid?JSON.parse(await env.STORE.get("sess:"+c.sid)||"null"):null;
  const mutation=!["GET","HEAD","OPTIONS"].includes(request.method);
  const webhook=path==="/notifications/jira-created";
  if(mutation&&!webhook){
    if(request.headers.get("Origin")!==url.origin)return json({code:"csrf",error:"Request origin is not allowed."},403);
    const anonymous=["/login","/forgot","/reset","/reset/check"].includes(path)||(path==="/logout"&&!me);
    if(!anonymous&&(!stored||request.headers.get("X-AION-CSRF")!==stored.csrf))return json({code:"csrf",error:"Refresh your session and try again."},403);
  }
  const info=(user,expiresAt,csrf)=>({email:user.email,name:user.name,role:user.role,expiresAt,csrf});
  const cookie=(value,maxAge)=>`${name}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure?"; Secure":""}`;
  if(path==="/session"&&request.method==="GET")return me&&stored?json(info(me,c.exp,stored.csrf)):json({code:"session",error:"Please sign in again."},401);
  if(path==="/logout"&&request.method==="POST"){
    if(c.sid)await env.STORE.del("sess:"+c.sid);
    const response=json({ok:true});response.headers.set("Set-Cookie",cookie("",0));return response;
  }
  if(path==="/login"&&request.method==="POST"){
    if(!env.STORE)return json({code:"no_store",error:"Secure sessions require the account database."},503);
    // The existing login verifier issues an internal token; it is never returned to the browser.
    const response=await run(forwarded);if(!response.ok)return response;
    const login=await response.json(),verified=claims(login.token);
    // Login verification itself needs the legacy token format only for this internal operation.
    const sid=random(),csrf=random();const session=await makeToken(env,login.email,Date.now(),verified.v,sid);
    await env.STORE.set("sess:"+sid,JSON.stringify({csrf}),86400);
    if(c.sid)await env.STORE.del("sess:"+c.sid);
    const result=json(info(login,session.expiresAt,csrf));result.headers.set("Set-Cookie",cookie(session.token,86400));return result;
  }
  return run(forwarded);
}
