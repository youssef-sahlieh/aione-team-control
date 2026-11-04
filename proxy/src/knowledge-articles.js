// Odoo Knowledge articles, read and written through the same Odoo API as the rest of the app (proxy/src/odoo.js).
// Odoo is the only copy: the tree, the articles (HTML, as Odoo's editor saves them) and their pictures are read from
// Odoo every time, and every change is written straight back. The proxy stores nothing about them.
import { BusinessError } from './ticket-metadata.js';
import { odoo } from './odoo.js';

const TREE_FIELDS = ['name', 'parent_id', 'sequence', 'icon', 'category', 'is_article_item', 'write_date'];
const MAX_NAME = 200;
const MAX_TEXT = 20000;
const MAX_BODY = 1500000;
const MAX_PICTURE = 3 * 1024 * 1024;
// Pictures sent with an article, in total; the rest are fetched separately (a reply has to stay under ~4 MB).
const INLINE_BUDGET = 2.5 * 1024 * 1024;
// Pictures pasted into an article in Odoo are attachments of the article (or of its cover).
const PICTURE_MODELS = new Set(['knowledge.article', 'knowledge.cover']);

// Odoo's own message is passed on (it says what went wrong, and holds no secrets). Anything that stops the call
// before Odoo answers is logged for administrators.
async function call(env, method, args, kwargs = {}, model = 'knowledge.article') {
  try {
    return await odoo(env, model, method, args, kwargs);
  } catch (e) {
    if (e instanceof BusinessError) throw e;
    console.warn('knowledge_odoo_failed', model, method, String(e && e.message).slice(0, 200));
    throw new BusinessError(String((e && e.message) || 'Odoo did not answer. Try again.'), 502, e && e.definite ? 'odoo_error' : 'odoo_unavailable');
  }
}

const escapeHtml = text => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
// Plain text (older clients) to an Odoo article body: line breaks are kept.
export const toHtml = text => '<p>' + escapeHtml(text).split('\n').join('<br>') + '</p>';
export const toText = html => String(html || '')
  .replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|h[1-6]|li|pre|tr|blockquote)>\s*/gi, '\n').replace(/<[^>]+>/g, '')
  .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
  .replace(/\n{3,}/g, '\n\n').trim();

const many2one = v => (Array.isArray(v) ? v[0] : v) || null;
const validId = (id, what = 'article') => { if (!Number.isInteger(id) || id < 1) throw new BusinessError(`Unknown ${what}.`, 400, 'invalid_id'); return id; };

// The fields this Odoo has (Knowledge differs a little between versions), asked once per server start.
let fieldsKnown = null;
async function treeFields(env) {
  if (!fieldsKnown) {
    fieldsKnown = call(env, 'fields_get', [], { attributes: ['type'] })
      .then(all => TREE_FIELDS.filter(f => f in all))
      .catch(e => { fieldsKnown = null; throw e; });
  }
  return fieldsKnown;
}
export const resetFieldCache = () => { fieldsKnown = null; };

// Every article as the Odoo sidebar groups it: section (workspace, shared, private), parent and order. Article items
// (rows of an article's embedded list) are left out, as Odoo's sidebar does.
export async function listArticles(env) {
  const fields = await treeFields(env);
  const rows = await call(env, 'search_read', [[]], { fields, order: 'sequence asc, id asc', limit: 3000 });
  return (Array.isArray(rows) ? rows : []).filter(r => !r.is_article_item).map(r => ({
    id: r.id, name: r.name || '', parentId: many2one(r.parent_id), sequence: r.sequence || 0, icon: r.icon || '',
    category: r.category || 'workspace', updatedAt: r.write_date || ''
  }));
}

// Articles whose title or text has the words (Odoo searches; up to 60).
export async function searchArticles(env, query) {
  const q = String(query || '').trim().slice(0, 100);
  if (q.length < 2) return [];
  const rows = await call(env, 'search_read', [['|', ['name', 'ilike', q], ['body', 'ilike', q]]], { fields: ['name'], limit: 60 });
  return (Array.isArray(rows) ? rows : []).map(r => r.id);
}

// The attachment ids of the pictures in an article body (/web/image/123..., /web/content/123...).
export function pictureIds(body) {
  const ids = new Set();
  for (const m of String(body || '').matchAll(/<img\b[^>]*?\ssrc\s*=\s*["']([^"']+)["']/gi)) {
    const id = (/\/web\/(?:image|content)\/(\d{1,12})(?:[-/?#]|$)/.exec(m[1]) || [])[1];
    if (id) ids.add(Number(id));
  }
  return [...ids].slice(0, 200);
}

// Pictures by attachment id, as data: addresses. Only pictures attached to Knowledge articles are given out, so a body
// can't be used to read other Odoo files. Pictures past the budget come back in "later" to fetch on their own.
export async function readPictures(env, ids, budget = INLINE_BUDGET) {
  const wanted = [...new Set(ids.map(Number))].filter(n => Number.isInteger(n) && n > 0).slice(0, 200);
  if (!wanted.length) return { pictures: {}, later: [] };
  const meta = await call(env, 'read', [wanted, ['res_model', 'mimetype', 'file_size']], {}, 'ir.attachment').catch(() => []);
  const ok = (Array.isArray(meta) ? meta : []).filter(a => PICTURE_MODELS.has(a.res_model) && /^image\/(png|jpe?g|gif|webp|bmp|svg\+xml)$/.test(a.mimetype || '') && a.mimetype !== 'image/svg+xml');
  const pictures = {}, later = [];
  let used = 0;
  for (const a of ok) {
    const size = Number(a.file_size) || 0;
    if (Object.keys(pictures).length && used + size > budget) { later.push(a.id); continue; }
    const [row] = await call(env, 'read', [[a.id], ['datas']], {}, 'ir.attachment').catch(() => []);
    if (row && row.datas) { pictures[a.id] = 'data:' + a.mimetype + ';base64,' + row.datas; used += size; }
  }
  return { pictures, later };
}

export async function readArticle(env, id) {
  validId(id);
  const fields = (await treeFields(env)).filter(f => f !== 'is_article_item');
  const [row] = await call(env, 'read', [[id], [...fields, 'body']]);
  if (!row) throw new BusinessError('This article is no longer in Odoo.', 404, 'not_found');
  const { pictures, later } = await readPictures(env, pictureIds(row.body));
  return {
    article: { id: row.id, name: row.name || '', parentId: many2one(row.parent_id), icon: row.icon || '', category: row.category || 'workspace', body: row.body || '', updatedAt: row.write_date || '' },
    pictures, later
  };
}

// Saves an article. body is Odoo HTML (Odoo cleans it again when it's written); text is plain text from older pages.
// updatedAt is when the article was read: if someone changed it in Odoo since, nothing is written.
export async function saveArticle(env, { id, name, text, body, icon, parentId, updatedAt }) {
  if (typeof name !== 'string' || !name.trim() || name.length > MAX_NAME) throw new BusinessError(`Give the article a name of up to ${MAX_NAME} characters.`, 400, 'invalid_name');
  let html;
  if (typeof body === 'string') {
    if (body.length > MAX_BODY) throw new BusinessError('The article is too long to save from here. Shorten it, or edit it in Odoo.', 400, 'invalid_text');
    html = body;
  } else {
    if (typeof text !== 'string' || text.length > MAX_TEXT) throw new BusinessError(`The text can be up to ${MAX_TEXT} characters.`, 400, 'invalid_text');
    html = toHtml(text);
  }
  const vals = { name: name.trim(), body: html };
  if (typeof icon === 'string' && icon.length <= 16) vals.icon = icon.trim() || false;
  if (id) {
    validId(id);
    if (updatedAt) {
      const [now] = await call(env, 'read', [[id], ['write_date']]);
      if (!now) throw new BusinessError('This article is no longer in Odoo.', 404, 'not_found');
      if (now.write_date && now.write_date !== updatedAt) throw new BusinessError('Someone changed this article in Odoo after you opened it. Copy your changes, reopen the article and add them again.', 409, 'changed');
    }
    await call(env, 'write', [[id], vals]);
    const [after] = await call(env, 'read', [[id], ['write_date']]);
    return { id, updatedAt: after?.write_date || '' };
  }
  if (parentId) vals.parent_id = validId(parentId, 'parent article');
  // A top-level article goes to the Workspace (everyone can see and edit it), as "+" next to Workspace does in Odoo.
  else vals.internal_permission = 'write';
  const created = await call(env, 'create', [[vals]]);
  const newId = Array.isArray(created) ? created[0] : created;
  return { id: typeof newId === 'number' ? newId : (newId?.id ?? null) };
}

// A picture added in the editor: attached to the article in Odoo, as Odoo's editor does, with an access token so
// Odoo shows it to everyone who can read the article. Returns the address to put in the article and the picture.
export async function addPicture(env, { articleId, name, type, data }) {
  validId(articleId);
  if (!/^image\/(png|jpeg|gif|webp)$/.test(String(type || ''))) throw new BusinessError('Add a PNG, JPEG, GIF or WebP picture.', 400, 'invalid_type');
  if (typeof data !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) throw new BusinessError('The picture could not be read.', 400, 'invalid_picture');
  if (data.length * 0.75 > MAX_PICTURE) throw new BusinessError('Pictures can be up to 3 MB.', 413, 'too_large');
  const fileName = String(name || 'picture').replace(/[\\/\r\n"<>:|?*\x00-\x1f]/g, '_').trim().slice(0, 120) || 'picture';
  const created = await call(env, 'create', [{ name: fileName, datas: data, mimetype: type, res_model: 'knowledge.article', res_id: articleId }], {}, 'ir.attachment');
  const attachmentId = Array.isArray(created) ? created[0] : created;
  const token = await call(env, 'generate_access_token', [[attachmentId]], {}, 'ir.attachment').then(t => (Array.isArray(t) ? t[0] : t)).catch(() => '');
  const src = '/web/image/' + attachmentId + (token && /^[\w-]+$/.test(token) ? '?access_token=' + token : '');
  return { id: attachmentId, src, picture: 'data:' + type + ';base64,' + data };
}

// Moves an article under another one, or to the top of the Workspace (parentId null), as Odoo's "Move To" does.
export async function moveArticle(env, { id, parentId }) {
  validId(id);
  if (parentId) {
    validId(parentId, 'parent article');
    if (parentId === id) throw new BusinessError("An article can't go under itself.", 400, 'invalid_parent');
  }
  await call(env, 'move_to', [[id]], { parent_id: parentId || false, is_private: false });
  return { id };
}

// Sends an article (and the articles under it) to Odoo's trash. It can be restored from the trash in Odoo.
export async function trashArticle(env, { id }) {
  validId(id);
  await call(env, 'action_send_to_trash', [[id]]);
  return { id };
}
