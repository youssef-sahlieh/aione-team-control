import {test} from 'node:test';
import assert from 'node:assert/strict';
import {tokenize,buildIndex,rankSimilar,vote,developerValues,billingValues} from '../proxy/src/ticket-suggest.js';

// Synthetic tickets only.
const corpus=[
 {key:'AION-1',summary:'Login page crashes on Safari',description:'Session cookie missing after sign in',epic:'AION-E1',labels:['ai1_alice'],devs:['alice'],billing:'billable'},
 {key:'AION-2',summary:'Login redirect loop after sign in',description:'Cookie not set on Safari',epic:'AION-E1',labels:['ai1_alice'],devs:['alice'],billing:'billable'},
 {key:'AION-3',summary:'Session expires too early on Safari',description:'Login cookie lifetime wrong',epic:'AION-E1',labels:['ai1_alice'],devs:['alice'],billing:'billable'},
 {key:'AION-4',summary:'Export monthly report to CSV',description:'Columns out of order in the export',epic:'AION-E2',labels:['ai1_bob'],devs:['bob'],billing:'not_billable'},
 {key:'AION-5',summary:'Report totals ignore nonbillable rows',description:'CSV export of totals',epic:'AION-E2',labels:['ai1_bob'],devs:['bob'],billing:'not_billable'},
 {key:'AION-6',summary:'Add dark theme to settings',description:'',epic:null,labels:[],devs:[],billing:null},
];

test('tokenize lowercases, splits and drops stopwords and single characters', () => {
 assert.deepEqual(tokenize('The Login-page, of A!'),['login','page']);
 assert.deepEqual(tokenize(null),[]);
});

test('rankSimilar puts tickets about the same topic first and excludes the target', () => {
 const index=buildIndex(corpus);
 const target={key:'AION-99',summary:'Safari login cookie problem',description:'user cannot stay signed in',epic:'AION-E1',labels:[]};
 const ranked=rankSimilar(target,index,10);
 assert.ok(ranked.length>0);
 assert.ok(ranked.slice(0,3).every(c=>c.ticket.epic==='AION-E1'));
 assert.ok(!ranked.some(c=>c.ticket.key==='AION-99'));
});

test('rankSimilar excludes the target when it is already in the corpus', () => {
 const index=buildIndex(corpus);
 const ranked=rankSimilar(corpus[0],index,10);
 assert.ok(!ranked.some(c=>c.ticket.key==='AION-1'));
});

test('rankSimilar returns nothing for a target with no known terms', () => {
 const index=buildIndex(corpus);
 assert.deepEqual(rankSimilar({key:'X',summary:'zzqq wwrr',description:''},index),[]);
});

test('vote picks the developer label of the closest tickets with a confidence and evidence', () => {
 const index=buildIndex(corpus);
 const target={key:'AION-99',summary:'Safari login cookie problem',description:'cannot stay signed in',epic:'AION-E1',labels:[]};
 const result=vote(rankSimilar(target,index,10),developerValues);
 assert.equal(result.value,'alice');
 assert.ok(result.confidence>=0.5 && result.confidence<=1);
 assert.ok(result.evidence.every(k=>['AION-1','AION-2','AION-3'].includes(k)));
 assert.equal(result.reason,'similar-tickets');
});

test('vote withholds a suggestion when there are too few candidates', () => {
 const result=vote([{ticket:corpus[0],similarity:0.9}],developerValues);
 assert.deepEqual(result,{value:null,confidence:0,evidence:[],reason:'insufficient-data'});
});

test('vote withholds a suggestion when candidates disagree', () => {
 const split=[0,1,2,3].map(i=>({ticket:{key:'K'+i,devs:[i%2?'alice':'bob']},similarity:0.5}));
 const result=vote(split,developerValues,{minCandidates:3,minConfidence:0.6});
 assert.equal(result.value,null);
 assert.equal(result.reason,'low-confidence');
});

test('billing vote ignores candidates with no billing value', () => {
 const candidates=[
  {ticket:{key:'A',billing:'billable'},similarity:0.8},
  {ticket:{key:'B',billing:'billable'},similarity:0.6},
  {ticket:{key:'C',billing:null},similarity:0.9},
  {ticket:{key:'D',billing:'billable'},similarity:0.4},
 ];
 const result=vote(candidates,billingValues);
 assert.equal(result.value,'billable');
 assert.deepEqual(result.evidence,['A','B','D']);
 assert.equal(result.confidence,1);
});

test('billingValues treats only billable and not_billable as evidence', () => {
 assert.deepEqual(billingValues({billing:'billable'}),['billable']);
 assert.deepEqual(billingValues({billing:'not_billable'}),['not_billable']);
 assert.deepEqual(billingValues({billing:'maybe'}),[]);
 assert.deepEqual(billingValues({}),[]);
});
