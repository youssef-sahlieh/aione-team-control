// Odoo Knowledge articles, read and written through Odoo's JSON-2 API (Odoo 19 and later):
// POST <ODOO_URL>/json/2/<model>/<method> with the API key as a bearer token and the database in X-Odoo-Database.
// Credentials are kept as article text inside Odoo. The proxy stores nothing about them.
import { BusinessError } from './ticket-metadata.js';

const ARTICLE_FIELDS = ['name', 'body', 'write_date'];
const MAX_NAME = 200;
const MAX_TEXT = 20000;

const base = env => String(env.ODOO_URL).replace(/\/+$/, '');

// Why a call to Odoo failed before any answer came back. Logged for administrators (never the key or the data).
function noAnswerReason(e) {
  if (e && (e.name === 'TimeoutError' || e.name === 'AbortError')) return 'timeout';
  if (/redirect/i.test(String(e && e.message))) return 'redirect';
  return String((e && e.cause && e.cause.code) || (e && e.code) || (e && e.name) || 'network');
}

async function call(env, method, kwargs) {
  let res;
  try {
    res = await fetch(`${base(env)}/json/2/knowledge.article/${method}`, {
      method: 'POST',
      headers: { Authorization: 'bearer ' + env.ODOO_API_KEY, 'X-Odoo-Database': env.ODOO_DB, 'Content-Type': 'application/json' },
      body: JSON.stringify(kwargs),
      redirect: 'error',
      signal: AbortSignal.timeout(25000),
    });
  } catch (e) {
    const reason = noAnswerReason(e);
    console.warn('knowledge_odoo_no_answer', method, reason);
    if (reason === 'timeout') throw new BusinessError('Odoo took too long to answer. Try again.', 502, 'odoo_unavailable');
    if (reason === 'redirect') throw new BusinessError('Odoo redirected the request. ODOO_URL must be the exact https address of Odoo.', 502, 'odoo_unavailable');
    throw new BusinessError('Could not reach Odoo. Check ODOO_URL and that Odoo is online.', 502, 'odoo_unavailable');
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new BusinessError(data?.message || data?.error?.message || `Odoo answered ${res.status}.`, 502, 'odoo_error');
  return data;
}

const escapeHtml = text => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
// Articles are HTML in Odoo. The editor works with plain text, so line breaks are kept and tags are dropped.
export const toHtml = text => '<p>' + escapeHtml(text).split('\n').join('<br>') + '</p>';
export const toText = html => String(html || '')
  .replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>\s*<p[^>]*>/gi, '\n').replace(/<[^>]+>/g, '')
  .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
  .trim();

export async function listArticles(env) {
  const rows = await call(env, 'search_read', { domain: [], fields: ARTICLE_FIELDS, order: 'write_date desc', limit: 500 });
  return (Array.isArray(rows) ? rows : []).map(r => ({ id: r.id, name: r.name || '', text: toText(r.body), updatedAt: r.write_date || '' }));
}

export async function saveArticle(env, { id, name, text }) {
  if (typeof name !== 'string' || !name.trim() || name.length > MAX_NAME) throw new BusinessError(`Give the entry a name of up to ${MAX_NAME} characters.`, 400, 'invalid_name');
  if (typeof text !== 'string' || text.length > MAX_TEXT) throw new BusinessError(`The text can be up to ${MAX_TEXT} characters.`, 400, 'invalid_text');
  const vals = { name: name.trim(), body: toHtml(text) };
  if (id) {
    if (!Number.isInteger(id) || id < 1) throw new BusinessError('Unknown entry.', 400, 'invalid_id');
    await call(env, 'write', { ids: [id], vals });
    return { id };
  }
  const created = await call(env, 'create', { vals_list: [vals] });
  const newId = Array.isArray(created) ? created[0] : created;
  return { id: typeof newId === 'number' ? newId : (newId?.id ?? null) };
}
