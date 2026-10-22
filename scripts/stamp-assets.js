// Deploy step (GitHub Actions, before publishing public/ to GitHub Pages): gives every page's scripts and
// styles, and every script's imports, a version tag (?v=<commit>). GitHub Pages lets browsers keep files for
// 10 minutes, so without it a browser can show an old version, or mix new and old files, after a deploy.
// Each page also gets <meta name="aione-build">, and version.json holds the live build, so open pages can
// notice a newer deploy (see public/assets/session.js).
//
// Usage: node scripts/stamp-assets.js public <commit>
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const tag = v => encodeURIComponent(String(v).slice(0, 12));
export function stampHtml(html, version) {
  const v = tag(version);
  let out = html.replace(/(\s(?:src|href)=")(assets\/[^"?#]+\.(?:js|css))"/g, (_, attr, url) => attr + url + '?v=' + v + '"');
  if (!/<meta name="aione-build"/.test(out)) out = out.replace(/<head>/i, m => m + '\n<meta name="aione-build" content="' + v + '">');
  return out;
}
// Relative imports only (./x.js, ../x.js): static "from", side-effect "import", and dynamic import().
export function stampJs(js, version) {
  const v = tag(version);
  return js.replace(/(\bfrom\s*|\bimport\s*\(?\s*)(['"])(\.{1,2}\/[^'"?#\s]+\.js)\2/g, (_, before, q, url) => before + q + url + '?v=' + v + q);
}
export function stampDir(dir, version) {
  let files = 0;
  const walk = d => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, entry.name);
      if (entry.isDirectory()) { walk(p); continue; }
      const stamp = p.endsWith('.html') ? stampHtml : p.endsWith('.js') ? stampJs : null;
      if (!stamp) continue;
      const before = fs.readFileSync(p, 'utf8'), after = stamp(before, version);
      if (after !== before) { fs.writeFileSync(p, after); files++; }
    }
  };
  walk(dir);
  fs.writeFileSync(path.join(dir, 'version.json'), JSON.stringify({ build: tag(version) }) + '\n');
  return files;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [dir, version] = process.argv.slice(2);
  if (!dir || !version) { console.error('Usage: node scripts/stamp-assets.js <dir> <version>'); process.exit(1); }
  console.log('Stamped ' + stampDir(dir, version) + ' files with version ' + tag(version) + '.');
}
