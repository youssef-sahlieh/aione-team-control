// Odoo Knowledge articles, read and written through the same Odoo API as the rest of the app (proxy/src/odoo.js).
// Credentials are kept as article text inside Odoo. The proxy stores nothing about them.
import { BusinessError } from './ticket-metadata.js';
import { odoo } from './odoo.js';

const ARTICLE_FIELDS = ['name', 'body', 'write_date'];
const MAX_NAME = 200;
const MAX_TEXT = 20000;

// Odoo's own message is passed on (it says what went wrong, and holds no secrets). Anything that stops the call
// before Odoo answers is logged for administrators.
async function call(env, method, args, kwargs = {}) {
  try {
    return await odoo(env, 'knowledge.article', method, args, kwargs);
  } catch (e) {
    if (e instanceof BusinessError) throw e;
    console.warn('knowledge_odoo_failed', method, String(e && e.message).slice(0, 200));
    throw new BusinessError(String((e && e.message) || 'Odoo did not answer. Try again.'), 502, e && e.definite ? 'odoo_error' : 'odoo_unavailable');
  }
}

const escapeHtml = text => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
// Articles are HTML in Odoo. The editor works with plain text, so line breaks are kept and tags are dropped.
export const toHtml = text => '<p>' + escapeHtml(text).split('\n').join('<br>') + '</p>';
export const toText = html => String(html || '')
  .replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>\s*<p[^>]*>/gi, '\n').replace(/<[^>]+>/g, '')
  .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
  .trim();

export async function listArticles(env) {
  const rows = await call(env, 'search_read', [[]], { fields: ARTICLE_FIELDS, order: 'write_date desc', limit: 500 });
  return (Array.isArray(rows) ? rows : []).map(r => ({ id: r.id, name: r.name || '', text: toText(r.body), updatedAt: r.write_date || '' }));
}

export async function saveArticle(env, { id, name, text }) {
  if (typeof name !== 'string' || !name.trim() || name.length > MAX_NAME) throw new BusinessError(`Give the entry a name of up to ${MAX_NAME} characters.`, 400, 'invalid_name');
  if (typeof text !== 'string' || text.length > MAX_TEXT) throw new BusinessError(`The text can be up to ${MAX_TEXT} characters.`, 400, 'invalid_text');
  const vals = { name: name.trim(), body: toHtml(text) };
  if (id) {
    if (!Number.isInteger(id) || id < 1) throw new BusinessError('Unknown entry.', 400, 'invalid_id');
    await call(env, 'write', [[id], vals]);
    return { id };
  }
  const created = await call(env, 'create', [[vals]]);
  const newId = Array.isArray(created) ? created[0] : created;
  return { id: typeof newId === 'number' ? newId : (newId?.id ?? null) };
}
