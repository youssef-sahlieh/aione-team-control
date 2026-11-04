// Odoo Knowledge article HTML on this page. An article is shown (and edited) as Odoo saved it, made safe first:
// - Scripts, frames, forms and SVG are dropped, and so are event attributes and javascript: links.
// - Odoo's own addresses (pictures /web/image/12, links /odoo/...) and inline styles can't be used on this page
//   (its security policy), so they're kept in data-aione-* attributes: pictures show from the data: copies the
//   proxy sends, links point at Odoo, and toOdooHtml() puts every original back when the article is saved.
const DROP = new Set(["SCRIPT", "STYLE", "IFRAME", "FRAME", "FRAMESET", "OBJECT", "EMBED", "APPLET", "LINK", "META", "BASE", "FORM", "INPUT", "BUTTON", "TEXTAREA", "SELECT", "OPTION", "SVG", "MATH", "TEMPLATE", "NOSCRIPT", "AUDIO", "VIDEO", "SOURCE", "TRACK", "CANVAS", "DIALOG", "PORTAL"]);
const KEPT_AS_DATA = new Set(["style", "id", "contenteditable"]);
const SAFE_LINK = /^(https?:|mailto:|tel:|#)/i;
const PREFIX = "data-aione-";

// The attachment id in an Odoo picture address (/web/image/123?…, /web/image/123-abc/x.png, /web/content/123).
export const pictureId = (src) => Number((/\/web\/(?:image|content)\/(\d{1,12})(?:[-/?#]|$)/.exec(String(src || "")) || [])[1]) || null;

// Odoo HTML -> a fragment for this page. pictures: { attachmentId: "data:image/…" }. odooOrigin: "https://x.odoo.com".
export function fromOdooHtml(html, { pictures = {}, odooOrigin = "", forEditing = false, doc = document } = {}) {
  const parsed = new DOMParser().parseFromString("<body>" + String(html || ""), "text/html");
  const out = doc.createDocumentFragment();
  (function walk(src, dst) {
    for (const n of [...src.childNodes]) {
      if (n.nodeType === 3) { dst.appendChild(doc.createTextNode(n.nodeValue)); continue; }
      if (n.nodeType !== 1) continue;
      const tag = n.tagName.toUpperCase();
      if (DROP.has(tag) || n.namespaceURI !== "http://www.w3.org/1999/xhtml") continue;
      const el = doc.createElement(tag.toLowerCase());
      for (const { name, value } of [...n.attributes]) {
        const a = name.toLowerCase();
        if (a.startsWith("on") || a === "srcset" || a === "formaction" || a === "action" || a.includes(":") || a.startsWith(PREFIX)) continue;
        if (KEPT_AS_DATA.has(a)) { el.setAttribute(PREFIX + a, value); continue; }
        if (a === "href") {
          const v = value.trim();
          if (SAFE_LINK.test(v)) el.setAttribute("href", v);
          else if (/^\/(?!\/)/.test(v) && odooOrigin) { el.setAttribute(PREFIX + "href", v); el.setAttribute("href", odooOrigin + v); }
          continue;
        }
        if (a === "src") {
          if (tag !== "IMG") continue;
          // A picture copied inside this page's editor carries its Odoo address with it.
          const copied = n.getAttribute(PREFIX + "src") || "";
          const original = /^\/web\/(?:image|content)\/\d/.test(copied) ? copied : value;
          el.setAttribute(PREFIX + "src", original);
          const shown = pictures[pictureId(original)] || (/^data:image\/(png|jpe?g|gif|webp);base64,/i.test(value) ? value : "");
          if (shown) el.setAttribute("src", shown);
          else { el.classList.add("kb-img-missing"); el.setAttribute("data-kb-picture", String(pictureId(original) || "")); }
          continue;
        }
        el.setAttribute(a, value);
      }
      if (tag === "A" && !forEditing && el.hasAttribute("href")) { el.target = "_blank"; el.rel = "noopener"; }
      dst.appendChild(el);
      walk(n, el);
    }
  })(parsed.body, out);
  return out;
}

// What the editor holds -> HTML for Odoo: originals back in place, this page's additions taken out.
export function toOdooHtml(root) {
  const copy = root.cloneNode(true);
  for (const el of copy.querySelectorAll("*")) {
    if (el.tagName === "IMG") {
      const original = el.getAttribute(PREFIX + "src");
      if (!original) { el.remove(); continue; } // a picture that never reached Odoo
      el.setAttribute("src", original);
    }
    if (el.tagName === "A" && el.hasAttribute(PREFIX + "href")) el.removeAttribute("href");
    for (const { name, value } of [...el.attributes]) {
      if (name.startsWith(PREFIX)) { el.removeAttribute(name); el.setAttribute(name.slice(PREFIX.length), value); }
      else if (name === "data-kb-picture") el.removeAttribute(name);
    }
    el.classList.remove("kb-img-missing");
    if (el.getAttribute("class") === "") el.removeAttribute("class");
  }
  return copy.innerHTML;
}
