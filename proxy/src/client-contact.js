// Contacts (Odoo res.partner) added from the Clients & Projects page. The browser's values are checked here before anything
// reaches Odoo: only the fields in CONTACT_FIELDS can be sent, each is checked for the type Odoo expects, and Odoo's own
// field metadata decides which fields this Odoo has and whether they can be written. A field it does not have is refused,
// never guessed at. After the create, the record is read back and compared with what was sent.
import { odoo, odooUid, OdooError } from './odoo.js';
import { BusinessError, mainCompanyId } from './ticket-metadata.js';

const fail = (key, message) => { throw new BusinessError(CONTACT_FIELDS[key].label + ': ' + message, 400, 'invalid_field', { field: key }); };
const problem = (message, status = 400, code = 'client_contact', details = {}) => { throw new BusinessError(message, status, code, details); };

// The fields the form may set: the key the browser sends, its Odoo field, its label and a length limit.
export const CONTACT_FIELDS = {
  type: { label: 'Individual / Company', odoo: 'company_type' },
  name: { label: 'Company or contact name', odoo: 'name', max: 255 },
  parentId: { label: 'Parent company', odoo: 'parent_id' },
  email: { label: 'Email', odoo: 'email', max: 254 },
  phone: { label: 'Phone', odoo: 'phone', max: 40 },
  mobile: { label: 'Mobile', odoo: 'mobile', max: 40 },
  website: { label: 'Website', odoo: 'website', max: 255 },
  street: { label: 'Street', odoo: 'street', max: 255 },
  street2: { label: 'Street 2', odoo: 'street2', max: 255 },
  city: { label: 'City', odoo: 'city', max: 128 },
  countryId: { label: 'Country', odoo: 'country_id' },
  stateId: { label: 'State / region', odoo: 'state_id' },
  zip: { label: 'Postal code', odoo: 'zip', max: 24 },
  vat: { label: 'Tax ID / VAT', odoo: 'vat', max: 64 },
  companyRegistry: { label: 'Company registration number', odoo: 'company_registry', max: 64 },
  reference: { label: 'Internal reference', odoo: 'ref', max: 64 },
  language: { label: 'Language', odoo: 'lang', max: 20 },
  tagIds: { label: 'Tags', odoo: 'category_id' },
  notes: { label: 'Internal notes', odoo: 'comment', max: 5000 },
};
export const CONTACT_KEYS = Object.keys(CONTACT_FIELDS);
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const CONTROL = /[\x00-\x1f\x7f]/, NOTE_CONTROL = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/;
const MAX_TAGS = 50;

// Odoo's field metadata for res.partner: which of the form's fields exist, can be written and are required here.
async function fieldSupport(env) {
  const names = [...new Set([...Object.values(CONTACT_FIELDS).map(f => f.odoo), 'is_company', 'customer_rank'])];
  const meta = await odoo(env, 'res.partner', 'fields_get', [names], { attributes: ['type', 'readonly', 'required'] });
  const writable = n => !!meta[n] && !meta[n].readonly;
  const typeField = writable('company_type') ? 'company_type' : writable('is_company') ? 'is_company' : null;
  const supported = {}, required = {};
  for (const key of CONTACT_KEYS) {
    const f = CONTACT_FIELDS[key];
    supported[key] = key === 'type' ? !!typeField : writable(f.odoo);
    required[key] = !!(meta[f.odoo] && meta[f.odoo].required);
  }
  return { meta, supported, required, typeField, customerRank: writable('customer_rank') };
}

// The choices the form offers, all read from Odoo: countries, the states of one country, active languages, existing tags,
// and the fields this Odoo supports (the browser hides the others and says so).
export async function clientFormOptions(env, { country } = {}) {
  const { supported, required } = await fieldSupport(env);
  const c = Number(country), wantStates = Number.isSafeInteger(c) && c > 0;
  const [countries, languages, tags, states] = await Promise.all([
    odoo(env, 'res.country', 'search_read', [[]], { fields: ['name', 'code'], order: 'name', limit: 1000 }),
    odoo(env, 'res.lang', 'search_read', [[['active', '=', true]]], { fields: ['code', 'name'], order: 'name', limit: 500 }),
    supported.tagIds ? odoo(env, 'res.partner.category', 'search_read', [[]], { fields: ['name'], order: 'name', limit: 2000 }) : [],
    wantStates ? odoo(env, 'res.country.state', 'search_read', [[['country_id', '=', c]]], { fields: ['name', 'code'], order: 'name', limit: 3000 }) : []
  ]);
  return {
    supported, required,
    countries: countries.map(r => ({ id: r.id, name: r.name, code: r.code || '' })),
    languages: languages.map(r => ({ code: r.code, name: r.name })),
    tags: tags.map(r => ({ id: r.id, name: r.name })),
    ...(wantStates ? { country: c, states: states.map(r => ({ id: r.id, name: r.name, code: r.code || '' })) } : {})
  };
}

// Companies a person can be placed under: the main company's companies (the ones the Clients page lists), searched by name.
export async function parentCompanyChoices(env, q) {
  const main = await mainCompanyId(env), term = String(q || '').trim().slice(0, 100);
  const domain = [['is_company', '=', true], '|', ['company_id', '=', main], ['company_id', '=', false], ...(term ? [['name', 'ilike', term]] : [])];
  const rows = await odoo(env, 'res.partner', 'search_read', [domain], { fields: ['name'], order: 'name', limit: 30 });
  return rows.map(r => ({ id: r.id, name: r.name }));
}

// Checks the body without contacting Odoo. Unknown keys are refused, so nothing the browser sends reaches Odoo unchecked.
export function readContactInput(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) problem('Invalid request.', 400, 'invalid_request');
  const unknown = Object.keys(body).filter(k => !CONTACT_KEYS.includes(k));
  if (unknown.length) problem('Unknown field: ' + unknown.join(', ') + '. Remove it and try again.', 400, 'unknown_field', { fields: unknown });
  const text = (key, { multi = false } = {}) => {
    const v = body[key];
    if (v == null || v === '') return '';
    if (typeof v !== 'string') fail(key, 'enter text.');
    const t = v.trim(), max = CONTACT_FIELDS[key].max;
    if (t.length > max) fail(key, 'use ' + max + ' characters or fewer.');
    if (multi ? NOTE_CONTROL.test(t) : CONTROL.test(t)) fail(key, 'remove the characters that cannot be shown.');
    return t;
  };
  const id = (key, v) => {
    if (v == null || v === '') return null;
    const n = typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : v;
    if (!Number.isSafeInteger(n) || n <= 0) fail(key, 'choose a value from the list.');
    return n;
  };
  const type = body.type == null || body.type === '' ? 'company' : body.type;
  if (type !== 'company' && type !== 'person') fail('type', 'choose Company or Individual.');
  const name = text('name');
  if (!name) fail('name', 'enter the company or contact name.');
  const email = text('email');
  if (email && (!EMAIL.test(email) || email.length > CONTACT_FIELDS.email.max)) fail('email', 'enter an email address like name@example.com, or leave it empty.');
  const phone = text('phone'), mobile = text('mobile');
  for (const [key, v] of [['phone', phone], ['mobile', mobile]]) if (v && !/\d/.test(v)) fail(key, 'enter the number with its digits, or leave it empty.');
  const website = text('website');
  let websiteUrl = '';
  if (website) {
    const candidate = /^[a-z][a-z\d+.-]*:\/\//i.test(website) ? website : 'https://' + website;
    let u = null;
    try { u = new URL(candidate); } catch { u = null; }
    if (!u || !['http:', 'https:'].includes(u.protocol) || !u.hostname.includes('.') || /\s/.test(website)) fail('website', 'enter a web address like example.com.');
    if (candidate.length > CONTACT_FIELDS.website.max) fail('website', 'use ' + CONTACT_FIELDS.website.max + ' characters or fewer.');
    websiteUrl = candidate;
  }
  const parentId = id('parentId', body.parentId);
  if (type === 'company' && parentId) fail('parentId', 'only an individual has a parent company. Choose Individual, or clear the parent company.');
  const countryId = id('countryId', body.countryId), stateId = id('stateId', body.stateId);
  if (stateId && !countryId) fail('stateId', 'choose the country first.');
  const language = text('language');
  if (language && !/^[A-Za-z]{2,3}([_@][A-Za-z0-9]{2,8})?$/.test(language)) fail('language', 'choose a language from the list.');
  let tagIds = [];
  if (body.tagIds != null && body.tagIds !== '') {
    if (!Array.isArray(body.tagIds) || body.tagIds.length > MAX_TAGS) fail('tagIds', 'choose up to ' + MAX_TAGS + ' existing tags.');
    tagIds = [...new Set(body.tagIds.map(v => id('tagIds', v)))];
    if (tagIds.some(v => !v)) fail('tagIds', 'choose tags from the list.');
  }
  return {
    type, name, parentId, email, phone, mobile, website: websiteUrl, street: text('street'), street2: text('street2'), city: text('city'),
    countryId, stateId, zip: text('zip'), vat: text('vat'), companyRegistry: text('companyRegistry'), reference: text('reference'),
    language, tagIds, notes: text('notes', { multi: true })
  };
}

const escapeHtml = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
// Odoo's notes field is HTML (paragraphs); plain text is kept as paragraphs so line breaks survive.
const notesHtml = (text, type) => type === 'text' ? text : text.split(/\r?\n/).map(l => '<p>' + (l.trim() ? escapeHtml(l.trim()) : '<br>') + '</p>').join('');
const notesPlain = html => String(html || '').replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>/gi, '\n').replace(/<[^>]+>/g, '')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&')
  .split(/\r?\n/).map(s => s.trim()).filter(Boolean).join('\n');
const websiteKey = w => String(w || '').trim().replace(/\/+$/, '');

// Odoo refers to each reference by its id; each is confirmed to exist, a state must be in the chosen country, and tags must exist
// (they are never created here).
async function checkReferences(env, input) {
  if (input.countryId) {
    const [c] = await odoo(env, 'res.country', 'search_read', [[['id', '=', input.countryId]]], { fields: ['id'], limit: 1 });
    if (!c) fail('countryId', 'this country is not in Odoo. Choose it again.');
  }
  if (input.stateId) {
    const [s] = await odoo(env, 'res.country.state', 'search_read', [[['id', '=', input.stateId]]], { fields: ['country_id'], limit: 1 });
    if (!s) fail('stateId', 'this state is not in Odoo. Choose it again.');
    if (!Array.isArray(s.country_id) || s.country_id[0] !== input.countryId) fail('stateId', 'this state is not in the chosen country. Choose the state again.');
  }
  if (input.language) {
    const [l] = await odoo(env, 'res.lang', 'search_read', [[['active', '=', true], ['code', '=', input.language]]], { fields: ['code'], limit: 1 });
    if (!l) fail('language', 'this language is not active in Odoo. Choose another.');
  }
  if (input.tagIds.length) {
    const tags = await odoo(env, 'res.partner.category', 'search_read', [[['id', 'in', input.tagIds]]], { fields: ['id'], limit: input.tagIds.length + 1 });
    if (tags.length !== input.tagIds.length) fail('tagIds', 'some of these tags are not in Odoo. Choose them again.');
  }
  if (input.parentId) {
    const main = await mainCompanyId(env);
    const [p] = await odoo(env, 'res.partner', 'search_read', [[['id', '=', input.parentId], ['is_company', '=', true], '|', ['company_id', '=', main], ['company_id', '=', false]]], { fields: ['name'], limit: 1 });
    if (!p) fail('parentId', 'choose a company from Odoo.');
  }
}

// Fields Odoo would refuse if left empty, and fields this Odoo does not allow here, are checked before the create.
function checkSupport(input, { supported, required }) {
  for (const key of CONTACT_KEYS) {
    const sent = key === 'type' ? true : input[key] !== '' && input[key] != null && !(Array.isArray(input[key]) && !input[key].length);
    if (sent && !supported[key]) fail(key, 'this Odoo does not allow setting it from here. Remove it and try again.');
    if (!sent && required[key] && key !== 'type') fail(key, 'Odoo requires this field. Enter it, or ask an Odoo administrator to make it optional.');
  }
}

// The values Odoo gets: only the non-empty fields, plus the individual/company type in the form this Odoo uses.
function odooValues(input, { typeField, customerRank, meta }) {
  const v = { name: input.name };
  if (typeField === 'company_type') v.company_type = input.type; else v.is_company = input.type === 'company';
  if (customerRank) v.customer_rank = 1;
  if (input.parentId) v.parent_id = input.parentId;
  for (const key of ['email', 'phone', 'mobile', 'website', 'street', 'street2', 'city', 'zip', 'vat', 'companyRegistry', 'reference']) {
    if (input[key]) v[CONTACT_FIELDS[key].odoo] = input[key];
  }
  if (input.countryId) v.country_id = input.countryId;
  if (input.stateId) v.state_id = input.stateId;
  if (input.language) v.lang = input.language;
  if (input.tagIds.length) v.category_id = [[6, 0, input.tagIds]];
  if (input.notes) v.comment = notesHtml(input.notes, meta.comment?.type);
  return v;
}

const m2oId = v => (Array.isArray(v) ? v[0] : null);
const m2oName = v => (Array.isArray(v) ? String(v[1] || '') : '');
const PARTNER_READ = ['name', 'company_type', 'is_company', 'parent_id', 'email', 'phone', 'mobile', 'website', 'street', 'street2', 'city', 'zip', 'country_id', 'state_id', 'vat', 'company_registry', 'ref', 'lang', 'category_id', 'comment'];

// Reads the saved record and compares it with what was sent. Returns the summary the browser shows and the fields that differ.
async function readBack(env, id, input, meta) {
  const fields = PARTNER_READ.filter(f => meta[f]);
  const [rec] = await odoo(env, 'res.partner', 'read', [[id]], { fields });
  if (!rec) return { saved: [], mismatches: [], parentName: '' };
  const type = rec.company_type || (rec.is_company ? 'company' : 'person');
  const tagNames = Array.isArray(rec.category_id) && rec.category_id.length
    ? await odoo(env, 'res.partner.category', 'read', [rec.category_id], { fields: ['name'] }).then(rows => rows.map(r => r.name)).catch(() => [])
    : [];
  const saved = {
    type, name: rec.name || '', parentId: m2oId(rec.parent_id), email: rec.email || '', phone: rec.phone || '', mobile: rec.mobile || '',
    website: rec.website || '', street: rec.street || '', street2: rec.street2 || '', city: rec.city || '', countryId: m2oId(rec.country_id),
    stateId: m2oId(rec.state_id), zip: rec.zip || '', vat: rec.vat || '', companyRegistry: rec.company_registry || '', reference: rec.ref || '',
    language: rec.lang || '', tagIds: Array.isArray(rec.category_id) ? [...rec.category_id].sort((a, b) => a - b) : [], notes: notesPlain(rec.comment)
  };
  const expected = { type: input.type, name: input.name, parentId: input.parentId, email: input.email, phone: input.phone, mobile: input.mobile,
    website: input.website, street: input.street, street2: input.street2, city: input.city, countryId: input.countryId, stateId: input.stateId,
    zip: input.zip, vat: input.vat, companyRegistry: input.companyRegistry, reference: input.reference, language: input.language,
    tagIds: [...input.tagIds].sort((a, b) => a - b), notes: input.notes };
  const lines = s => String(s || '').split(/\r?\n/).map(x => x.trim()).filter(Boolean).join('\n');
  const same = (key, a, b) => key === 'website' ? websiteKey(a) === websiteKey(b) : key === 'notes' ? lines(a) === lines(b) : (a ?? '') === (b ?? '') || JSON.stringify(a) === JSON.stringify(b);
  const mismatches = [];
  for (const key of CONTACT_KEYS) {
    const sent = key === 'type' || (Array.isArray(expected[key]) ? expected[key].length : expected[key] !== '' && expected[key] != null);
    if (sent && !same(key, saved[key], expected[key])) mismatches.push({ field: key, label: CONTACT_FIELDS[key].label });
  }
  const summary = [];
  const add = (label, value) => { if (value !== '' && value != null && !(Array.isArray(value) && !value.length)) summary.push({ label, value: Array.isArray(value) ? value.join(', ') : String(value) }); };
  add('Type', type === 'company' ? 'Company' : 'Individual');
  add('Name', saved.name);
  add('Parent company', m2oName(rec.parent_id));
  add('Email', saved.email); add('Phone', saved.phone); add('Mobile', saved.mobile); add('Website', saved.website);
  add('Address', [saved.street, saved.street2, [saved.zip, saved.city].filter(Boolean).join(' '), m2oName(rec.country_id), m2oName(rec.state_id)].filter(Boolean).join(', '));
  add('Tax ID / VAT', saved.vat); add('Company registration number', saved.companyRegistry); add('Internal reference', saved.reference);
  add('Language', saved.language); add('Tags', tagNames); add('Internal notes', saved.notes);
  return { saved: summary, mismatches, parentName: m2oName(rec.parent_id) };
}

// A contact saved by this integration in the last few minutes, with the same name, type and parent: found after an answer
// was lost, so the create is not repeated.
async function ownRecent(env, input, uid, since) {
  const rows = await odoo(env, 'res.partner', 'search_read', [[['name', '=', input.name], ['is_company', '=', input.type === 'company'], ['parent_id', '=', input.parentId || false], ['create_uid', '=', uid], ['create_date', '>=', since]]], { fields: ['id'], limit: 1 });
  return rows[0] ? rows[0].id : null;
}

// Creates one contact in Odoo. An Odoo refusal is reported with its reason and nothing is saved. When Odoo's answer is lost, the
// contact may have been saved: a later try first looks for it and returns it instead of creating a second one.
export async function createClientContact(env, body) {
  const input = readContactInput(body);
  const base = String(env.ODOO_URL || '').replace(/\/+$/, '');
  let support, uid;
  try {
    support = await fieldSupport(env);
    checkSupport(input, support);
    await checkReferences(env, input);
    uid = await odooUid(env);
  } catch (e) {
    if (e instanceof BusinessError) throw e;
    problem("Couldn't check the details with Odoo: " + String(e.message || 'unknown error').slice(0, 200), 502, 'odoo');
  }
  // One save of the same contact at a time: a request sent while another runs is refused, so two never create it twice.
  const store = env.STORE, lockKey = 'clients:contact:' + input.type + ':' + nameKey(input.name), owner = crypto.randomUUID();
  if (store?.setIfAbsent && !await store.setIfAbsent(lockKey, owner, 120)) problem('“' + input.name + '” is already being saved. Wait a moment, then check Odoo before adding it again.', 409, 'busy');
  try {
    return await saveContact(env, input, { support, uid, base });
  } finally {
    if (store?.deleteIfValue) await store.deleteIfValue(lockKey, owner).catch(() => {});
  }
}
const nameKey = n => n.trim().normalize('NFC').toLocaleLowerCase('en-US');
async function saveContact(env, input, { support, uid, base }) {
  const since = new Date(Date.now() - 15 * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19);
  let id = null, reconciled = false, own = null;
  try {
    const same = await odoo(env, 'res.partner', 'search_read', [[['name', '=', input.name], ['is_company', '=', input.type === 'company'], ['parent_id', '=', input.parentId || false]]], { fields: ['id', 'create_uid', 'create_date'], limit: 5 });
    own = same.find(r => Array.isArray(r.create_uid) && r.create_uid[0] === uid && String(r.create_date || '') >= since);
    if (own) { id = own.id; reconciled = true; }
    else if (same.length) problem('A contact named “' + input.name + '” is already in Odoo.', 409, 'exists');
  } catch (e) {
    if (e instanceof BusinessError) throw e;
    problem("Couldn't check Odoo for this contact: " + String(e.message || 'unknown error').slice(0, 200), 502, 'odoo');
  }
  if (!id) {
    try {
      const made = await odoo(env, 'res.partner', 'create', [odooValues(input, { ...support, meta: support.meta })]);
      id = [made].flat()[0];
    } catch (e) {
      if (e instanceof OdooError && e.definite) {
        if (/AccessError/.test(e.kind)) problem("Odoo's permissions for the proxy's user don't allow creating contacts. Ask an Odoo administrator to check its access rights.", 403, 'odoo_forbidden');
        const message = String(e.message || 'Odoo refused the contact.').slice(0, 300);
        const field = Object.entries(HINTS).find(([hint]) => message.includes(hint))?.[1] || null;
        problem('Odoo refused the contact: ' + message, 400, 'odoo_rejected', field ? { field } : {});
      }
      if (!(e instanceof OdooError)) problem("Odoo didn't create it: " + String(e.message || 'unknown error').slice(0, 200), 502, 'odoo');
      // The answer was lost: the contact may be in Odoo already.
      own = await ownRecent(env, input, uid, since).catch(() => null);
      if (!own) problem('Odoo didn’t confirm the contact “' + input.name + '”, so it may or may not be saved. Save again: the proxy checks Odoo first and does not create it twice.', 502, 'uncertain');
      id = own; reconciled = true;
    }
  }
  const read = await readBack(env, id, input, support.meta);
  return { id, reconciled, url: base + '/web#id=' + id + '&model=res.partner&view_type=form', saved: read.saved, mismatches: read.mismatches,
    company: input.type === 'company' ? input.name : (read.parentName || null) };
}
// Words in Odoo's messages that point at a form field.
const HINTS = { 'VAT': 'vat', 'Tax ID': 'vat', 'Email': 'email', 'Website': 'website', 'Phone': 'phone', 'Mobile': 'mobile',
  'Postal': 'zip', 'ZIP': 'zip', 'Street': 'street', 'City': 'city', 'Country': 'countryId', 'State': 'stateId', 'Language': 'language',
  'Registration': 'companyRegistry', 'Reference': 'reference' };
