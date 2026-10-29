import {test} from "node:test";
import assert from "node:assert/strict";
import {monitorInstanceUrl} from "../../public/assets/models/monitor-links.js";
test("Open links go to the instance's info page on AI1 Monitor",()=>{
  assert.equal(monitorInstanceUrl("000"),"https://monitor.ai1.host/dashboard#instance/000/info");
});
test("instance names are encoded so they cannot change the address",()=>{
  assert.equal(monitorInstanceUrl("a b/c?d#e"),"https://monitor.ai1.host/dashboard#instance/a%20b%2Fc%3Fd%23e/info");
});
