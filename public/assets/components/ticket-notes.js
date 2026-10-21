const element = (tag, text, className) => {const node = document.createElement(tag); if (text) node.textContent = text; if (className) node.className = className; return node;};
const when = value => new Date(value).toLocaleString();

// Internal notes on a ticket: a team thread inside AION (not email, not Jira). Type @ to mention someone; they get a
// notification in their inbox, shown here until they mark it read.
export function createTicketNotes({api}) {
  const panel = document.getElementById('panel-notes');
  let currentKey, generation = 0;
  const drafts = new Map();
  async function load(key) {
    currentKey = key;
    const run = ++generation;
    panel.replaceChildren(element('p', 'Loading internal notes…', 'msg'));
    try {
      const [result, inbox] = await Promise.all([
        api('/ticket-notes?key='+encodeURIComponent(key)),
        api('/ticket-notes/inbox').catch(() => ({items:[]}))
      ]);
      if (run !== generation) return;
      panel.replaceChildren(element('h3', 'Internal notes'), element('p', 'Team notes on this ticket. Type @ to mention someone and they get a notification in AION. Nothing is emailed or posted to Jira.', 'msg'));
      const mentions = (inbox.items || []).filter(i => i.key === key && !i.readAt);
      if (mentions.length) {
        const box = element('div', null, 'blk');
        box.append(element('strong', 'Mentioned you'));
        for (const item of mentions) {
          const row = element('div', null, 'msg');
          row.append(element('p', item.by + ' · ' + when(item.createdAt) + ' — ' + item.excerpt));
          const read = element('button', 'Mark read', 'btn'); read.type = 'button';
          read.addEventListener('click', async () => { read.disabled = true; try { await api('/ticket-notes/inbox', {method:'POST', body:{ids:[item.id]}}); await load(key); } catch (error) { read.disabled = false; read.textContent = error.message || 'Could not mark read.'; } });
          row.append(read); box.append(row);
        }
        panel.append(box);
      }
      const list = element('div');
      for (const note of result.notes.slice().reverse()) {
        const card = element('article', null, 'blk');
        card.append(element('strong', note.author.name + (note.author.dev ? ' · '+note.author.dev : '')), element('p', when(note.createdAt), 'msg'));
        const text = element('p', note.text); text.style.whiteSpace = 'pre-wrap'; text.style.overflowWrap = 'anywhere'; card.append(text);
        if (note.mentions?.length) card.append(element('p', 'Mentioned: ' + note.mentions.map(m => '@' + m.name).join(', '), 'msg'));
        list.append(card);
      }
      if (!result.notes.length) list.append(element('p', 'No internal notes yet.', 'msg'));
      const form = element('form'), label = element('label', 'Note'), input = element('textarea');
      const picker = element('div', null, 'mention-picker'); picker.id = 'note-mention-picker'; picker.setAttribute('role', 'listbox'); picker.setAttribute('aria-label', 'Mention a person'); picker.hidden = true;
      const hint = element('p', 'Type @ and a name to mention someone.', 'mention-hint');
      const button = element('button', 'Post note', 'btn primary'); button.type = 'submit';
      const status = element('p', null, 'msg'); status.setAttribute('role', 'status');
      input.id = 'ticket-note-text'; input.maxLength = 5000; input.rows = 4; input.required = true; input.style.width = '100%';
      input.setAttribute('aria-controls', picker.id); input.setAttribute('aria-expanded', 'false'); label.htmlFor = input.id;
      const draft = drafts.get(key) || {id: crypto.randomUUID(), text: '', mentions: []};
      drafts.set(key, draft);
      input.value = draft.text;
      let choices = [], active = 0, query = null;
      const people = result.people || [];
      const remember = () => { draft.text = input.value; };
      const close = () => { picker.hidden = true; choices = []; query = null; input.setAttribute('aria-expanded', 'false'); };
      const mark = () => { [...picker.querySelectorAll('[role=option]')].forEach((b, i) => b.setAttribute('aria-selected', String(i === active))); };
      function choose(index) {
        const person = choices[index], match = query;
        if (!person || !match) return;
        input.setRangeText('@' + person.name + ' ', match.start, match.end, 'end');
        if (!draft.mentions.some(m => m.email === person.email)) draft.mentions.push({name: person.name, email: person.email});
        close(); remember(); input.focus();
      }
      function openPicker(term) {
        const t = term.toLowerCase();
        choices = people.filter(p => p.name.toLowerCase().includes(t) || p.email.toLowerCase().startsWith(t)).slice(0, 8);
        active = 0; picker.replaceChildren();
        if (!choices.length) picker.append(element('div', 'No matching people. Try another name.', 'mention-message'));
        choices.forEach((p, i) => {
          const b = element('button', p.name, 'mention-option'); b.type = 'button'; b.id = 'note-mention-' + i; b.setAttribute('role', 'option'); b.tabIndex = -1;
          b.addEventListener('mousedown', e => e.preventDefault()); b.addEventListener('click', () => choose(i)); picker.append(b);
        });
        picker.hidden = false; input.setAttribute('aria-expanded', 'true'); mark();
      }
      input.addEventListener('input', () => {
        remember();
        const end = input.selectionStart, match = input.value.slice(0, end).match(/(?:^|\s)@([^@\n]{0,40})$/);
        if (!match) { close(); return; }
        query = {start: end - match[1].length - 1, end};
        openPicker(match[1].trim());
      });
      input.addEventListener('keydown', e => {
        if (picker.hidden) return;
        if (e.key === 'Escape') { e.preventDefault(); close(); }
        else if (choices.length && ['ArrowDown', 'ArrowUp', 'Enter'].includes(e.key)) {
          e.preventDefault();
          if (e.key === 'Enter') choose(active);
          else { active = (active + (e.key === 'ArrowDown' ? 1 : -1) + choices.length) % choices.length; mark(); }
        }
      });
      input.addEventListener('blur', () => setTimeout(() => { if (!picker.contains(document.activeElement)) close(); }, 0));
      form.append(label, input, picker, hint, button, status);
      panel.append(list, form);
      form.addEventListener('submit', async event => {
        event.preventDefault();
        const text = input.value.trim(); if (!text) return;
        // Only people whose @name is still in the text are notified.
        const mentioned = draft.mentions.filter(m => text.includes('@' + m.name));
        button.disabled = input.disabled = true; status.textContent = 'Posting…';
        try {
          await api('/ticket-notes', {method:'POST', body:{key, text, id: draft.id, mentions: [...new Set(mentioned.map(m => m.email))]}});
          drafts.delete(key);
          if (currentKey !== key || run !== generation) return;
          await load(key);
          if (currentKey === key) panel.prepend(element('p', mentioned.length ? 'Note posted. ' + mentioned.length + ' ' + (mentioned.length === 1 ? 'person' : 'people') + ' notified.' : 'Note posted.', 'msg'));
        } catch (error) { status.textContent = error.message || 'Could not post the note. Please retry.'; button.disabled = input.disabled = false; }
      });
    } catch (error) {
      if (run !== generation) return;
      const message = element('p', error.message || 'Could not load internal notes.', 'msg'); message.setAttribute('role', 'alert');
      const retry = element('button', 'Retry', 'btn'); retry.type = 'button'; retry.onclick = () => load(key); panel.replaceChildren(message, retry);
    }
  }
  return {load, dirty: key => !!drafts.get(key)?.text.trim(), reset: key => { drafts.delete(key); generation++; currentKey = null; }};
}
