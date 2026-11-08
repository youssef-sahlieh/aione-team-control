import test from 'node:test';
import assert from 'node:assert/strict';
import {parseDuration,formatMinutes,boxesMinutes,durationErrors,ticketMatches} from '../../public/assets/components/work-log.js';

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

test('durations are read as whole minutes',()=>{
  for(const [text,minutes] of [['90',90],['1:30',90],['1h 30m',90],['1h30m',90],['1.5h',90],['45m',45],['2h',120],['24h',1440],['15 min',15]])assert.equal(parseDuration(text),minutes,text);
  for(const text of ['','abc','1:75','-5','1.25m'])assert.equal(parseDuration(text),null,text);
  assert.equal(formatMinutes(90),'1h 30m');assert.equal(formatMinutes(60),'1h');assert.equal(formatMinutes(5),'5m');
});
// The Hours and Minutes boxes: hours 0–24, minutes 0–59. Saving refuses 0 in total and more than 24 h.
test('the hours and minutes boxes: 1h 0m and 0h 45m are fine; 0 total and 24h 30m are refused',()=>{
  assert.equal(boxesMinutes('1','0'),60);assert.equal(boxesMinutes('0','45'),45);assert.equal(boxesMinutes('','45'),45);assert.equal(boxesMinutes('2',''),120);
  assert.equal(boxesMinutes('0','0'),0,'0 in total: the form refuses it (under 1 minute)');
  assert.equal(boxesMinutes('24','0'),1440);assert.equal(boxesMinutes('24','30'),null,'with 24 hours, minutes must be 0');
  assert.equal(boxesMinutes('0','60'),null,'minutes above 59 are not in the minutes box');assert.equal(boxesMinutes('25','0'),null);
  assert.equal(boxesMinutes('1.5','0'),null);assert.equal(boxesMinutes('-1','0'),null);assert.equal(boxesMinutes('abc','0'),null);
});
// Field errors: each box says what is wrong with it; a total of 0 is named under the group.
test('duration errors name the box that is wrong',()=>{
  assert.deepEqual(durationErrors('1','30'),{hours:'',minutes:'',total:''});
  assert.deepEqual(durationErrors('','15'),{hours:'',minutes:'',total:''});
  assert.deepEqual(durationErrors('','0'),{hours:'',minutes:'',total:'Enter at least 1 minute.'});
  assert.deepEqual(durationErrors('','').total,'Enter at least 1 minute.');
  assert.equal(durationErrors('25','0').hours,'Whole number from 0 to 24.');
  assert.equal(durationErrors('1.5','0').hours,'Whole number from 0 to 24.');
  assert.equal(durationErrors('0','60').minutes,'Whole number from 0 to 59.');
  assert.equal(durationErrors('24','5').minutes,'With 24 hours, minutes must be 0.');
  assert.deepEqual(durationErrors('24','0'),{hours:'',minutes:'',total:''});
});
