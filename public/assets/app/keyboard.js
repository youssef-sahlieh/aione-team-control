// On phones the on-screen keyboard covers part of the page, and iOS Safari does not shrink 100dvh when it opens.
// This keeps two variables up to date from the visual viewport: --vvh (the height really visible above the keyboard)
// and --vvt (how far iOS has scrolled the visible area down). A dialog uses them to stay on screen. While a text field
// inside a dialog has focus, the field is scrolled inside its own scrolling box, never the page: scrolling the page
// is what made the header of the dialog move down on some iPhones.
// Desktop and tablets without a keyboard are unaffected: --vvh is the window height and --vvt is 0.
const vv = window.visualViewport;
const root = document.documentElement;
const EDITABLE = "input:not([type=checkbox]):not([type=radio]):not([type=button]):not([type=submit]):not([type=file]):not([type=range]), textarea, select, [contenteditable=true]";
const DIALOG = ".pop.modal, dialog, .wl-dialog, .followers-dialog, .date-dialog, #drawer";

function sync() {
  const h = vv ? vv.height : window.innerHeight;
  const top = vv ? vv.offsetTop : 0;
  root.style.setProperty("--vvh", Math.round(h) + "px");
  root.style.setProperty("--vvt", Math.round(top) + "px");
  // The keyboard's height is what the visual viewport lost. (iOS also scrolls the page by about that much, so
  // offsetTop is not subtracted: doing so made an open keyboard look closed.)
  const open = vv ? window.innerHeight - vv.height > 120 : false;
  const opened = open && !root.classList.contains("kb-open");
  root.classList.toggle("kb-open", open);
  // The keyboard just opened (and the ticket header just shrank): bring the field being typed in back into view.
  const t = document.activeElement;
  if (opened && t instanceof HTMLElement && t.matches(EDITABLE) && t.closest(DIALOG)) revealFocused(t, t.closest(DIALOG));
  // iOS can leave the page scrolled when the keyboard closes; put it back while a dialog is open.
  if (!open && window.scrollY !== 0 && document.querySelector(".pop.modal:not([hidden])")) window.scrollTo(0, 0);
}

// The nearest ancestor (inside the dialog) that scrolls vertically.
function scrollBox(el, dialog) {
  for (let p = el.parentElement; p && p !== dialog.parentElement; p = p.parentElement) {
    if (/(auto|scroll)/.test(getComputedStyle(p).overflowY) && p.scrollHeight > p.clientHeight) return p;
  }
  return dialog;
}

function revealFocused(target, dialog) {
  // Wait for iOS to finish raising the keyboard, then centre the field in the visible part of the dialog.
  setTimeout(() => {
    if (!target.isConnected || !dialog.isConnected) return;
    const box = scrollBox(target, dialog);
    // The part of the box that is really visible above the keyboard, and the field's centre inside it.
    const top = Math.max(box.getBoundingClientRect().top, vv ? vv.offsetTop : 0);
    const bottom = Math.min(box.getBoundingClientRect().bottom, vv ? vv.offsetTop + vv.height : window.innerHeight);
    const r = target.getBoundingClientRect();
    box.scrollTop += (r.top + r.bottom) / 2 - (top + bottom) / 2;
    if (window.scrollY !== 0) window.scrollTo(0, 0);
  }, 320);
}

// The ticket dialog is "typing" while a text box in it has focus (not a list: a picker raises no keyboard). On phones
// its header then shrinks to one line (styles/mobile.css), whether or not the keyboard can be detected.
const TYPED = "input:not([type=checkbox]):not([type=radio]):not([type=button]):not([type=submit]):not([type=file]):not([type=range]):not([type=date]), textarea, [contenteditable=true]";
function markTyping() {
  const drawer = document.getElementById("drawer");
  if (!drawer) return;
  const t = document.activeElement;
  drawer.classList.toggle("typing", !!(t instanceof HTMLElement && t.matches(TYPED) && drawer.contains(t)));
}
// Leaving a text box brings the full header back a moment later, not at once: the tap that left it (on Post note,
// Add comment…) must land on the button before the header pushes it down.
let restore = 0;
document.addEventListener("focusout", () => { clearTimeout(restore); restore = setTimeout(markTyping, 450); });

function onFocusIn(e) {
  const t = e.target;
  // Into a text box: shrink at once. Onto anything else (the button being pressed): the delayed restore decides.
  if (t instanceof HTMLElement && t.matches(TYPED)) { clearTimeout(restore); markTyping(); }
  if (!(t instanceof HTMLElement) || !t.matches(EDITABLE)) return;
  const dialog = t.closest(DIALOG);
  if (!dialog) return;
  sync();
  revealFocused(t, dialog);
}

sync();
if (vv) {
  vv.addEventListener("resize", sync);
  vv.addEventListener("scroll", sync);
}
window.addEventListener("resize", sync);
document.addEventListener("focusin", onFocusIn);
