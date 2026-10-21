import { createCommentMentions } from './comment-mentions.js';
const element = (tag, text, className) => {const node = document.createElement(tag); if (text) node.textContent = text; if (className) node.className = className; return node;};
const when = value => new Date(value).toLocaleString();

// Internal notes on a ticket: a team thread inside AION (not email, not Jira). Type @ to mention someone; they get a
// notification in the bell.
export function createTicketNotes({api}) {
  const panel = document.getElementById('panel-notes');
  let currentKey, generation = 0;
  const drafts = new Map();
  async function load(key) {
    currentKey = key;
    const run = ++generation;
    panel.replaceChildren(element('p', 'Loading internal notes…', 'msg'));
    try {
      const result = await api('/ticket-notes?key='+encodeURIComponent(key));
      if (run !== generation) return;
      panel.replaceChildren(element('h3', 'Internal notes'), element('p', 'Private notes between the team. Type @ to mention someone and they get an email and a notification. These are not Jira comments.', 'msg'));
      const list = element('div');
      for (const note of result.notes.slice().reverse()) {
        const card = element('article', null, 'blk');
        card.append(element('strong', note.author.name + (note.author.dev ? ' · '+note.author.dev : '')), element('p', when(note.createdAt), 'msg'));
        const text = element('p', note.text); text.style.whiteSpace = 'pre-wrap'; text.style.overflowWrap = 'anywhere'; card.append(text);
        if (note.mentions?.length) card.append(element('p', 'Mentioned: ' + note.mentions.map(m => '@' + m.name).join(', '), 'msg'));
        list.append(card);
      }
      if (!result.notes.length) list.append(element('p', 'No internal notes yet.', 'msg'));
      // Same composer as the Comments tab: a plain textarea and one button. No recipient list; @ mentions do the notifying.
      const form = element('form'), input = element('textarea', null, 'inp');
      const button = element('button', 'Add note', 'btn primary'); button.type = 'submit';
      const status = element('p', null, 'msg'); status.setAttribute('role', 'status');
      input.id = 'ticket-note-text'; input.placeholder = 'Write an internal note…'; input.setAttribute('aria-label', 'New internal note'); input.dir = 'auto'; input.maxLength = 5000; input.rows = 3; input.required = true;
      const draft = drafts.get(key) || {id: crypto.randomUUID(), text: ''};
      drafts.set(key, draft);
      input.value = draft.text;
      input.addEventListener('input', () => { draft.text = input.value; });
      // The shared @ picker lists everyone in the dashboard except yourself; mentioned() gives the emails still in the text.
      const people = result.people || [];
      form.append(input, button, status);
      panel.append(list, form);
      // The picker is inserted after the textarea, so the form must be in the panel first.
      const mentions = createCommentMentions({textarea:input, enabled:() => true, local:() => true, people:async () => people, localHint:'Type @ to mention someone. They get an email and a notification.'});
      form.addEventListener('submit', async event => {
        event.preventDefault();
        const text = mentions.text(); if (!text) return;
        const mentionEmails = mentions.mentioned();
        button.disabled = input.disabled = true; status.textContent = 'Posting…';
        try {
          await api('/ticket-notes', {method:'POST', body:{key, text, id: draft.id, mentions: mentionEmails}});
          drafts.delete(key);
          if (currentKey !== key || run !== generation) return;
          await load(key);
          if (currentKey === key) panel.prepend(element('p', mentionEmails.length ? 'Note posted. ' + mentionEmails.length + ' ' + (mentionEmails.length === 1 ? 'person' : 'people') + ' notified.' : 'Note posted.', 'msg'));
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
