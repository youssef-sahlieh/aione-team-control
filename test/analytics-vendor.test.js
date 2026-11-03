import {test} from 'node:test';import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';import {createHash} from 'node:crypto';
const dir=new URL('../public/assets/vendor/chartjs/',import.meta.url);
const lib=readFileSync(new URL('chart.umd.js',dir)),notes=readFileSync(new URL('VENDOR.md',dir),'utf8');

test('the vendored Chart.js is the version and file recorded in VENDOR.md',()=>{
  assert.ok(notes.includes(createHash('sha256').update(lib).digest('hex')),'chart.umd.js changed: update VENDOR.md (version and SHA-256)');
  const version=/chart\.js (\d+\.\d+\.\d+)/.exec(notes)[1];
  assert.ok(lib.toString('utf8',0,200).includes('Chart.js v'+version));
  assert.ok(readFileSync(new URL('LICENSE.md',dir),'utf8').includes('MIT'));
});

test('the chart loader stays same-origin and keeps the build stamp',()=>{
  const loader=readFileSync(new URL('../public/assets/components/analytics-charts.js',import.meta.url),'utf8');
  assert.ok(!/https?:\/\//.test(loader.replace(/\/\/.*$/gm,'')),'no remote script URLs');
  assert.match(loader,/import\.meta\.url/);assert.match(loader,/\.search\s*=/);
  const html=readFileSync(new URL('../public/dashboard.html',import.meta.url),'utf8');
  assert.match(html,/script-src 'self'/);assert.match(html,/assets\/styles\/analytics\.css/);
});
