import {buildWorkbook} from './xlsx-write.js';
import {flagLabel} from './report-view.js';
import {csvCell} from './ticket-business.js';

export const BILLING_LABELS={billable:'Billable',not_billable:'Not billable'};
export const BILLING_CHOICES=['Billable','Not billable'];
const billingText=v=>BILLING_LABELS[v]||(v?String(v):'');
const dateOnly=v=>typeof v==='string'&&/^\d{4}-\d{2}-\d{2}/.test(v)?v.slice(0,10):null;

// The Tickets sheet is also the import format: Ticket, Client, Project, Billing and Agreed hours are read back by table-import.js.
export const TICKET_COLUMNS=[
 {header:'Ticket',width:12},{header:'Title',width:44},{header:'Status',width:16},{header:'Client',width:24},{header:'Project',width:24},{header:'Billing',width:14},
 {header:'Developers',width:24},{header:'Estimated hours',type:'hours',width:12},{header:'Agreed hours',type:'hours',width:12},{header:'Logged hours',type:'hours',width:12},
 {header:'Actual hours',type:'hours',width:12},{header:'Hours over agreed',type:'hours',width:14},{header:'Flag',width:20},{header:'Odoo status',width:16},
 {header:'Created',type:'date',width:12},{header:'Completed',type:'date',width:12}];

const ticketRow=t=>[t.key,t.title,t.status,t.clientName||'',t.subClientName||'',billingText(t.billing),(t.devs||[]).join('; '),t.estimatedHours,t.agreedHours,t.loggedHours,t.actualHours,t.overHours,flagLabel(t),t.odooStatus||'',dateOnly(t.created),dateOnly(t.completedAt)];

// rows: the tickets on screen (filters and chart selection applied). info: {period:{start,end}, generatedAt, filters:[[label,value]], warnings}
export function reportSheets(rows,info={}){
 const hours=k=>rows.reduce((s,t)=>typeof t[k]==='number'&&Number.isFinite(t[k])?s+t[k]:s,0),known=k=>rows.filter(t=>typeof t[k]==='number'&&Number.isFinite(t[k])).length;
 const r2=n=>Math.round(n*100)/100;
 const summary=[['Report','AION business report'],['Generated',info.generatedAt||''],['Period',info.period?info.period.start+' to '+info.period.end:''],
  ...(info.filters||[]).filter(([,v])=>v),['Tickets',rows.length],['Logged hours',r2(hours('loggedHours'))],['Logged hours recorded on',known('loggedHours')+' of '+rows.length+' tickets'],
  ['Agreed hours',r2(hours('agreedHours'))],['Agreed hours set on',known('agreedHours')+' of '+rows.length+' tickets'],['Needs checkup',rows.filter(t=>t.overage==='overage').length],
  ...(info.warnings||[]).map(w=>['Note',w]),['How to edit','Change Client, Project, Billing or Agreed hours on the Tickets sheet, save, then use Import in Checks & Reports. Blank cells change nothing.']];
 const people=new Map();
 for(const t of rows)for(const e of t.employees||[]){const k=e.name+'\u0000'+(t.clientName||'');const g=people.get(k)||{name:e.name,client:t.clientName||'Client not set',hours:0,tickets:0};g.hours+=Number(e.hours)||0;g.tickets++;people.set(k,g);}
 const byEmployee=[...people.values()].sort((a,b)=>a.name.localeCompare(b.name)||b.hours-a.hours).map(g=>[g.name,g.client,g.tickets,r2(g.hours)]);
 return [
  {name:'Summary',columns:[{header:'Item',width:26},{header:'Value',width:70}],rows:summary.map(([a,b])=>[a,typeof b==='number'?b:String(b)])},
  {name:'Tickets',columns:TICKET_COLUMNS,rows:rows.map(ticketRow),freezeHeader:true,autoFilter:true,validations:[{column:5,list:BILLING_CHOICES}]},
  {name:'By employee',columns:[{header:'Employee',width:24},{header:'Client',width:26},{header:'Tickets',type:'number',width:10},{header:'Logged hours',type:'hours',width:14}],rows:byEmployee,freezeHeader:true,autoFilter:true},
 ];
}
export const buildReportWorkbook=(rows,info,opts)=>buildWorkbook(reportSheets(rows,info),opts);

// A blank import file: the columns the import understands, with a Notes sheet.
export function templateSheets(){
 return [
  {name:'Tickets',columns:[{header:'Ticket',width:14},{header:'Agreed hours',type:'hours',width:14},{header:'Client',width:26},{header:'Project',width:26},{header:'Billing',width:14}],rows:[],freezeHeader:true,validations:[{column:4,list:BILLING_CHOICES}]},
  {name:'Notes',columns:[{header:'How to fill this in',width:100}],rows:[['Ticket: the ticket key, for example AION-123 or INT-45. One row per ticket.'],['Agreed hours: a positive number, up to 2 decimals. Needs a developer on the ticket.'],['Client and Project: the exact names from Clients. Fill Client when you fill Project, unless the project name is unique.'],['Billing: Billable or Not billable (administrators only).'],['Leave a cell blank to keep the current value. Nothing is ever cleared by an import.'],['Only the Tickets sheet is read; this Notes sheet is ignored.']]},
 ];
}
export const buildTemplate=opts=>buildWorkbook(templateSheets(),opts);

export const errorsCsv=rows=>['﻿'+['Row','Ticket','Problem'].map(csvCell).join(','),...rows.map(r=>[r.line,r.key,r.message].map(csvCell).join(','))].join('\r\n');
