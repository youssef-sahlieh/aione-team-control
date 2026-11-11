// The Add client form on the Clients & Projects page: the checks the browser makes before saving, and the body it sends.
// The backend (proxy/src/client-contact.js) checks the same things again and decides what Odoo accepts, so this only spares
// a round trip. Blank optional values are left out of the body; fields this Odoo does not allow are left out as well.

export const CLIENT_TEXT = ['name', 'email', 'phone', 'mobile', 'website', 'street', 'street2', 'city', 'zip', 'vat',
  'companyRegistry', 'reference', 'language', 'notes'];
export const CLIENT_IDS = ['parentId', 'countryId', 'stateId'];
export const CLIENT_LIMITS = { name: 255, email: 254, phone: 40, mobile: 40, website: 255, street: 255, street2: 255, city: 128,
  zip: 24, vat: 64, companyRegistry: 64, reference: 64, language: 20, notes: 5000 };

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const CONTROL = /[\x00-\x1f\x7f]/;
const trim = v => String(v ?? '').trim();

// A web address with or without http(s)://, like the backend reads it.
export function validWebsite(text) {
  const candidate = /^[a-z][a-z\d+.-]*:\/\//i.test(text) ? text : 'https://' + text;
  let u = null;
  try { u = new URL(candidate); } catch { u = null; }
  return !!u && ['http:', 'https:'].includes(u.protocol) && u.hostname.includes('.') && !/\s/.test(text);
}

// The problems with the values, by field. An empty object means the form can be sent.
export function clientErrors(v) {
  const e = {};
  const name = trim(v.name);
  if (!name) e.name = v.type === 'person' ? 'Enter the contact name.' : 'Enter the company name.';
  else if (name.length > CLIENT_LIMITS.name) e.name = 'Use 255 characters or fewer.';
  else if (CONTROL.test(name)) e.name = 'Remove the characters that cannot be shown.';
  const email = trim(v.email);
  if (email && (!EMAIL.test(email) || email.length > CLIENT_LIMITS.email)) e.email = 'Enter an email address like name@example.com, or leave it empty.';
  for (const k of ['phone', 'mobile']) {
    const x = trim(v[k]);
    if (x && !/\d/.test(x)) e[k] = 'Enter the number with its digits, or leave it empty.';
  }
  const web = trim(v.website);
  if (web && (!validWebsite(web) || web.length > CLIENT_LIMITS.website)) e.website = 'Enter a web address like example.com.';
  if (trim(v.stateId) && !trim(v.countryId)) e.stateId = 'Choose the country first.';
  if (trim(v.parentId) && v.type !== 'person') e.parentId = 'Only an individual has a parent company. Choose Individual, or clear the parent company.';
  for (const k of CLIENT_TEXT) {
    const x = trim(v[k]);
    if (k !== 'name' && k !== 'email' && k !== 'phone' && k !== 'mobile' && k !== 'website' && x.length > CLIENT_LIMITS[k]) e[k] = 'Use ' + CLIENT_LIMITS[k] + ' characters or fewer.';
    if (x && CONTROL.test(x.replace(/\n/g, '')) && k !== 'notes') e[k] = 'Remove the characters that cannot be shown.';
  }
  return e;
}

// The request body: the type, the text and ids that are filled in, and tags as a list of ids. supported is Odoo's answer
// per field (from /clients/odoo/options); a field it does not allow is not sent.
export function clientBody(v, supported = {}) {
  const on = k => supported[k] !== false;
  const body = { type: v.type === 'person' ? 'person' : 'company' };
  for (const k of CLIENT_TEXT) {
    if (!on(k)) continue;
    const x = trim(v[k]);
    if (x) body[k] = x;
  }
  for (const k of CLIENT_IDS) {
    if (!on(k)) continue;
    const x = trim(v[k]);
    if (x) body[k] = Number(x);
  }
  if (body.type === 'company') delete body.parentId;
  const tags = [...new Set((v.tagIds || []).map(Number).filter(Number.isSafeInteger))];
  if (on('tagIds') && tags.length) body.tagIds = tags;
  return body;
}
