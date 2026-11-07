// Odoo knowledge base for every signed-in team member. Articles are read and written through the shared Odoo API;
// there is no extra password.
import { BusinessError } from './ticket-metadata.js';
import { odooConfigured } from './odoo.js';
import { listArticles, saveArticle, readArticle, searchArticles, readPictures, addPicture, moveArticle, trashArticle } from './knowledge-articles.js';

export const knowledgeLink = env => String(env.ODOO_URL).replace(/\/+$/, '') + '/odoo/knowledge';

function requireOdoo(env) {
  if (!odooConfigured(env)) throw new BusinessError('Odoo is not connected.', 503, 'odoo_unavailable');
}

export async function openKnowledge(env) {
  requireOdoo(env);
  return { url: knowledgeLink(env), articles: await listArticles(env) };
}

export async function saveKnowledgeEntry(env, body) {
  requireOdoo(env);
  const saved = await saveArticle(env, {
    id: body.id ? Number(body.id) : null, name: body.name, text: body.text, body: body.body, icon: body.icon,
    parentId: body.parentId ? Number(body.parentId) : null, updatedAt: typeof body.updatedAt === 'string' ? body.updatedAt : ''
  });
  return { ...saved, articles: await listArticles(env) };
}

// One article with its pictures, a search, more pictures, a new picture, a move, or the trash.
const ACTIONS = {
  article: (env, b) => readArticle(env, Number(b.id)),
  search: async (env, b) => ({ ids: await searchArticles(env, b.query) }),
  pictures: (env, b) => readPictures(env, Array.isArray(b.ids) ? b.ids.slice(0, 20) : []),
  picture: (env, b) => addPicture(env, { articleId: Number(b.articleId), name: b.name, type: b.type, data: b.data }),
  move: async (env, b) => ({ ...(await moveArticle(env, { id: Number(b.id), parentId: b.parentId ? Number(b.parentId) : null })), articles: await listArticles(env) }),
  trash: async (env, b) => ({ ...(await trashArticle(env, { id: Number(b.id) })), articles: await listArticles(env) })
};

const noStore = { 'Cache-Control': 'no-store' };
export async function knowledgeRoutes(request, env, me, path) {
  // "/knowledge/unlock" is the old name, kept for pages still open from before the password was removed.
  if ((path === '/knowledge/open' || path === '/knowledge/unlock') && request.method === 'POST') return Response.json(await openKnowledge(env), { headers: noStore });
  if (path === '/knowledge/save' && request.method === 'POST') {
    const body = await request.json().catch(() => ({}));
    return Response.json(await saveKnowledgeEntry(env, body), { headers: noStore });
  }
  const action = /^\/knowledge\/(article|search|pictures|picture|move|trash)$/.exec(path);
  if (action && request.method === 'POST') {
    requireOdoo(env);
    const body = await request.json().catch(() => ({}));
    return Response.json(await ACTIONS[action[1]](env, body), { headers: noStore });
  }
  throw new BusinessError('Not found.', 404, 'not_found');
}
