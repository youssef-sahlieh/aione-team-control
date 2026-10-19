import { renderAIAnswer } from "./models/ai-answer-renderer.js";
import { reportPresets, buildReportPrompt } from "./models/ai-report-presets.js";
import { api } from "./session.js";
const $=id=>document.getElementById(id);
const node=(tag,cls,text)=>{const n=document.createElement(tag);if(cls)n.className=cls;if(text)n.textContent=text;return n;};
export function createAIAssistant({openIssue,beforeOpen}) {
  const panel=$("ai-panel"), launcher=$("ai-launcher"), log=$("ai-messages"), input=$("ai-question"), send=$("ai-send"), status=$("ai-status"), shell=document.querySelector(".app-shell");
  let enabled=false,busy=false,opener=null,history=[],generation=0;
  const builder=$("ai-report-builder");
  for(const preset of reportPresets){const button=node("button","ai-report-card");button.type="button";button.dataset.aiReport=preset.id;button.append(node("strong","",preset.title),node("span","",preset.description));button.addEventListener("click",()=>{if(busy||!enabled)return;input.value=buildReportPrompt(preset.id,{days:Number($("ai-report-days").value),focus:$("ai-report-focus").value});status.textContent="Prompt ready. Review it, then send to run the report.";input.focus();});$("ai-report-presets").append(button);}
  function setBusy(value){busy=value;send.disabled=value||!enabled;$("ai-new").disabled=value;input.disabled=!enabled;panel.setAttribute("aria-busy",String(value));for(const control of builder.querySelectorAll("button,input,select"))control.disabled=value||!enabled;}
  function close(){panel.hidden=true;$("ai-scrim").hidden=true;shell.inert=false;document.body.classList.remove("ai-open");launcher.setAttribute("aria-expanded","false");opener?.focus();}
  function addMessage(role,content,references=[]){
    const row=node("article","ai-message ai-message-"+role);row.appendChild(node("div","ai-author",role==="user"?"You":"AION AI"));
    const body=node("div","ai-message-text");body.dir="auto";
    if(role==="assistant")renderAIAnswer(document,body,content,references,key=>{close();openIssue(key);});else body.textContent=content;
    row.appendChild(body);
    if(role==="assistant"){
      const actions=node("div","ai-answer-actions"),copy=node("button","ai-copy-answer","Copy answer");copy.type="button";copy.addEventListener("click",async()=>{try{await navigator.clipboard.writeText(content);copy.textContent="Copied";}catch{copy.textContent="Copy unavailable";}});actions.append(copy);
      const linked=new Set([...body.querySelectorAll(".ai-ticket-link")].map(a=>a.textContent));if(linked.size)actions.append(node("span","ai-answer-sources",linked.size+" linked ticket"+(linked.size===1?"":"s")));row.append(actions);
    }
    log.appendChild(row);$("ai-welcome").hidden=true;$("ai-main").scrollTop=$("ai-main").scrollHeight;
  }
  async function submit(question){
    if(busy||!enabled)return;const content=question.trim();if(!content)return;
    if(content.length>2000){status.textContent="Please keep your question under 2,000 characters.";return;}
    const previous=history.slice(-12);
    while(previous.length&&new TextEncoder().encode(JSON.stringify({message:content,history:previous})).length>28000)previous.splice(0,2);
    addMessage("user",content);input.value="";setBusy(true);status.textContent="Reading your authorized tickets…";
    const turn=++generation;
    try{
      const result=await api("/ai/chat",{method:"POST",body:{message:content,history:previous}});
      if(turn!==generation)return;
      if(typeof result?.answer!=="string")throw new Error("No answer returned. Please try again.");
      addMessage("assistant",result.answer,Array.isArray(result.references)?result.references:[]);
      history.push({role:"user",content},{role:"assistant",content:result.answer});history=history.slice(-12);
      status.textContent="";
    }catch(err){if(turn!==generation)return;status.textContent=err.code==="network"?"Could not connect. Please try again.":err.message||"Could not answer. Please try again.";input.value=content;}
    finally{if(turn===generation){setBusy(false);if(!panel.hidden)input.focus();}}
  }
  launcher.addEventListener("click",()=>{if(!beforeOpen())return;opener=document.activeElement;panel.hidden=false;$("ai-scrim").hidden=false;shell.inert=true;document.body.classList.add("ai-open");launcher.setAttribute("aria-expanded","true");(enabled?input:$("ai-close")).focus();});
  $("ai-close").addEventListener("click",close);$("ai-scrim").addEventListener("click",close);
  $("ai-form").addEventListener("submit",e=>{e.preventDefault();submit(input.value);});
  input.addEventListener("keydown",e=>{if(e.key==="Enter"&&!e.shiftKey&&!e.isComposing){e.preventDefault();submit(input.value);}});
  $("ai-new").addEventListener("click",()=>{history=[];log.replaceChildren();$("ai-welcome").hidden=false;status.textContent="";input.value="";input.focus();});
  for(const button of document.querySelectorAll("[data-ai-prompt]"))button.addEventListener("click",()=>submit(button.dataset.aiPrompt));
  document.addEventListener("keydown",e=>{
    if(panel.hidden)return;
    if(e.key==="Escape"){e.preventDefault();close();return;}
    if(e.key!=="Tab")return;
    const targets=[...panel.querySelectorAll("button,a[href],textarea,input,select")].filter(n=>!n.disabled&&n.getClientRects().length);
    const first=targets[0],last=targets.at(-1);
    if(e.shiftKey&&document.activeElement===first){e.preventDefault();last.focus();}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first.focus();}
  });
  return {configure(cfg){const manager=cfg.role==="admin";enabled=!!cfg.ai?.enabled;builder.hidden=!manager;if(!enabled&&!panel.hidden)close();launcher.hidden=!enabled;launcher.disabled=!enabled;setBusy(false);status.textContent="";$("ai-scope").textContent=manager?"Read-only tickets and team insights":"Read-only help with your tickets";$("ai-welcome-title").textContent=manager?"A clearer view of your team.":"Help with your tickets.";$("ai-welcome-description").textContent=manager?"Draft a report, inspect the evidence, and decide what needs attention.":"Understand your own tickets, comments, deadlines and next steps.";input.placeholder=manager?"Ask about tickets, your team or project progress…":"Ask about your tickets or comments…";for(const b of document.querySelectorAll("[data-ai-prompt]")){b.disabled=!enabled;b.hidden=(b.hasAttribute("data-ai-admin")&&!manager)||(b.hasAttribute("data-ai-user")&&manager);}}};
}
