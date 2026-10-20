import test from 'node:test';
import assert from 'node:assert/strict';
import {parseDuration,formatMinutes} from '../../public/assets/components/work-log.js';

test('durations are read as whole minutes',()=>{
  for(const [text,minutes] of [['90',90],['1:30',90],['1h 30m',90],['1h30m',90],['1.5h',90],['45m',45],['2h',120],['24h',1440],['15 min',15]])assert.equal(parseDuration(text),minutes,text);
  for(const text of ['','abc','1:75','-5','1.25m'])assert.equal(parseDuration(text),null,text);
  assert.equal(formatMinutes(90),'1h 30m');assert.equal(formatMinutes(60),'1h');assert.equal(formatMinutes(5),'5m');
});
