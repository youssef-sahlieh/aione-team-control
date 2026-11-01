import test from 'node:test';
import assert from 'node:assert/strict';
import {parseDuration,formatMinutes,boxesMinutes} from '../../public/assets/components/work-log.js';

test('durations are read as whole minutes',()=>{
  for(const [text,minutes] of [['90',90],['1:30',90],['1h 30m',90],['1h30m',90],['1.5h',90],['45m',45],['2h',120],['24h',1440],['15 min',15]])assert.equal(parseDuration(text),minutes,text);
  for(const text of ['','abc','1:75','-5','1.25m'])assert.equal(parseDuration(text),null,text);
  assert.equal(formatMinutes(90),'1h 30m');assert.equal(formatMinutes(60),'1h');assert.equal(formatMinutes(5),'5m');
});
// The Hours and Minutes boxes: hours 0–24, minutes 0–59. Saving refuses 0 in total and more than 24 h.
test('the hours and minutes boxes: 1h 0m and 0h 45m are fine; 0 total and 24h 30m are refused',()=>{
  assert.equal(boxesMinutes('1','0'),60);assert.equal(boxesMinutes('0','45'),45);assert.equal(boxesMinutes('','45'),45);assert.equal(boxesMinutes('2',''),120);
  assert.equal(boxesMinutes('0','0'),0,'0 in total: the form refuses it (under 1 minute)');
  assert.equal(boxesMinutes('24','0'),1440);assert.ok(boxesMinutes('24','30')>1440,'24h 30m is over a day: the form refuses it');
  assert.equal(boxesMinutes('0','60'),null,'minutes above 59 are not in the minutes box');assert.equal(boxesMinutes('25','0'),null);
  assert.equal(boxesMinutes('1.5','0'),null);assert.equal(boxesMinutes('-1','0'),null);assert.equal(boxesMinutes('abc','0'),null);
});
