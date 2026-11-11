import test from 'node:test';
import assert from 'node:assert/strict';
import {formatMinutes,ticketMatches} from '../../public/assets/components/work-log.js';

// The ticket picker on the Work log page: every word must match the key or the title.
test('the ticket picker matches on key and title, every word must match',()=>{
  const tickets=[{key:'AION-12',title:'Fix login redirect'},{key:'INT-3',title:'Office Wi-Fi'},{key:'HD-99',title:'Login help desk'}];
  assert.deepEqual(ticketMatches(tickets,'').map(t=>t.key),['AION-12','INT-3','HD-99']);
  assert.deepEqual(ticketMatches(tickets,'aion-12').map(t=>t.key),['AION-12']);
  assert.deepEqual(ticketMatches(tickets,'  LOGIN  redirect ').map(t=>t.key),['AION-12']);
  assert.deepEqual(ticketMatches(tickets,'login hd').map(t=>t.key),['HD-99']);
  assert.deepEqual(ticketMatches(tickets,'nothing here'),[]);
  const many=Array.from({length:80},(_,i)=>({key:'AION-'+i,title:'Same'}));
  assert.equal(ticketMatches(many,'same').length,50,'at most 50 are shown');
});

// Minutes are shown as H:MM everywhere (the same format Odoo uses).
test('minutes are shown as H:MM',()=>{
  assert.equal(formatMinutes(90),'1:30');
  assert.equal(formatMinutes(60),'1:00');
  assert.equal(formatMinutes(5),'0:05');
  assert.equal(formatMinutes(1440),'24:00');
  assert.equal(formatMinutes(0),'0:00');
  assert.equal(formatMinutes(-4),'0:00','negative input is shown as 0');
  assert.equal(formatMinutes(undefined),'0:00','non-numbers count as 0');
});
