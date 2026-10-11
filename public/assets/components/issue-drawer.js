const $ = id => document.getElementById(id);
export function createIssueDrawer({ isDirty }) {
  const drawer = $("drawer"), body = $("d-body"), tabs = $("drawer-tabs");
  let opener = null, active = "overview";
  const panels = {};
  for (const [id, label] of [["overview", "Overview"], ["activity", "Activity"], ["comments", "Comments"], ["files", "Files"]]) {
    const tab = document.createElement("button"); tab.type = "button"; tab.className = "drawer-tab"; tab.textContent = label;
    tab.id = "tab-" + id; tab.setAttribute("role", "tab"); tab.setAttribute("aria-controls", "panel-" + id);
    tab.addEventListener("click", () => select(id)); tabs.appendChild(tab);
    const panel = document.createElement("div"); panel.id = "panel-" + id; panel.className = "drawer-panel"; panel.setAttribute("role", "tabpanel"); panel.setAttribute("aria-labelledby", tab.id); panels[id] = panel;
  }
  for (const child of [...body.children]) {
    const id = child.querySelector("#d-hist") ? "activity" : child.querySelector("#d-comments") ? "comments" : child.querySelector("#d-att,#i-att") ? "files" : "overview";
    panels[id].appendChild(child);
  }
  const note = document.createElement("p"); note.className = "msg"; note.textContent = "Recorded due date changes. This timeline is not a complete ticket audit."; panels.activity.prepend(note);
  Object.values(panels).forEach(panel => body.appendChild(panel));
  function select(id) {
    active = id;
    for (const tab of tabs.children) { const selected = tab.id === "tab-" + id; tab.setAttribute("aria-selected", String(selected)); tab.tabIndex = selected ? 0 : -1; }
    for (const [key, panel] of Object.entries(panels)) panel.hidden = key !== id;
    body.scrollTop = 0;
  }
  tabs.addEventListener("keydown", e => {
    const list = [...tabs.children], index = list.indexOf(document.activeElement);
    if (index < 0) return;
    let next = index;
    if (e.key === "ArrowRight") next = (index + 1) % list.length;
    else if (e.key === "ArrowLeft") next = (index + list.length - 1) % list.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = list.length - 1;
    else return;
    e.preventDefault(); select(list[next].id.slice(4)); list[next].focus();
  });
  document.addEventListener("keydown", e => {
    if (drawer.hidden || e.key !== "Tab" || !$("pop").hidden) return;
    const targets = [...drawer.querySelectorAll('button,a[href],input,textarea,select,[tabindex="0"]')].filter(n => !n.disabled && n.getClientRects().length);
    const first = targets[0], last = targets.at(-1);
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
  });
  select(active);
  return {
    select,
    open() { opener = document.activeElement; select("overview"); $("main-content").closest(".app-shell").inert = true; document.body.classList.add("drawer-open"); },
    allowClose() { return !isDirty() || confirm("Discard your unsaved ticket edits?"); },
    close() { $("main-content").closest(".app-shell").inert = false; document.body.classList.remove("drawer-open"); if (opener?.isConnected) opener.focus(); else $("page-heading").focus(); }
  };
}
