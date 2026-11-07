// Odoo knowledge base, behind an extra password that administrators set. The page works like Odoo's Knowledge app:
// the articles in a tree grouped as Odoo groups them (Workspace, Shared, Private), each article shown as Odoo shows it
// with its pictures, nested articles added under any article, and an editor that takes pictures. Odoo is the only
// copy: everything is read from Odoo and every change is saved straight back. The proxy checks the password on every
// call. The password and the articles live in memory for this page view only, never in browser storage.
import { api, getSession, signOut } from "./session.js";
import { fromOdooHtml, toOdooHtml } from "./models/knowledge-html.js";

const $ = (id) => document.getElementById(id);
const errText = (err) => (err && err.code === "network" ? "Can't reach the AIONE server. Try again." : (err && err.message) || "Something went wrong.");
const show = (id, on) => { $(id).hidden = !on; };
const note = (id, text, isErr) => { const n = $(id); n.textContent = text || ""; n.classList.toggle("err", !!isErr); };
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const SECTIONS = [["workspace", "Workspace"], ["shared", "Shared"], ["private", "Private"]];
const MAX_PICTURE = 2.5 * 1024 * 1024;

let password = "";
let odooLink = "";          // https://…/odoo/knowledge
let articles = [];          // the tree: { id, name, parentId, sequence, icon, category, updatedAt }
let byId = new Map();
let kids = new Map();       // parent id (or "root:<section>") -> children, in Odoo's order
const expanded = new Set();
let found = null;           // ids Odoo found for the search (null: not searching inside articles)
let current = null;         // { article, pictures }
let dirty = false;

const call = (path, body = {}) => api(path, { method: "POST", body: { ...body, password } });
const odooOrigin = () => { try { return new URL(odooLink).origin; } catch { return ""; } };
const sectionOf = (a) => (SECTIONS.some(([k]) => k === a.category) ? a.category : "workspace");
const ancestors = (id) => { const out = []; let a = byId.get(id); const seen = new Set(); while (a && a.parentId && !seen.has(a.parentId)) { seen.add(a.parentId); a = byId.get(a.parentId); if (a) out.unshift(a); } return out; };

function setArticles(list) {
  articles = Array.isArray(list) ? list : [];
  byId = new Map(articles.map((a) => [a.id, a]));
  kids = new Map();
  for (const a of articles) {
    const key = a.parentId && byId.has(a.parentId) ? a.parentId : "root:" + sectionOf(a);
    if (!kids.has(key)) kids.set(key, []);
    kids.get(key).push(a);
  }
  for (const list of kids.values()) list.sort((x, y) => (x.sequence - y.sequence) || (x.id - y.id));
}

// ---- The tree -------------------------------------------------------------------------------------------------
function visibleIds() {
  const q = $("kb-search").value.trim().toLowerCase();
  if (!q) return null;
  const hits = new Set(articles.filter((a) => a.name.toLowerCase().includes(q)).map((a) => a.id));
  for (const id of found || []) if (byId.has(id)) hits.add(id);
  const withParents = new Set(hits);
  for (const id of hits) for (const p of ancestors(id)) withParents.add(p.id);
  return { hits, show: withParents };
}

function renderTree() {
  const filter = visibleIds();
  const tree = $("kb-tree");
  const branch = (key, depth) => {
    const ul = el("ul", "kb-branch");
    for (const a of kids.get(key) || []) {
      if (filter && !filter.show.has(a.id)) continue;
      const children = (kids.get(a.id) || []).filter((c) => !filter || filter.show.has(c.id));
      const open = filter ? true : expanded.has(a.id);
      const li = el("li");
      const row = el("div", "kb-node" + (current && current.article.id === a.id ? " on" : "") + (filter && filter.hits.has(a.id) ? " hit" : ""));
      row.style.setProperty("--depth", depth);
      const caret = el("button", "kb-caret", children.length ? (open ? "▾" : "▸") : "");
      caret.type = "button";
      if (children.length) {
        caret.setAttribute("aria-label", (open ? "Close " : "Open ") + a.name);
        caret.setAttribute("aria-expanded", String(open));
        caret.addEventListener("click", () => { if (expanded.has(a.id)) expanded.delete(a.id); else expanded.add(a.id); renderTree(); });
      } else caret.tabIndex = -1;
      const name = el("button", "kb-node-name");
      name.type = "button";
      name.append(el("span", "kb-node-icon", a.icon || "📄"), el("span", "kb-node-text", a.name || "Untitled"));
      name.addEventListener("click", () => openArticle(a.id));
      const add = el("button", "kb-node-add", "+");
      add.type = "button"; add.title = "Add a nested article under " + a.name; add.setAttribute("aria-label", add.title);
      add.addEventListener("click", () => newArticle(a.id));
      row.append(caret, name, add);
      li.append(row);
      if (children.length && open) li.append(branch(a.id, depth + 1));
      ul.append(li);
    }
    return ul;
  };
  const parts = [];
  for (const [key, label] of SECTIONS) {
    const top = branch("root:" + key, 0);
    if (!top.children.length) continue;
    parts.push(el("div", "kb-section", label), top);
  }
  tree.replaceChildren(...parts);
  const n = filter ? filter.hits.size : articles.length;
  $("kb-count").textContent = filter ? `${n} found` : `${n} articles`;
  if (!parts.length) tree.append(el("p", "msg kb-tree-empty", filter ? "No articles match your search." : "No articles yet. Add the first one."));
}

let searchTimer = null, searchRun = 0;
$("kb-search").addEventListener("input", () => {
  found = null;
  renderTree();
  clearTimeout(searchTimer);
  const q = $("kb-search").value.trim();
  if (q.length < 2) return;
  const run = ++searchRun;
  // Odoo also searches inside the articles (their text), after a short pause in typing.
  searchTimer = setTimeout(async () => {
    try { const { ids } = await call("/knowledge/search", { query: q }); if (run === searchRun) { found = ids; renderTree(); } }
    catch (err) { if (run === searchRun) note("kb-note", errText(err), true); }
  }, 450);
});

// ---- One article ------------------------------------------------------------------------------------------------
function crumbs(target, article) {
  const parts = ancestors(article.id).map((a) => { const b = el("button", "kb-crumb", (a.icon ? a.icon + " " : "") + a.name); b.type = "button"; b.addEventListener("click", () => openArticle(a.id)); return b; });
  target.replaceChildren(el("span", "kb-crumb-section", (SECTIONS.find(([k]) => k === article.category) || SECTIONS[0])[1]), ...parts.flatMap((p) => [el("span", "kb-crumb-sep", "›"), p]));
}

function wirePictures(root) {
  for (const img of root.querySelectorAll("img")) {
    img.loading = "lazy";
    if (img.classList.contains("kb-img-missing")) img.alt = img.alt || "Picture loading…";
  }
}

// Pictures the article came without (it had too many to send at once) are fetched a few at a time.
async function loadLaterPictures(articleId, ids) {
  for (let i = 0; i < ids.length; i += 4) {
    let pictures = {};
    try { ({ pictures } = await call("/knowledge/pictures", { ids: ids.slice(i, i + 4) })); } catch { return; }
    if (!current || current.article.id !== articleId) return;
    Object.assign(current.pictures, pictures);
    for (const root of [$("kb-body"), $("kb-edit-body")]) {
      for (const img of root.querySelectorAll("img[data-kb-picture]")) {
        const src = pictures[img.getAttribute("data-kb-picture")];
        if (src) { img.src = src; img.classList.remove("kb-img-missing"); img.removeAttribute("data-kb-picture"); }
      }
    }
  }
}

function renderArticle() {
  const { article, pictures } = current;
  show("kb-pick", false); show("kb-editor", false); show("kb-move-box", false); show("kb-view", true);
  crumbs($("kb-crumbs"), article);
  $("kb-view-icon").textContent = article.icon || "📄";
  $("kb-view-title").textContent = article.name || "Untitled";
  $("kb-odoo").href = odooLink + "/" + article.id;
  const body = $("kb-body");
  body.replaceChildren(fromOdooHtml(article.body, { pictures, odooOrigin: odooOrigin() }));
  if (!body.textContent.trim() && !body.querySelector("img")) body.append(el("p", "kb-placeholder", "This article is empty. Press Edit to write it."));
  wirePictures(body);
  document.title = (article.name || "Untitled") + " · Odoo knowledge base";
}

function leaveEditor() {
  if (!dirty) return true;
  if (!confirm("You have changes that aren't saved. Leave without saving them?")) return false;
  dirty = false;
  return true;
}

async function openArticle(id, { edit = false } = {}) {
  if (!leaveEditor()) return;
  note("kb-note", "");
  for (const a of ancestors(id)) expanded.add(a.id);
  try {
    const { article, pictures, later } = await call("/knowledge/article", { id });
    current = { article, pictures: pictures || {} };
    history.replaceState(null, "", "#" + id);
    renderTree();
    if (edit) startEditing(true); else renderArticle();
    if (later && later.length) loadLaterPictures(id, later);
  } catch (err) {
    if (err && err.code === "session") { signOut(true); return; }
    note("kb-note", errText(err), true);
  }
}

$("kb-copy").addEventListener("click", async () => {
  try { await navigator.clipboard.writeText($("kb-body").innerText.trim()); note("kb-note", "Copied the article's text."); }
  catch { note("kb-note", "Copy did not work. Select the text and copy it by hand.", true); }
});

// Clicking a picture shows it large; clicking again closes it.
$("kb-body").addEventListener("click", (e) => {
  const img = e.target.closest("img");
  if (!img || !img.src) return;
  $("kb-zoom-img").src = img.src; $("kb-zoom-img").alt = img.alt || ""; show("kb-zoom", true);
});
$("kb-zoom").addEventListener("click", () => show("kb-zoom", false));

// ---- New, move, trash ---------------------------------------------------------------------------------------
async function newArticle(parentId = null) {
  if (!leaveEditor()) return;
  note("kb-note", "Adding the article in Odoo…");
  try {
    const { id, articles: list } = await call("/knowledge/save", { name: "Untitled", body: "", parentId });
    setArticles(list);
    if (parentId) expanded.add(parentId);
    note("kb-note", "");
    await openArticle(id, { edit: true });
  } catch (err) {
    if (err && err.code === "session") { signOut(true); return; }
    note("kb-note", errText(err), true);
  }
}
$("kb-new").addEventListener("click", () => newArticle(null));
$("kb-child").addEventListener("click", () => current && newArticle(current.article.id));

$("kb-move").addEventListener("click", () => {
  if (!current) return;
  const self = current.article.id;
  const under = new Set([self]);
  const mark = (id) => { for (const c of kids.get(id) || []) { under.add(c.id); mark(c.id); } };
  mark(self);
  const select = $("kb-move-to");
  const options = [new Option("Top level (Workspace)", "")];
  const add = (key, depth) => { for (const a of kids.get(key) || []) { if (under.has(a.id)) continue; options.push(new Option("  ".repeat(depth) + (a.icon ? a.icon + " " : "") + a.name, String(a.id))); add(a.id, depth + 1); } };
  for (const [key] of SECTIONS) add("root:" + key, 0);
  select.replaceChildren(...options);
  select.value = current.article.parentId ? String(current.article.parentId) : "";
  show("kb-move-box", true);
  select.focus();
});
$("kb-move-cancel").addEventListener("click", () => show("kb-move-box", false));
$("kb-move-ok").addEventListener("click", async () => {
  const id = current.article.id, parentId = Number($("kb-move-to").value) || null;
  $("kb-move-ok").disabled = true;
  try {
    const { articles: list } = await call("/knowledge/move", { id, parentId });
    setArticles(list);
    current.article.parentId = parentId;
    if (parentId) expanded.add(parentId);
    renderTree(); renderArticle();
    note("kb-note", "Moved in Odoo.");
  } catch (err) { note("kb-note", errText(err), true); }
  finally { $("kb-move-ok").disabled = false; }
});

$("kb-trash").addEventListener("click", async () => {
  if (!current) return;
  const { id, name, parentId } = current.article;
  const nested = (kids.get(id) || []).length;
  if (!confirm(`Send "${name}"${nested ? " and the articles under it" : ""} to Odoo's trash? It can be restored from the trash in Odoo.`)) return;
  try {
    const { articles: list } = await call("/knowledge/trash", { id });
    setArticles(list);
    current = null;
    history.replaceState(null, "", location.pathname);
    show("kb-view", false);
    if (parentId && byId.has(parentId)) await openArticle(parentId); else { show("kb-pick", true); renderTree(); }
    note("kb-note", "Sent to Odoo's trash.");
  } catch (err) { note("kb-note", errText(err), true); }
});

// ---- Editing ----------------------------------------------------------------------------------------------------
function startEditing(isNew = false) {
  const { article, pictures } = current;
  show("kb-pick", false); show("kb-view", false); show("kb-editor", true);
  crumbs($("kb-edit-crumbs"), article);
  $("kb-edit-icon").value = article.icon || "";
  $("kb-edit-title").value = article.name || "";
  const body = $("kb-edit-body");
  body.replaceChildren(fromOdooHtml(article.body, { pictures, odooOrigin: odooOrigin(), forEditing: true }));
  if (!body.firstChild) body.append(el("p"));
  wirePictures(body);
  note("kb-edit-msg", "");
  dirty = false;
  try { document.execCommand("styleWithCSS", false, false); document.execCommand("defaultParagraphSeparator", false, "p"); } catch {}
  if (isNew) { $("kb-edit-title").focus(); $("kb-edit-title").select(); } else body.focus();
}
$("kb-edit").addEventListener("click", () => current && startEditing());
for (const id of ["kb-edit-title", "kb-edit-icon"]) $(id).addEventListener("input", () => { dirty = true; });
$("kb-edit-body").addEventListener("input", () => { dirty = true; });

$("kb-cancel").addEventListener("click", () => { if (leaveEditor()) renderArticle(); });

let savedRange = null;
const keepSelection = () => { const s = getSelection(); if (s.rangeCount && $("kb-edit-body").contains(s.anchorNode)) savedRange = s.getRangeAt(0).cloneRange(); };
const restoreSelection = () => { $("kb-edit-body").focus(); if (savedRange) { const s = getSelection(); s.removeAllRanges(); s.addRange(savedRange); } };
document.addEventListener("selectionchange", keepSelection);

$("kb-tools").addEventListener("mousedown", (e) => { if (e.target.closest("button")) e.preventDefault(); }); // keep the cursor in the article
$("kb-tools").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-cmd]");
  if (!b) return;
  const cmd = b.dataset.cmd;
  if (cmd === "picture") { keepSelection(); $("kb-file").click(); return; }
  restoreSelection();
  if (cmd === "link") {
    const url = prompt("Link address (https://…)", "https://");
    if (!url || !/^(https?:\/\/|mailto:)/i.test(url.trim())) return;
    document.execCommand("createLink", false, url.trim());
  } else document.execCommand(cmd, false, b.dataset.arg ? "<" + b.dataset.arg + ">" : null);
  dirty = true;
});

// A picture is made smaller in the browser when it's very large, then attached to the article in Odoo.
async function shrink(file) {
  if (file.size <= MAX_PICTURE && file.type !== "image/bmp") return file;
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, 2000 / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale); canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise((done) => canvas.toBlob(done, "image/jpeg", 0.85));
  return new File([blob], file.name.replace(/\.\w+$/, "") + ".jpg", { type: "image/jpeg" });
}
const base64 = (file) => new Promise((done, fail) => { const r = new FileReader(); r.onload = () => done(String(r.result).split(",")[1] || ""); r.onerror = fail; r.readAsDataURL(file); });

async function addPictures(files) {
  const pictures = [...files].filter((f) => /^image\/(png|jpeg|gif|webp|bmp)$/.test(f.type));
  if (!pictures.length) { note("kb-edit-msg", "Add a PNG, JPEG, GIF or WebP picture.", true); return; }
  for (const file of pictures) {
    note("kb-edit-msg", "Adding the picture to Odoo…");
    try {
      const small = await shrink(file);
      if (small.size > MAX_PICTURE) throw new Error("This picture is too large, even made smaller.");
      const { src, picture } = await call("/knowledge/picture", { articleId: current.article.id, name: small.name || "picture", type: small.type, data: await base64(small) });
      const img = document.createElement("img");
      img.src = picture; img.alt = small.name || ""; img.className = "img-fluid";
      img.setAttribute("data-aione-src", src);
      restoreSelection();
      const s = getSelection();
      if (s.rangeCount && $("kb-edit-body").contains(s.anchorNode)) { const r = s.getRangeAt(0); r.collapse(false); r.insertNode(img); r.setStartAfter(img); r.collapse(true); s.removeAllRanges(); s.addRange(r); }
      else $("kb-edit-body").append(img);
      dirty = true;
      note("kb-edit-msg", "Picture added. Save to keep it in the article.");
    } catch (err) { note("kb-edit-msg", errText(err), true); return; }
  }
}
$("kb-file").addEventListener("change", (e) => { const files = e.target.files; if (files && files.length) addPictures(files); e.target.value = ""; });

// Pasting: pictures are attached to Odoo; formatted text is made safe like the rest of the article.
$("kb-edit-body").addEventListener("paste", (e) => {
  const data = e.clipboardData;
  if (!data) return;
  const files = [...data.files].filter((f) => f.type.startsWith("image/"));
  if (files.length) { e.preventDefault(); keepSelection(); addPictures(files); return; }
  const html = data.getData("text/html");
  if (html) {
    e.preventDefault();
    const box = document.createElement("div");
    box.append(fromOdooHtml(html, { forEditing: true }));
    for (const img of box.querySelectorAll("img")) if (!/\/web\/(image|content)\//.test(img.getAttribute("data-aione-src") || "")) img.remove();
    document.execCommand("insertHTML", false, box.innerHTML);
  }
});
$("kb-edit-body").addEventListener("dragover", (e) => { if ([...(e.dataTransfer?.items || [])].some((i) => i.kind === "file")) e.preventDefault(); });
$("kb-edit-body").addEventListener("drop", (e) => {
  const files = [...(e.dataTransfer?.files || [])];
  if (!files.length) return;
  e.preventDefault();
  const r = document.caretRangeFromPoint ? document.caretRangeFromPoint(e.clientX, e.clientY) : null;
  if (r) savedRange = r;
  addPictures(files);
});

$("kb-editor").addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") { e.preventDefault(); $("kb-editor").requestSubmit(); }
});

$("kb-editor").addEventListener("submit", async (e) => {
  e.preventDefault();
  const name = $("kb-edit-title").value.trim();
  if (!name) { note("kb-edit-msg", "Give the article a title.", true); return; }
  const body = toOdooHtml($("kb-edit-body"));
  const icon = $("kb-edit-icon").value.trim();
  $("kb-save").disabled = true; note("kb-edit-msg", "Saving to Odoo…");
  try {
    const saved = await call("/knowledge/save", { id: current.article.id, name, body, icon, updatedAt: current.article.updatedAt });
    setArticles(saved.articles);
    Object.assign(current.article, { name, body, icon, updatedAt: saved.updatedAt || current.article.updatedAt });
    for (const img of $("kb-edit-body").querySelectorAll("img[data-aione-src]")) {
      const id = (/\/web\/(?:image|content)\/(\d+)/.exec(img.getAttribute("data-aione-src")) || [])[1];
      if (id && img.src.startsWith("data:")) current.pictures[id] = img.src;
    }
    dirty = false;
    renderTree(); renderArticle();
    note("kb-note", "Saved to Odoo.");
  } catch (err) {
    if (err && err.code === "session") { signOut(true); return; }
    note("kb-edit-msg", errText(err), true);
  } finally { $("kb-save").disabled = false; }
});

window.addEventListener("beforeunload", (e) => { if (dirty) { e.preventDefault(); e.returnValue = ""; } });

// ---- Unlock, reload, lock ------------------------------------------------------------------------------------------
function showApp(list) {
  setArticles(list);
  show("state", false); show("unlock-block", false); show("kb-app", true);
  // Top-level articles start open, as in Odoo's sidebar.
  for (const [key] of SECTIONS) for (const a of kids.get("root:" + key) || []) expanded.add(a.id);
  renderTree();
  const fromLink = Number(location.hash.slice(1));
  if (fromLink && byId.has(fromLink)) openArticle(fromLink); else { show("kb-pick", true); show("kb-view", false); show("kb-editor", false); }
}

function lock() {
  if (!leaveEditor()) return;
  password = ""; articles = []; byId = new Map(); kids = new Map(); current = null; found = null; expanded.clear();
  $("kb-tree").replaceChildren(); $("kb-body").replaceChildren(); $("kb-edit-body").replaceChildren();
  $("kb-search").value = ""; note("kb-note", "");
  document.title = "Odoo knowledge base · AIONE Team Control";
  show("kb-app", false); show("unlock-block", true);
  note("unlock-msg", "Locked. Enter the password to open it again.");
  $("unlock-password").focus();
}

$("unlock-toggle").addEventListener("click", () => {
  const input = $("unlock-password");
  const showing = input.type === "text";
  input.type = showing ? "password" : "text";
  $("unlock-toggle").textContent = showing ? "Show" : "Hide";
  $("unlock-toggle").setAttribute("aria-pressed", String(!showing));
});

$("unlock-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const typed = $("unlock-password").value;
  $("unlock-submit").disabled = true; note("unlock-msg", "Checking…");
  try {
    const { url, articles: list } = await api("/knowledge/unlock", { method: "POST", body: { password: typed } });
    password = typed;
    odooLink = String(url || "").replace(/\/+$/, "");
    $("unlock-password").value = "";
    $("unlock-password").type = "password";
    $("unlock-toggle").textContent = "Show";
    $("unlock-toggle").setAttribute("aria-pressed", "false");
    note("unlock-msg", "");
    showApp(list);
  } catch (err) {
    if (err && err.code === "session") { signOut(true); return; }
    note("unlock-msg", errText(err), true);
  } finally { $("unlock-submit").disabled = false; }
});

$("kb-reload").addEventListener("click", async () => {
  if (!leaveEditor()) return;
  $("kb-reload").disabled = true;
  try {
    const { articles: list } = await api("/knowledge/unlock", { method: "POST", body: { password } });
    setArticles(list); renderTree();
    if (current && byId.has(current.article.id)) await openArticle(current.article.id);
    note("kb-note", "Read from Odoo again.");
  } catch (err) { note("kb-note", errText(err), true); }
  finally { $("kb-reload").disabled = false; }
});
$("kb-lock").addEventListener("click", lock);
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !$("kb-zoom").hidden) show("kb-zoom", false); });

async function load() {
  const status = await api("/knowledge/status");
  show("state", false);
  if (!status.odoo) { show("state", true); $("state").textContent = "Odoo is not connected, so the knowledge base is not available."; return; }
  if (status.configured) show("unlock-block", true);
  else { show("state", true); $("state").textContent = "No knowledge password has been set yet. An administrator sets it on the Users page."; }
}

const s = getSession();
if (!s) signOut(true);
else {
  $("me").textContent = s.email;
  $("signout").addEventListener("click", () => signOut());
  load().catch((err) => {
    if (err && err.code === "session") { signOut(true); return; }
    show("state", true); $("state").textContent = errText(err); $("state").classList.add("err");
  });
}
