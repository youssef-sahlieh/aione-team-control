// Groq-hosted free-tier adapter. Only application-defined read tools are advertised.
export const DEFAULT_GROQ_MODEL = 'openai/gpt-oss-120b';
export class GroqError extends Error {
  constructor(code,message,status=502){super(message);Object.assign(this,{code,status});}
}
const fail=(code,message,status)=>{throw new GroqError(code,message,status);};
const dailyMemory=new Map();
async function reserveRequest(env){
  const limit=env.GROQ_DAILY_REQUEST_LIMIT==null||env.GROQ_DAILY_REQUEST_LIMIT===''?100:Number(env.GROQ_DAILY_REQUEST_LIMIT);
  if(!Number.isInteger(limit)||limit<1||limit>1000)fail('ai_configuration','Ask a manager to set a daily AI request limit between 1 and 1,000.',503);
  const day=new Date().toISOString().slice(0,10),key='rl:ai:groq:'+String(env.JIRA_PROJECT||'AION')+':'+day;
  let count;
  try{if(env.STORE)count=await env.STORE.incr(key,90000);else{for(const k of dailyMemory.keys())if(!k.endsWith(day))dailyMemory.delete(k);count=(dailyMemory.get(key)||0)+1;dailyMemory.set(key,count);}}
  catch{fail('ai_unavailable','AI usage limits could not be checked. Please try again.',503);}
  if(!Number.isFinite(Number(count))||Number(count)<1)fail('ai_unavailable','AI usage limits could not be checked. Please try again.',503);
  if(count>limit)fail('ai_quota','The daily AI allowance has been reached. Try again after the next daily reset. Calculated reports remain available.',429);
}
// Preserve calculated totals while explicitly bounding the evidence sent to the free model.
function compactEvidence(output){
  if(output.length<=7000)return output;
  let value;try{value=JSON.parse(output);}catch{return output;}
  const data=value?.data;if(!data||typeof data!=='object')return output;
  const arrays=['tickets','groups','comments'].filter(k=>Array.isArray(data[k])),omitted={};
  data.modelContextCoverage={truncated:true,omittedRows:omitted,note:'Evidence rows were omitted to fit the free AI quota. Source totals and coverage are unchanged; use a narrower lookup for omitted details.'};
  while(JSON.stringify(value).length>7000){const k=arrays.filter(k=>data[k].length).sort((a,b)=>JSON.stringify(data[b]).length-JSON.stringify(data[a]).length)[0];if(!k)break;data[k].pop();omitted[k]=(omitted[k]||0)+1;}
  if(omitted.tickets){if(typeof data.returned==='number')data.returned=data.tickets.length;if(typeof data.coverage?.returned==='number')data.coverage.returned=data.tickets.length;}
  if(data.detailCoverage){if(omitted.tickets)data.detailCoverage.ticketsReturned=data.tickets.length;if(omitted.groups)data.detailCoverage.groupsReturned=data.groups.length;}
  return JSON.stringify(value);
}
export async function groqResponse(env,body){
  const messages=[{role:'system',content:body.instructions}],calls=new Map();
  for(const item of body.input){
    if(item.type==='function_call'){
      calls.set(item.call_id,item.name);let previous=messages.at(-1);
      if(previous.role!=='assistant'||!previous.tool_calls){previous={role:'assistant',content:null,tool_calls:[]};messages.push(previous);}
      previous.tool_calls.push({id:item.call_id,type:'function',function:{name:item.name,arguments:item.arguments}});
    }else if(item.type==='function_call_output')messages.push({role:'tool',tool_call_id:item.call_id,name:calls.get(item.call_id),content:compactEvidence(item.output)});
    else if(item.type==='message')messages.push({role:'assistant',content:(item.content||[]).filter(p=>p.type==='output_text').map(p=>p.text).join('\n')});
    else if(['user','assistant'].includes(item.role))messages.push({role:item.role,content:item.content});
  }
  const model=env.AI_MODEL||DEFAULT_GROQ_MODEL;
  const payload={model,messages,stream:false,max_completion_tokens:Math.max(1024,Math.min(body.max_output_tokens||1800,2048))};
  if(model.startsWith('openai/gpt-oss-'))Object.assign(payload,{reasoning_effort:'low',include_reasoning:false});
  if(body.tools?.length){payload.tools=body.tools.map(t=>({type:'function',function:{name:t.name,description:t.description,parameters:t.parameters}}));payload.tool_choice=body.tool_choice==='none'?'none':'auto';payload.parallel_tool_calls=false;}
  const serialized=JSON.stringify(payload);
  if(new TextEncoder().encode(serialized).length>24000)fail('ai_context_limit','This conversation is too large for the free AI allowance. Start a new chat or ask about fewer tickets.',422);
  await reserveRequest(env);
  let response;
  try{response=await fetch('https://api.groq.com/openai/v1/chat/completions',{method:'POST',headers:{Authorization:'Bearer '+env.GROQ_API_KEY,'Content-Type':'application/json'},body:serialized,redirect:'error',signal:AbortSignal.timeout(25000)});}
  catch{fail('ai_unavailable','The AI service could not be reached. Please try again.',502);}
  if(!response.ok){if(response.status===429)fail('ai_quota','The free AI quota is temporarily exhausted. Try again later or ask about fewer tickets. Calculated reports remain available.',429);fail('ai_unavailable','The AI service is unavailable. Ask a manager to check its configuration.',502);}
  let result;try{result=await response.json();}catch{fail('ai_unavailable','The AI service returned an invalid answer.',502);}
  const choice=result?.choices?.[0],answer=choice?.message;
  if(!answer||answer.role!=='assistant'||(answer.content!=null&&typeof answer.content!=='string')||(answer.tool_calls!=null&&!Array.isArray(answer.tool_calls)))fail('ai_unavailable','The AI service returned an invalid answer.',502);
  if(choice.finish_reason==='length')fail('ai_limit','The AI answer reached its response limit. Please ask a narrower question.',422);
  const output=[];
  if(answer.content)output.push({type:'message',content:[{type:'output_text',text:answer.content}]});
  for(const call of answer.tool_calls||[]){if(call.type!=='function'||typeof call.id!=='string'||!call.id||typeof call.function?.name!=='string'||typeof call.function?.arguments!=='string')fail('ai_tool','The AI returned an invalid tool request.',502);output.push({type:'function_call',call_id:call.id,name:call.function.name,arguments:call.function.arguments});}
  return {output};
}
