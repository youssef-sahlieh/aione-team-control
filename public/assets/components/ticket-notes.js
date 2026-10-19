const element = (tag, text, className) => {const node = document.createElement(tag); if (text) node.textContent = text; if (className) node.className = className; return node;};
export function createTicketNotes({api, isAdmin}) {
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
      panel.replaceChildren(element('h3', 'Internal notes'), element('p', isAdmin ? 'Private notes sent to admins. These are not Jira comments.' : 'Send a private note to admins. Only you and admins can see your notes.', 'msg'));
      const list = element('div');
      for (const note of result.notes.slice().reverse()) {
        const card = element('article', null, 'blk');
        card.append(element('strong', note.author.name + (note.author.dev ? ' · '+note.author.dev : '')), element('p', new Date(note.createdAt).toLocaleString(), 'msg'));
        const text = element('p', note.text); text.style.whiteSpace = 'pre-wrap'; text.style.overflowWrap = 'anywhere'; card.append(text);
        if (note.recipients?.length) card.append(element('p','Sent to: '+note.recipients.map(r => r.name).join(', '),'msg'));
        if (note.notification !== 'sent') card.append(element('p', 'Saved; admin email delivery was not confirmed.', 'msg'));
        list.append(card);
      }
      if (!result.notes.length) list.append(element('p','No internal notes yet.','msg'));
      const form = element('form'), label = element('label','Note to admins'), input = element('textarea');
      const recipientField = element('fieldset'), legend = element('legend','Send to'); recipientField.append(legend);
      const choices = [];
      for (const recipient of result.recipients || []) {
        const row = element('label'), checkbox = element('input'); checkbox.type = 'checkbox'; checkbox.value = recipient.email;
        checkbox.checked = drafts.get(key)?.recipients ? drafts.get(key).recipients.includes(recipient.email) : recipient.role !== 'user';
        row.append(checkbox,document.createTextNode(' '+recipient.name)); row.style.display = 'block'; recipientField.append(row); choices.push(checkbox);
      }
      const remember = () => drafts.set(key,{text:input.value,recipients:choices.filter(c => c.checked).map(c => c.value),id:crypto.randomUUID()});
      choices.forEach(c => c.addEventListener('change',remember));
      input.id = 'ticket-note-text'; input.maxLength = 5000; input.rows = 4; input.required = true; input.style.width = '100%'; label.htmlFor = input.id;
      input.value = drafts.get(key)?.text || '';
      input.addEventListener('input', remember);
      const button = element('button','Send to admins','btn primary'); button.type = 'submit';
      const status = element('p',null,'msg'); status.setAttribute('role','status');
      if (!choices.length) {button.disabled = true;status.textContent = 'No admin recipients are configured. Ask an administrator to check the Users page.';}
      form.append(recipientField,label,input,button,status); panel.append(list,form);
      form.addEventListener('submit',async event => {
        event.preventDefault(); if (!input.value.trim()) return;
        const draft = drafts.get(key) || {text:input.value,recipients:choices.filter(c => c.checked).map(c => c.value),id:crypto.randomUUID()}; drafts.set(key,draft);
        if (!draft.recipients.length) {status.textContent = 'Choose at least one administrator.';return;}
        button.disabled = input.disabled = true; status.textContent = 'Sending…';
        try {
          const saved = await api('/ticket-notes',{method:'POST',body:{key,text:draft.text,id:draft.id,recipients:draft.recipients}});
          drafts.delete(key);
          if (currentKey !== key || run !== generation) return;
          await load(key);
          if (currentKey === key) panel.prepend(element('p',saved.note.notification === 'sent' ? 'Note saved and emailed to admins.' : 'Note saved. Admin email delivery was not confirmed.','msg'));
        } catch(error) {status.textContent = error.message || 'Could not send the note. Please retry.'; button.disabled = input.disabled = false;}
      });
    } catch(error) {
      if (run !== generation) return;
      const message = element('p',error.message || 'Could not load internal notes.','msg'); message.setAttribute('role','alert');
      const retry = element('button','Retry','btn'); retry.type = 'button'; retry.onclick = () => load(key); panel.replaceChildren(message,retry);
    }
  }
  return {load, dirty:key => !!drafts.get(key)?.text.trim(), reset:key => {drafts.delete(key); generation++; currentKey = null;}};
}
