// Shows an attachment inside the dashboard (images, PDF, video, audio and text), so people don't need
// to open Jira. The file arrives through the proxy as a blob and is never sent anywhere else.
const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
const TEXT = /^(text\/|application\/(json|xml|csv|x-yaml|yaml|javascript|x-sh|sql))/;
const TEXT_EXT = /\.(txt|log|csv|json|xml|ya?ml|md|sql|js|ts|py|sh|ini|conf|cfg|html?)$/i;

export function kindOf(type, name) {
  type = String(type || "").toLowerCase();
  if (/^image\/(png|jpe?g|gif|webp|bmp|svg\+xml|avif)$/.test(type)) return "image";
  if (type === "application/pdf" || /\.pdf$/i.test(name)) return "pdf";
  if (/^video\//.test(type)) return "video";
  if (/^audio\//.test(type)) return "audio";
  if (TEXT.test(type) || TEXT_EXT.test(name)) return "text";
  return "";
}
export const canPreview = (type, name) => !!kindOf(type, name);

function save(url, name) { const a = document.createElement("a"); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove(); }

// load() returns a Response (from the proxy). Opens a full-window viewer with Download and Close.
export async function previewFile({ name, type, load }) {
  const d = el("dialog", "file-preview"), head = el("div", "fp-head"), body = el("div", "fp-body");
  const title = el("strong", "fp-name", name); title.dir = "auto";
  const dl = el("button", "btn", "Download"), close = el("button", "btn", "Close"); dl.type = close.type = "button"; dl.disabled = true;
  head.append(title, el("span", "sp"), dl, close); d.append(head, body); body.append(el("p", "msg", "Loading " + name + "…"));
  let url = null;
  const done = () => { d.close(); };
  d.addEventListener("close", () => { d.remove(); if (url) setTimeout(() => URL.revokeObjectURL(url), 1000); });
  close.addEventListener("click", done);
  document.body.append(d); d.showModal();
  try {
    const res = await load();
    let blob = await res.blob();
    const kind = kindOf(type || blob.type, name);
    // Show text and SVG as data the browser can't run: SVG as an image, everything textual as plain text.
    if (kind === "pdf" && blob.type !== "application/pdf") blob = new Blob([blob], { type: "application/pdf" });
    url = URL.createObjectURL(blob);
    dl.disabled = false; dl.addEventListener("click", () => save(url, name));
    body.replaceChildren();
    if (kind === "image") { const img = el("img", "fp-img"); img.alt = name; img.src = url; body.append(img); }
    else if (kind === "pdf") { const f = el("iframe", "fp-frame"); f.title = name; f.src = url; body.append(f); }
    else if (kind === "video" || kind === "audio") { const m = el(kind, "fp-media"); m.controls = true; m.src = url; body.append(m); }
    else if (kind === "text") { const t = await blob.text(); const pre = el("pre", "fp-text", t.length > 2000000 ? t.slice(0, 2000000) + "\n… (cut: download for the full file)" : t); pre.dir = "auto"; body.append(pre); }
    else body.append(el("p", "msg", "This kind of file can't be shown here. Use Download to open it on your computer."));
  } catch (err) {
    body.replaceChildren(el("p", "msg err", "Couldn't load the file: " + ((err && err.message) || err)));
  }
}
