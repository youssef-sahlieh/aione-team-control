// Gives Odoo projects made by the dashboard before it set them up the setup new projects now get (see
// projectSetup in proxy/src/ticket-metadata.js): the task stages, timesheets, visibility and billing of the latest
// project of the main company that has stages, in the main company. Without stages Odoo doesn't offer a project
// when adding a task in a stage of All Tasks, nor for timesheets.
// Run: ODOO_URL=... ODOO_DB=... ODOO_LOGIN=... ODOO_API_KEY=... node scripts/repair-odoo-projects.js 361 362 [--apply]
// Without --apply it only prints, for each project, how it differs from the reference project and what would change.
import { odoo } from "../proxy/src/odoo.js";
import { projectSetup } from "../proxy/src/ticket-metadata.js";

const env = process.env, apply = process.argv.includes("--apply");
const ids = process.argv.slice(2).filter((a) => /^\d+$/.test(a)).map(Number);
if (!env.ODOO_URL || !env.ODOO_DB || !env.ODOO_LOGIN || !env.ODOO_API_KEY) {
  console.error("Set ODOO_URL, ODOO_DB, ODOO_LOGIN and ODOO_API_KEY first.");
  process.exit(1);
}
if (!ids.length) {
  console.error("Name the Odoo project ids, e.g. node scripts/repair-odoo-projects.js 361 362");
  process.exit(1);
}

const { reference, values } = await projectSetup(env);
// Every setting-like field (not names, dates, counts or messages), to show any other difference from the reference.
const all = await odoo(env, "project.project", "fields_get", [], { attributes: ["type", "store", "string"] });
const compared = Object.keys(all).filter((f) => all[f].store && ["boolean", "selection", "many2one", "many2many"].includes(all[f].type) &&
  !/^(message_|activity_|website_message|rating_|create_|write_|favorite_user_ids|user_id$|partner_id$|stage_id$|last_update)/.test(f));
const [ref, ...rows] = await odoo(env, "project.project", "read", [[reference, ...ids]], { fields: ["name", ...compared], context: { active_test: false } });
const shown = (v) => (Array.isArray(v) ? (v.length === 2 && typeof v[1] === "string" ? v[1] : JSON.stringify(v)) : JSON.stringify(v));
console.log(`Reference: #${ref.id} ${ref.name}`);

for (const p of rows) {
  console.log(`\n#${p.id} ${p.name}`);
  for (const f of compared) if (JSON.stringify(p[f]) !== JSON.stringify(ref[f])) console.log(`  ${f} (${all[f].string}): ${shown(p[f])}  reference: ${shown(ref[f])}`);
  // Stages are added to the project's own, never removed.
  const change = { ...values, type_ids: values.type_ids[0][2].filter((s) => !p.type_ids.includes(s)).map((s) => [4, s]) };
  if (!change.type_ids.length) delete change.type_ids;
  for (const f of Object.keys(change)) if (f !== "type_ids" && JSON.stringify(Array.isArray(p[f]) ? p[f][0] : p[f]) === JSON.stringify(change[f])) delete change[f];
  if (!Object.keys(change).length) { console.log("  Nothing to change."); continue; }
  console.log("  " + (apply ? "Writing" : "Would write") + ": " + JSON.stringify(change));
  if (apply) { await odoo(env, "project.project", "write", [[p.id], change]); console.log("  Done."); }
}
if (!apply) console.log("\nNothing was changed. Run again with --apply to write the changes.");
