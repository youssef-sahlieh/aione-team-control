// Followers of an Odoo Helpdesk ticket: Odoo's standard chatter followers, shown as a count in the ticket drawer and as a
// dialog. Every read and change goes through the proxy (/odoo/tickets/HD-n/followers), which checks access and calls Odoo.
const el = (tag, text, className) => { const n = document.createElement(tag); if (text != null) n.textContent = text; if (className) n.className = className; return n; };
const SEARCH_DELAY = 250;
const plural = (n) => (n === 1 ? "1 follower" : n + " followers");

export function createTicketFollowers({ api }) {
  const dialog = el("dialog", null, "followers-dialog");
  dialog.setAttribute("aria-labelledby", "fol-title");
  document.body.append(dialog);

  const state = { key: "", followers: [], loading: false, loadError: "", mode: "list", notify: false,
    results: [], hasMore: false, search: "idle", searchError: "", chosen: new Map(), submitting: false, submitError: "" };
  let loadRun = 0, searchRun = 0, searchTimer = 0, opener = null, pendingFocus = null;

  // ---- drawer button: the count, next to the comments ----
  // The button is updated in place, so keyboard focus on it survives a reload of the list.
  function drawButton() {
    const host = document.getElementById("d-followers");
    if (!host) return;
    const count = state.loading ? "…" : String(state.followers.length);
    let b = host.querySelector(".fol-btn");
    if (!b) {
      b = el("button", null, "btn small fol-btn");
      b.type = "button";
      b.setAttribute("aria-haspopup", "dialog");
      b.addEventListener("click", () => open());
      host.replaceChildren(b);
    }
    b.replaceChildren("Followers ", el("span", "(" + count + ")", "fol-count"));
    b.setAttribute("aria-label", state.loading ? "Followers, loading" : plural(state.followers.length) + ". Open the followers list");
  }

  // ---- reads ----
  async function load() {
    const k = state.key;
    if (!k) return;
    const run = ++loadRun;
    state.loading = true;
    drawButton();
    let res = null, error = "";
    try { res = await api("/odoo/tickets/" + k + "/followers"); }
    catch (err) { error = err.message || "The followers couldn't be loaded."; }
    // Only the newest answer for this ticket is shown, so an older slow response never overwrites a newer list.
    if (k !== state.key || run !== loadRun) return;
    state.loading = false;
    if (res) { state.followers = res.followers || []; state.loadError = ""; }
    else state.loadError = error;
    drawButton();
    if (dialog.open) render();
  }

  // ---- writes ----
  async function submit() {
    if (state.submitting || !state.chosen.size) return;
    const k = state.key, partnerIds = [...state.chosen.keys()], notify = state.notify;
    state.submitting = true; state.submitError = "";
    const run = ++loadRun;
    render();
    let res = null, err = null;
    try { res = await api("/odoo/tickets/" + k + "/followers", { method: "POST", body: { partnerIds, notify } }); }
    catch (e) { err = e; }
    if (k !== state.key) return; // the drawer moved on to another ticket
    state.submitting = false;
    if (res) {
      if (run === loadRun) state.followers = res.followers || state.followers;
      state.loadError = "";
      state.chosen.clear(); state.results = []; state.hasMore = false; state.search = "idle"; state.searchError = ""; dialog.dataset.term = "";
      drawButton();
      dialog.close();
      return;
    }
    if (err && err.code === "odoo_unknown") {
      // Odoo may or may not have saved it: reload the real list and keep the chosen contacts, so nothing is lost.
      state.submitError = "Odoo didn’t confirm the change. The list has been reloaded: check it before adding again.";
      state.mode = "add";
      render();
      await load();
      return;
    }
    state.submitError = (err && err.message) || "The followers couldn't be added. Your choices are still here.";
    render();
  }

  // ---- search: debounced; the newest answer wins; one page at a time ----
  function onType(value) {
    dialog.dataset.term = value;
    clearTimeout(searchTimer);
    searchRun++;
    const q = value.trim();
    state.searchError = "";
    if (q.length < 2) { state.results = []; state.hasMore = false; state.search = "short"; render(); return; }
    state.search = "loading";
    render();
    searchTimer = setTimeout(() => runSearch(0), SEARCH_DELAY);
  }

  async function runSearch(offset) {
    const q = (dialog.dataset.term || "").trim(), k = state.key;
    if (q.length < 2 || !k) return;
    const run = ++searchRun;
    let res = null, error = "";
    try { res = await api("/odoo/tickets/" + k + "/followers/search?q=" + encodeURIComponent(q) + "&offset=" + offset); }
    catch (err) { error = err.message || "The search didn't work. Try again."; }
    if (run !== searchRun || k !== state.key || state.mode !== "add") return;
    if (res) {
      state.results = offset ? state.results.concat(res.contacts || []) : (res.contacts || []);
      state.hasMore = !!res.hasMore;
      state.search = state.results.length ? "done" : "none";
      state.searchError = "";
    } else {
      state.results = []; state.hasMore = false; state.searchError = error;
    }
    render();
  }

  // ---- dialog lifecycle ----
  function show(k) {
    state.key = k; state.followers = []; state.loading = false; state.loadError = ""; state.mode = "list"; state.notify = false;
    state.results = []; state.hasMore = false; state.search = "idle"; state.searchError = ""; state.chosen.clear(); state.submitting = false; state.submitError = "";
    dialog.dataset.term = "";
    drawButton();
    load();
  }

  function clear() {
    state.key = ""; loadRun++; searchRun++; clearTimeout(searchTimer);
    if (dialog.open) dialog.close();
    document.getElementById("d-followers")?.replaceChildren();
  }

  function open() {
    if (!state.key) return;
    opener = document.activeElement;
    state.mode = "list"; state.submitError = "";
    pendingFocus = "fol-open-add";
    if (!dialog.open) dialog.showModal();
    render();
    load();
  }

  function render() {
    const active = document.activeElement;
    const keep = dialog.contains(active) ? (active.dataset.fk || "") : "";
    const caret = dialog.contains(active) && active.id === "fol-search" ? active.selectionStart : null;

    const head = el("h2", state.mode === "add" ? "Add followers" : "Followers", "fol-title");
    head.id = "fol-title";
    const body = el("div", null, "fol-body");
    if (state.mode === "add") addBody(body); else listBody(body);
    const foot = el("div", null, "fol-foot");
    if (state.mode === "add") {
      const send = el("button", state.submitting ? "Adding…" : "Add and close", "btn primary");
      send.type = "button"; send.id = "fol-submit"; send.dataset.fk = "fol-submit";
      send.disabled = state.submitting || state.chosen.size === 0;
      send.addEventListener("click", () => submit());
      const cancel = el("button", "Cancel", "btn"); cancel.type = "button"; cancel.dataset.fk = "fol-cancel";
      cancel.addEventListener("click", () => dialog.close());
      foot.append(send, cancel);
    } else {
      const add = el("button", "Add followers", "btn primary");
      add.type = "button"; add.id = "fol-open-add"; add.dataset.fk = "fol-open-add";
      add.disabled = state.loading;
      add.addEventListener("click", () => { state.mode = "add"; state.submitError = ""; pendingFocus = "fol-search"; render(); });
      const done = el("button", "Close", "btn"); done.type = "button"; done.dataset.fk = "fol-close";
      done.addEventListener("click", () => dialog.close());
      foot.append(add, done);
    }
    dialog.replaceChildren(head, body, foot);

    // Keep the keyboard where it was: the same control after a rebuild, the search caret, or the requested control on a mode change.
    const want = pendingFocus || keep;
    pendingFocus = null;
    const target = want && [...dialog.querySelectorAll("[data-fk]")].find((n) => n.dataset.fk === want && !n.disabled);
    if (target) {
      target.focus();
      if (caret != null && target.setSelectionRange) target.setSelectionRange(caret, caret);
    } else {
      dialog.querySelector("button:not([disabled]), input")?.focus();
    }
  }

  function listBody(body) {
    if (state.loading && !state.followers.length) body.append(el("p", "Loading followers…", "msg"));
    if (state.loadError) body.append(setAlert(el("p", state.loadError, "msg err")));
    if (!state.loading && !state.loadError && !state.followers.length) body.append(el("p", "Nobody is following this ticket yet.", "msg"));
    if (state.followers.length) {
      const list = el("ul", null, "fol-list");
      for (const f of state.followers) {
        const li = el("li", null, "fol-row");
        li.append(el("strong", f.name || "Unnamed contact"), el("span", f.email || "No email on the contact", "msg"));
        list.append(li);
      }
      body.append(list);
    }
    body.append(el("p", "Followers are contacts in Odoo who are kept informed about this ticket. Adding one doesn’t change the customer, the assignee or who can see the ticket.", "msg"));
  }

  function addBody(body) {
    const label = el("label", "Search contacts by name or email", "fol-label");
    label.htmlFor = "fol-search";
    const search = el("input", null, "inp");
    search.type = "search"; search.id = "fol-search"; search.dataset.fk = "fol-search"; search.autocomplete = "off";
    search.value = dialog.dataset.term || "";
    search.setAttribute("aria-describedby", "fol-status");
    search.addEventListener("input", () => onType(search.value));
    body.append(label, search);

    const status = el("p", statusText(), "msg" + (state.searchError ? " err" : ""));
    status.id = "fol-status"; status.setAttribute("aria-live", "polite");
    body.append(status);

    if (state.results.length) {
      const group = el("ul", null, "fol-results");
      group.setAttribute("aria-label", "Matching contacts");
      for (const c of state.results) {
        const li = el("li");
        const following = !!c.following || state.followers.some((f) => f.id === c.id);
        const pick = el("button", null, "fol-pick");
        pick.type = "button"; pick.dataset.fk = "pick:" + c.id;
        pick.setAttribute("aria-pressed", String(state.chosen.has(c.id)));
        pick.disabled = following;
        pick.append(el("strong", c.name || "Unnamed contact"), el("span", c.email || "No email on the contact", "msg"));
        if (following) pick.append(el("em", "Already following", "fol-tag"));
        pick.addEventListener("click", () => toggle(c));
        li.append(pick); group.append(li);
      }
      body.append(group);
    }
    if (state.hasMore) {
      const more = el("button", "Show more contacts", "btn small"); more.type = "button"; more.dataset.fk = "more";
      more.addEventListener("click", () => runSearch(state.results.length));
      body.append(more);
    }

    body.append(el("h3", "Chosen", "fol-sub"));
    const chips = el("div", null, "fol-chips");
    chips.setAttribute("role", "group"); chips.setAttribute("aria-label", "Chosen contacts");
    if (!state.chosen.size) chips.append(el("span", "No contacts chosen yet.", "msg"));
    for (const c of state.chosen.values()) {
      const chip = el("button", "× " + (c.name || c.email || "Contact"), "fol-chip");
      chip.type = "button"; chip.dataset.fk = "chip:" + c.id;
      chip.setAttribute("aria-label", "Remove " + (c.name || c.email || "contact"));
      chip.addEventListener("click", () => { state.chosen.delete(c.id); state.submitError = ""; pendingFocus = "fol-search"; render(); });
      chips.append(chip);
    }
    body.append(chips);

    const notifyRow = el("label", null, "fol-notify");
    const box = el("input"); box.type = "checkbox"; box.id = "fol-notify"; box.dataset.fk = "fol-notify"; box.checked = state.notify;
    box.addEventListener("change", () => { state.notify = box.checked; render(); });
    notifyRow.append(box, el("span", "Notify newly added followers"));
    body.append(notifyRow);
    body.append(el("p", state.notify
      ? "On: Odoo emails the new followers about this ticket and posts an invitation in its chatter."
      : "Off: the contacts are added to the followers list without the invitation email.", "msg fol-help"));
    if (state.submitError) body.append(setAlert(el("p", state.submitError, "msg err")));
  }

  function statusText() {
    if (state.searchError) return state.searchError;
    if (state.search === "loading") return "Searching…";
    if (state.search === "short") return "Type at least 2 letters of a name or email.";
    if (state.search === "none") return "No contacts match. Only existing Odoo contacts can be added.";
    if (state.search === "idle") return "Type a name or email to find contacts.";
    return "";
  }

  function toggle(c) {
    if (state.chosen.has(c.id)) state.chosen.delete(c.id);
    else state.chosen.set(c.id, { id: c.id, name: c.name, email: c.email });
    state.submitError = "";
    pendingFocus = "pick:" + c.id;
    render();
  }

  function setAlert(node) { node.setAttribute("role", "alert"); return node; }

  // Escape closes this dialog (the browser does that), but not the ticket drawer behind it, which listens on the document.
  dialog.addEventListener("keydown", (e) => { if (e.key === "Escape") e.stopPropagation(); });

  dialog.addEventListener("close", () => {
    state.submitting = false;
    const back = opener && opener.isConnected ? opener : document.querySelector("#d-followers .fol-btn");
    if (back && typeof back.focus === "function") back.focus();
    opener = null;
  });

  return { show, clear, open, load };
}
