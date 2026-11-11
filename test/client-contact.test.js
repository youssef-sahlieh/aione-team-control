// Adding a client from the Clients & Projects page: what reaches Odoo's res.partner, the checks before it, what happens when
// Odoo refuses or does not answer, duplicates, and the read-back. Odoo is a fake: nothing here reaches a real Odoo.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import worker,{makeToken} from '../proxy/src/handler.js';
import {memoryStore,saveUser} from '../proxy/src/users.js';
import {createClientContact,clientFormOptions,parentCompanyChoices,readContactInput} from '../proxy/src/client-contact.js';

const admin={email:'admin@example.invalid',name:'Manager',role:'admin',dev:'builder',v:1};
const user={email:'user@example.invalid',name:'Dana Developer',role:'user',dev:'builder',v:1};
const UID=7;
const stamp=(d=new Date())=>d.toISOString().replace('T',' ').slice(0,19);

// Odoo's field metadata for res.partner as this fake Odoo describes it. Tests change it to model other Odoos.
function defaultMeta(){
  const w=(type,extra={})=>({type,readonly:false,required:false,...extra});
  return {name:w('char'),company_type:w('selection'),is_company:w('boolean'),parent_id:w('many2one'),email:w('char'),phone:w('char'),
    mobile:w('char'),website:w('char'),street:w('char'),street2:w('char'),city:w('char'),zip:w('char'),country_id:w('many2one'),
    state_id:w('many2one'),vat:w('char'),company_registry:w('char'),ref:w('char'),lang:w('selection'),category_id:w('many2many'),
    comment:w('html'),customer_rank:w('integer')};
}

// A tiny evaluator for the domains the proxy sends (leaf terms, '|' and '&' in prefix form).
const norm=x=>Array.isArray(x)?x[0]:(x===undefined||x===null?false:x);
function evalDomain(rec,dom){
  let i=0;
  const leaf=([f,op,v])=>{
    const a=norm(rec[f]);
    if(op==='=')return a===v||(v===false&&!a);
    if(op==='in')return v.includes(a);
    if(op==='>=')return String(rec[f]??'')>=String(v);
    if(op==='ilike')return String(rec[f]??'').toLowerCase().includes(String(v).toLowerCase());
    throw new Error('fake Odoo: unsupported operator '+op);
  };
  const one=()=>{const t=dom[i++];if(t==='|'){const a=one(),b=one();return a||b;}if(t==='&'){const a=one(),b=one();return a&&b;}return leaf(t);};
  const parts=[];while(i<dom.length)parts.push(one());
  return parts.every(Boolean);
}

function fakeOdoo(){
  const o={calls:[],meta:defaultMeta(),loseAnswer:null,rejectCreate:null,mangle:{},
    countries:[{id:10,name:'Netherlands',code:'NL'},{id:11,name:'Belgium',code:'BE'}],
    states:[{id:20,name:'Noord-Holland',code:'NH',country_id:[10,'Netherlands']},{id:21,name:'Flemish Region',code:'VLG',country_id:[11,'Belgium']}],
    langs:[{id:1,code:'en_US',name:'English',active:true},{id:2,code:'nl_NL',name:'Dutch',active:true},{id:3,code:'fr_FR',name:'French',active:false}],
    tags:[{id:30,name:'VIP'},{id:31,name:'Partner'}],
    partners:[
      {id:1,name:'Acme',is_company:true,company_type:'company',company_id:1,create_uid:UID,create_date:'2020-01-01 10:00:00',category_id:[]},
      {id:2,name:'Beta',is_company:true,company_type:'company',company_id:false,create_uid:UID,create_date:'2020-01-01 10:00:00',category_id:[]},
      {id:3,name:'Jane',is_company:false,company_type:'person',company_id:false,create_uid:UID,create_date:'2020-01-01 10:00:00',category_id:[]}],
    nextId:100};
  const reply=result=>Response.json({result});
  const failure=(message,name)=>Response.json({error:{message:'Odoo Server Error',data:{message,name}}});
  o.fetch=async(u,init)=>{
    const p=JSON.parse(init.body).params;
    if(p.service==='common')return reply(UID);
    const [model,method,args,kw={}]=[p.args[3],p.args[4],p.args[5],p.args[6]];
    o.calls.push({model,method,args,kw});
    if(model==='res.partner'&&method==='fields_get'){
      const out={};for(const n of args[0])if(o.meta[n])out[n]=o.meta[n];return reply(out);
    }
    if(model==='res.users')return reply([{id:UID,company_ids:[1,2]}]);
    if(model==='res.company')return reply([{id:1,name:'All in One'},{id:2,name:'Second'}]);
    if(model==='res.country')return reply(o.countries.filter(r=>evalDomain(r,args[0])).sort((a,b)=>kw.order==='name'?a.name.localeCompare(b.name):0));
    if(model==='res.country.state')return reply(o.states.filter(r=>evalDomain(r,args[0])));
    if(model==='res.lang')return reply(o.langs.filter(r=>evalDomain({active:true,...r},args[0])));
    if(model==='res.partner.category'){
      if(method==='read')return reply(args[0].map(id=>o.tags.find(t=>t.id===id)).filter(Boolean));
      return reply(o.tags.filter(r=>evalDomain(r,args[0])));
    }
    if(model==='res.partner'){
      if(method==='search_read')return reply(o.partners.filter(r=>evalDomain(r,args[0])).slice(0,kw.limit||1000).map(r=>({...r})));
      if(method==='read')return reply(args[0].map(id=>o.partners.find(r=>r.id===id)).filter(Boolean).map(r=>({...r,
        // Odoo returns a many2one as [id, display name]
        parent_id:typeof r.parent_id==='number'?[r.parent_id,o.partners.find(x=>x.id===r.parent_id)?.name]:r.parent_id})));
      if(method==='create'){
        const vals=args[0];
        if(o.rejectCreate)return failure(o.rejectCreate.message,o.rejectCreate.name);
        if(o.loseAnswer==='dropped'){o.loseAnswer=null;throw new TypeError('socket hang up');}
        const rec={id:o.nextId++,company_id:false,create_uid:UID,create_date:stamp(),category_id:[],...vals};
        if(vals.company_type)rec.is_company=vals.company_type==='company';
        if(Array.isArray(vals.category_id)&&vals.category_id[0]?.[0]===6)rec.category_id=vals.category_id[0][2];
        Object.assign(rec,o.mangle);
        o.partners.push(rec);
        if(o.loseAnswer==='saved'){o.loseAnswer=null;throw new TypeError('socket hang up');}
        return reply([rec.id]);
      }
    }
    return reply([]);
  };
  return o;
}
function env(o){
  const store=memoryStore();
  globalThis.fetch=async(url,init={})=>String(url).startsWith('https://odoo.invalid')?o.fetch(url,init):Response.json({},{status:404});
  return {SESSION_SECRET:'synthetic-secret',STORE:store,ODOO_URL:'https://odoo.invalid',ODOO_DB:'db',ODOO_LOGIN:'bot@x',ODOO_API_KEY:'k'};
}
const created=o=>o.calls.filter(c=>c.model==='res.partner'&&c.method==='create');
const body=(extra={})=>({type:'company',name:'Northwind Traders',...extra});
async function expectFail(promise,status,code){
  const e=await promise.then(()=>null,e=>e);
  assert.ok(e,'expected a refusal');
  assert.equal(e.status,status);
  assert.equal(e.code,code);
  return e;
}

test('a name is enough: only the name, the company type and the customer rank go to Odoo',async()=>{
  const o=fakeOdoo(),e=env(o);
  const r=await createClientContact(e,body());
  assert.equal(created(o).length,1);
  assert.deepEqual(created(o)[0].args[0],{name:'Northwind Traders',company_type:'company',customer_rank:1});
  assert.equal(r.reconciled,false);
  assert.equal(r.company,'Northwind Traders');
  assert.match(r.url,/\/web#id=\d+&model=res\.partner&view_type=form$/);
  assert.deepEqual(r.mismatches,[]);
  assert.equal(r.saved[0].label,'Type');
});

test('an individual is saved as a person under a company; a company cannot have a parent',async()=>{
  const o=fakeOdoo(),e=env(o);
  const r=await createClientContact(e,{type:'person',name:'Jane Doe',parentId:'1'});
  assert.equal(created(o)[0].args[0].company_type,'person');
  assert.equal(created(o)[0].args[0].parent_id,1);
  assert.equal(r.company,'Acme');
  await expectFail(createClientContact(env(o),body({parentId:1})),400,'invalid_field');
  await expectFail(createClientContact(env(o),{type:'person',name:'Jane Doe',parentId:999}),400,'invalid_field');
  await expectFail(createClientContact(env(o),{type:'person',name:'Jane Doe',parentId:3}),400,'invalid_field');
});

test('every optional field is sent under its Odoo name; relations are ids; tags are existing ids; blanks are left out',async()=>{
  const o=fakeOdoo(),e=env(o);
  await createClientContact(e,body({email:'ops@northwind.example',phone:'+31 20 123 4567',mobile:'06 1234 5678',website:'northwind.example',
    street:'Keizersgracht 1',street2:'Floor 2',city:'Amsterdam',zip:'1015 CJ',countryId:'10',stateId:20,vat:'NL123456789B01',
    companyRegistry:'KVK 12345678',reference:'NW-01',language:'nl_NL',tagIds:[30,31,30],notes:'Pays on time.\n\nCall first.'}));
  const v=created(o)[0].args[0];
  assert.deepEqual(v,{name:'Northwind Traders',company_type:'company',customer_rank:1,email:'ops@northwind.example',phone:'+31 20 123 4567',
    mobile:'06 1234 5678',website:'https://northwind.example',street:'Keizersgracht 1',street2:'Floor 2',city:'Amsterdam',zip:'1015 CJ',
    country_id:10,state_id:20,vat:'NL123456789B01',company_registry:'KVK 12345678',ref:'NW-01',lang:'nl_NL',
    category_id:[[6,0,[30,31]]],comment:'<p>Pays on time.</p><p><br></p><p>Call first.</p>'});
  assert.equal(created(o).length,1);
  assert.ok(!o.calls.some(c=>c.model==='res.partner.category'&&c.method==='create'),'tags are never created');
});

test('values that are blank or only spaces are not sent at all',async()=>{
  const o=fakeOdoo();
  await createClientContact(env(o),body({email:'   ',street:'',tagIds:[],countryId:null,notes:'  '}));
  assert.deepEqual(Object.keys(created(o)[0].args[0]).sort(),['company_type','customer_rank','name']);
});

test('a state must belong to the chosen country; a state without a country is refused',async()=>{
  const o=fakeOdoo(),e=env(o);
  await expectFail(createClientContact(e,body({countryId:11,stateId:20})),400,'invalid_field');
  await expectFail(createClientContact(e,body({stateId:20})),400,'invalid_field');
  await expectFail(createClientContact(e,body({countryId:999})),400,'invalid_field');
  await expectFail(createClientContact(e,body({countryId:10,stateId:999})),400,'invalid_field');
  assert.equal(created(o).length,0);
});

test('languages and tags must exist in Odoo; an inactive language is refused',async()=>{
  const o=fakeOdoo(),e=env(o);
  await expectFail(createClientContact(e,body({language:'fr_FR'})),400,'invalid_field');
  await expectFail(createClientContact(e,body({language:'xx_YY_ZZ_ZZ'})),400,'invalid_field');
  await expectFail(createClientContact(e,body({tagIds:[30,999]})),400,'invalid_field');
  await expectFail(createClientContact(e,body({tagIds:'30'})),400,'invalid_field');
  await expectFail(createClientContact(e,body({tagIds:[30,'abc']})),400,'invalid_field');
  assert.equal(created(o).length,0);
});

test('the backend refuses unknown fields before Odoo is touched, so no browser field is forwarded',async()=>{
  const o=fakeOdoo(),e=env(o);
  const err=await expectFail(createClientContact(e,body({is_company:false,active:true,user_id:1,comment:'<script>x</script>'})),400,'unknown_field');
  assert.deepEqual(err.details.fields,['is_company','active','user_id','comment']);
  assert.equal(o.calls.length,0);
});

test('wrong types and lengths are refused with the field named; international names and numbers are accepted',async()=>{
  const o=fakeOdoo(),e=env(o);
  await expectFail(createClientContact(e,{name:['x']}),400,'invalid_field');
  await expectFail(createClientContact(e,{type:'robot',name:'X'}),400,'invalid_field');
  await expectFail(createClientContact(e,body({name:'x'.repeat(256)})),400,'invalid_field');
  await expectFail(createClientContact(e,body({email:'not-an-email'})),400,'invalid_field');
  await expectFail(createClientContact(e,body({phone:'call me'})),400,'invalid_field');
  await expectFail(createClientContact(e,body({website:'not a site'})),400,'invalid_field');
  await expectFail(createClientContact(e,body({name:'Bad\u0007Name'})),400,'invalid_field');
  await expectFail(createClientContact(e,body({notes:'x'.repeat(5001)})),400,'invalid_field');
  assert.equal(created(o).length,0);
  const r=await createClientContact(e,body({name:'Müller & Søn 株式会社',phone:'+81 3-1234-5678',city:'Ürümqi',zip:'SW1A 1AA',street:'Čs. armády 12'}));
  assert.equal(r.reconciled,false);
  assert.equal(created(o)[0].args[0].name,'Müller & Søn 株式会社');
  assert.equal(created(o)[0].args[0].phone,'+81 3-1234-5678');
});

test('Odoo fields that are missing or read-only in this Odoo are refused, not guessed at; Odoo-required fields are asked for',async()=>{
  const o=fakeOdoo(),e=env(o);
  delete o.meta.mobile;o.meta.vat.readonly=true;o.meta.street.required=true;
  await expectFail(createClientContact(e,body({mobile:'0612345678'})),400,'invalid_field');
  await expectFail(createClientContact(e,body({vat:'NL1'})),400,'invalid_field');
  await expectFail(createClientContact(e,body({})),400,'invalid_field');
  assert.equal(created(o).length,0);
  const ok=await createClientContact(e,body({street:'Main 1'}));
  assert.equal(ok.reconciled,false);
  const opts=await clientFormOptions(e,{});
  assert.equal(opts.supported.mobile,false);assert.equal(opts.supported.vat,false);assert.equal(opts.supported.email,true);
  assert.equal(opts.required.street,true);
});

test('a company Odoo cannot set (no company type field) is refused for the type, not silently created as a company',async()=>{
  const o=fakeOdoo();delete o.meta.company_type;delete o.meta.is_company;
  await expectFail(createClientContact(env(o),{type:'person',name:'Jane'}),400,'invalid_field');
  assert.equal(created(o).length,0);
});

test('an Odoo validation error is shown with its reason and the field it points at; nothing is saved',async()=>{
  const o=fakeOdoo();o.rejectCreate={message:'The VAT number [NL1] for partner [Northwind] does not seem to be valid.',name:'odoo.exceptions.ValidationError'};
  const err=await expectFail(createClientContact(env(o),body({vat:'NL1'})),400,'odoo_rejected');
  assert.equal(err.details.field,'vat');
  assert.match(err.message,/does not seem to be valid/);
  assert.equal(o.partners.length,3);
});

test('an Odoo permission error says what to ask an administrator; nothing is saved',async()=>{
  const o=fakeOdoo();o.rejectCreate={message:'You are not allowed to create partners.',name:'odoo.exceptions.AccessError'};
  await expectFail(createClientContact(env(o),body()),403,'odoo_forbidden');
  assert.equal(o.partners.length,3);
});

test('a create whose answer is lost is confirmed in Odoo and not created a second time',async()=>{
  const o=fakeOdoo();o.loseAnswer='saved';const e=env(o);
  const r=await createClientContact(e,body({email:'ops@northwind.example'}));
  assert.equal(r.reconciled,true);
  assert.equal(o.partners.filter(p=>p.name==='Northwind Traders').length,1);
  assert.equal(r.id,o.partners.find(p=>p.name==='Northwind Traders').id);
  assert.equal(created(o).length,1);
});

test('a create whose answer is lost and that Odoo never saved is reported as uncertain, and a retry creates it once',async()=>{
  const o=fakeOdoo();o.loseAnswer='dropped';const e=env(o);
  const err=await expectFail(createClientContact(e,body()),502,'uncertain');
  assert.match(err.message,/may or may not be saved/);
  assert.equal(o.partners.filter(p=>p.name==='Northwind Traders').length,0);
  const r=await createClientContact(e,body());
  assert.equal(r.reconciled,false);
  assert.equal(o.partners.filter(p=>p.name==='Northwind Traders').length,1);
});

test('an existing contact with the same name is refused, whoever made it; a recent one by this integration is returned instead',async()=>{
  const o=fakeOdoo(),e=env(o);
  o.partners.push({id:50,name:'Northwind Traders',is_company:true,company_type:'company',company_id:false,create_uid:99,create_date:stamp(),category_id:[]});
  await expectFail(createClientContact(e,body()),409,'exists');
  o.partners.pop();
  o.partners.push({id:51,name:'Northwind Traders',is_company:true,company_type:'company',company_id:false,create_uid:UID,create_date:'2020-01-01 10:00:00',category_id:[]});
  await expectFail(createClientContact(e,body()),409,'exists');
  assert.equal(created(o).length,0);
});

test('repeated submits at the same time create the contact once; the others are refused or read the one saved',async()=>{
  const o=fakeOdoo(),e=env(o);
  const results=await Promise.allSettled([createClientContact(e,body()),createClientContact(e,body()),createClientContact(e,body())]);
  assert.equal(o.partners.filter(p=>p.name==='Northwind Traders').length,1);
  for(const r of results){
    if(r.status==='fulfilled')continue;
    assert.ok(['busy','exists'].includes(r.reason.code),r.reason.code);
  }
  assert.ok(results.some(r=>r.status==='fulfilled'));
  // The lock is released afterwards, so a later, different request still works.
  await createClientContact(e,body({name:'Second Shop'}));
  assert.equal(o.partners.filter(p=>p.name==='Second Shop').length,1);
});

test('a read-back that does not match what was sent is listed with the field, so the page can say so',async()=>{
  const o=fakeOdoo();o.mangle={phone:'+31 00 000 0000'};
  const r=await createClientContact(env(o),body({phone:'+31 20 123 4567'}));
  assert.deepEqual(r.mismatches,[{field:'phone',label:'Phone'}]);
  assert.equal(r.saved.find(x=>x.label==='Phone').value,'+31 00 000 0000');
});

test('the form options come from Odoo: countries, the states of one country, active languages, existing tags and what is supported',async()=>{
  const o=fakeOdoo(),e=env(o);
  const all=await clientFormOptions(e,{});
  assert.deepEqual(all.countries.map(c=>c.code),['BE','NL']);
  assert.deepEqual(all.languages.map(l=>l.code),['en_US','nl_NL']);
  assert.deepEqual(all.tags.map(t=>t.name).sort(),['Partner','VIP']);
  assert.equal(all.supported.parentId,true);assert.equal(all.supported.tagIds,true);assert.equal('states' in all,false);
  const nl=await clientFormOptions(e,{country:'10'});
  assert.equal(nl.country,10);
  assert.deepEqual(nl.states.map(s=>s.code),['NH']);
});

test('parent company choices are the companies the Clients page lists, searched by name',async()=>{
  const o=fakeOdoo(),e=env(o);
  const names=(await parentCompanyChoices(e,'')).map(c=>c.name).sort();
  assert.deepEqual(names,['Acme','Beta']);
  assert.deepEqual((await parentCompanyChoices(e,'ACM')).map(c=>c.name),['Acme']);
  assert.deepEqual((await parentCompanyChoices(e,'jane')).map(c=>c.name),[]);
});

test('readContactInput: blank optional values are empty, and the type defaults to company',()=>{
  const v=readContactInput({name:' Shop ',email:''});
  assert.equal(v.type,'company');assert.equal(v.name,'Shop');assert.equal(v.email,'');assert.deepEqual(v.tagIds,[]);
});

// Through the HTTP routes: only administrators may read the options or add a contact.
async function setup(){
  const o=fakeOdoo(),e=env(o);
  e.TEAM_CONFIG=JSON.stringify({devEmails:{builder:'builder@x'}});
  e.JIRA_PROJECT='AION';e.JIRA_SITE='https://jira.invalid';e.JIRA_EMAIL='bot';e.JIRA_API_TOKEN='secret';
  for(const me of [admin,user])await saveUser(e.STORE,me);
  const tokens={};for(const me of [admin,user])tokens[me.email]=(await makeToken(e,me.email,Date.now(),1)).token;
  const call=async(path,method='GET',payload,me=admin)=>{
    const r=await worker.fetch(new Request('https://proxy.invalid'+path,{method,headers:{Authorization:'Bearer '+tokens[me.email],'Content-Type':'application/json'},...(payload===undefined?{}:{body:JSON.stringify(payload)})}),e);
    return {status:r.status,data:await r.json()};
  };
  return {o,e,call};
}
test('the form options and the parent company search are administrators only',async()=>{
  const s=await setup();
  assert.equal((await s.call('/clients/odoo/options','GET',undefined,user)).status,403);
  assert.equal((await s.call('/clients/odoo/companies?q=ac','GET',undefined,user)).status,403);
  const opts=await s.call('/clients/odoo/options?country=10');
  assert.equal(opts.status,200,JSON.stringify(opts.data));
  assert.deepEqual(opts.data.states.map(x=>x.code),['NH']);
  const comps=await s.call('/clients/odoo/companies?q=ac');
  assert.equal(comps.status,200);
  assert.deepEqual(comps.data.companies.map(c=>c.name),['Acme']);
});
test('the customer route refuses non-administrators and unknown fields, and creates the contact for an administrator',async()=>{
  const s=await setup();
  assert.equal((await s.call('/clients/odoo/customer','POST',body(),user)).status,403);
  const bad=await s.call('/clients/odoo/customer','POST',body({is_company:false}));
  assert.equal(bad.status,400);assert.equal(bad.data.code,'unknown_field');
  assert.equal(created(s.o).length,0);
  const ok=await s.call('/clients/odoo/customer','POST',body({email:'ops@northwind.example'}));
  assert.equal(ok.status,201,JSON.stringify(ok.data));
  assert.equal(typeof ok.data.id,'number');
  assert.equal(ok.data.saved[0].value,'Company');
  assert.ok('client' in ok.data && 'catalog' in ok.data,'the page gets the refreshed catalog');
  assert.equal(created(s.o).length,1);
});
