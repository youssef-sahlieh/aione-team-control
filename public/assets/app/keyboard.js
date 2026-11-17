// On phones the on-screen keyboard covers part of the page, and iOS Safari does not shrink 100dvh when it opens.
// This keeps --vvh (the height that is really visible above the keyboard) up to date and, while a text field
// inside a dialog has focus, shrinks the dialog to that height and scrolls the field into the middle of it.
// Desktop and tablets without a keyboard are unaffected: --vvh stays equal to the window height.
const vv = window.visualViewport;
const root = document.documentElement;
const EDITABLE = "input:not([type=checkbox]):not([type=radio]):not([type=button]):not([type=submit]):not([type=file]):not([type=range]), textarea, select, [contenteditable=true]";

function sync() {
  const h = vv ? vv.height : window.innerHeight;
  root.style.setProperty("--vvh", Math.round(h) + "px");
  const open = vv ? window.innerHeight - vv.height - vv.offsetTop > 120 : false;
  root.classList.toggle("kb-open", open);
}

function revealFocused(target) {
  // Let iOS finish raising the keyboard first, then centre the field in the visible part of the screen.
  setTimeout(() => {
    if (!target.isConnected) return;
    try { target.scrollIntoView({ block: "center", inline: "nearest" }); } catch { target.scrollIntoView(); }
  }, 320);
}

function onFocusIn(e) {
  const t = e.target;
  if (!(t instanceof HTMLElement) || !t.matches(EDITABLE)) return;
  if (!t.closest(".pop.modal, dialog, .wl-dialog, .followers-dialog, .date-dialog")) return;
  sync();
  revealFocused(t);
}

sync();
if (vv) {
  vv.addEventListener("resize", sync);
  vv.addEventListener("scroll", sync);
}
window.addEventListener("resize", sync);
document.addEventListener("focusin", onFocusIn);
