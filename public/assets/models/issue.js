// The dashboard's existing data contract. These functions never authorize issues
// or map workflow names: callers supply data already authorized by the proxy.
export const isDevLabel = label => /^ai1_/i.test(label);
export const devOf = label => label.slice(4).toLowerCase();

export function labelsWith(labels, wanted) {
  const out = labels.filter(label => !isDevLabel(label)), have = new Set();
  labels.filter(isDevLabel).forEach(label => {
    const dev = devOf(label);
    if (wanted.has(dev) && !have.has(dev)) { out.push(label); have.add(dev); }
  });
  wanted.forEach(dev => { if (!have.has(dev)) out.push("ai1_" + dev); });
  return out;
}

export function withRendered(raw) {
  const r = raw.renderedFields || {}, f = Object.assign({}, raw.fields || {});
  f.description = typeof r.description === "string" ? r.description : (typeof f.description === "string" ? f.description : "");
  if (f.comment) {
    const rc = (r.comment && r.comment.comments) || [];
    f.comment = Object.assign({}, f.comment, { comments: (f.comment.comments || []).map((c, i) => Object.assign({}, c, {
      body: rc[i] && typeof rc[i].body === "string" ? rc[i].body : (typeof c.body === "string" ? c.body : "")
    })) });
  }
  return Object.assign({}, raw, { fields: f });
}

// toText is the existing DOM-based text sanitizer supplied by dashboard.js.
export function normalizeJiraIssue(raw, byId, toText) {
  const f = raw.fields || {}, labels = f.labels || [];
  const aid = f.assignee && f.assignee.accountId;
  const cm = (f.comment && f.comment.comments) || [], last = cm.length ? cm[cm.length - 1] : null;
  return {
    key: raw.key, summary: f.summary || "(no summary)",
    status: (f.status && f.status.name) || "", cat: (f.status && f.status.statusCategory && f.status.statusCategory.key) || "",
    assignee: byId[aid] || null, assigneeName: (f.assignee && f.assignee.displayName) || "Unassigned",
    labels, devs: [...new Set(labels.filter(isDevLabel).map(devOf))], due: f.duedate || null,
    created: (f.created || "").slice(0, 10), updated: f.updated || "",
    priority: (f.priority && f.priority.name) || "", type: (f.issuetype && f.issuetype.name) || "",
    reporter: (f.reporter && f.reporter.displayName) || "Unknown", reporterId: (f.reporter && f.reporter.accountId) || null, assigneeId: aid || null,
    parent: f.parent ? { key: f.parent.key, name: (f.parent.fields && f.parent.fields.summary) || f.parent.key } : null,
    last: last ? { author: (last.author && last.author.displayName) || "Someone", fromTeam: !!byId[last.author && last.author.accountId], when: last.created, text: toText(last.body) } : null
  };
}

export function normalizeInternalIssue(t, people) {
  const cm = t.comments || [], last = cm.length ? cm[cm.length - 1] : null;
  return {
    key: t.key, internal: true, summary: t.summary || "(no title)", status: t.status, cat: t.statusCat,
    assignee: people[t.assignee] ? t.assignee : null, assigneeName: people[t.assignee] ? people[t.assignee].name : "Unassigned",
    labels: (t.devs || []).map(d => "ai1_" + d), devs: (t.devs || []).slice(), due: t.due || null,
    created: (t.created || "").slice(0, 10), updated: t.updated || "", priority: t.priority || "", type: "Internal",
    reporter: (t.createdBy && t.createdBy.name) || "Unknown", reporterId: null,
    assigneeId: people[t.assignee] ? people[t.assignee].id : null, parent: null,
    last: last ? { author: (last.author && last.author.name) || "Someone", fromTeam: true, when: last.created, text: last.body } : null
  };
}
