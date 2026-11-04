// Lists the client companies (Odoo contacts that are companies) in every company the Odoo integration user can
// access. Read-only. Run: ODOO_URL=... ODOO_DB=... ODOO_LOGIN=... ODOO_API_KEY=... node scripts/list-odoo-companies.js
// Prints JSON: one group per Odoo company, with the contact's name, email, phone and Odoo id.

const { ODOO_URL, ODOO_DB, ODOO_LOGIN, ODOO_API_KEY } = process.env;
if (!ODOO_URL || !ODOO_DB || !ODOO_LOGIN || !ODOO_API_KEY) {
  console.error("Set ODOO_URL, ODOO_DB, ODOO_LOGIN and ODOO_API_KEY first.");
  process.exit(1);
}

let rpcId = 0;
async function rpc(service, method, args) {
  const res = await fetch(ODOO_URL.replace(/\/+$/, "") + "/jsonrpc", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", method: "call", id: ++rpcId, params: { service, method, args } })
  });
  const data = await res.json();
  if (data.error) throw new Error((data.error.data && data.error.data.message) || data.error.message);
  return data.result;
}
const call = async (uid, model, method, args, kwargs = {}) =>
  rpc("object", "execute_kw", [ODOO_DB, uid, ODOO_API_KEY, model, method, args, kwargs]);

const uid = await rpc("common", "authenticate", [ODOO_DB, ODOO_LOGIN, ODOO_API_KEY, {}]);
if (!uid) throw new Error("Odoo didn't accept the login and API key.");

const [user] = await call(uid, "res.users", "search_read", [[["id", "=", uid]]], { fields: ["company_ids"], limit: 1 });
const companies = await call(uid, "res.company", "search_read", [[["id", "in", user.company_ids]]], { fields: ["name"], order: "sequence, id" });

const out = [];
for (const company of companies) {
  // Same rule as the dashboard's client catalog: top-level contacts that are companies, not user accounts.
  const partners = await call(uid, "res.partner", "search_read", [[
    ["parent_id", "=", false], ["user_ids", "=", false], ["is_company", "=", true], ["company_id", "=", company.id]
  ]], { fields: ["display_name", "email", "phone"], order: "display_name", limit: 5000 });
  out.push({
    company: company.name,
    companyId: company.id,
    count: partners.length,
    clients: partners.map((p) => ({ id: p.id, name: String(p.display_name || "").trim(), email: p.email || "", phone: p.phone || "" }))
  });
}

console.log(JSON.stringify(out, null, 2));
