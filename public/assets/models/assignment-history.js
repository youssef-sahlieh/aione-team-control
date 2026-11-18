// Labels, tones, filter rules and detail lines for the Mordi assignment-history indicator on All tickets.
// Pure functions only, so the rules can be tested without the dashboard.

export const HISTORY_FILTERS = [
  ["", "Any Mordi history"],
  ["ever", "Ever assigned to Mordi"],
  ["never", "Never assigned to Mordi"],
  ["unknown", "History unknown"]
];

// The result for one row. Internal and Odoo tickets have no Jira history, so they are "na", never "never".
export function historyResultFor(issue, entry) {
  if (issue.internal || issue.odoo || !/^[A-Z][A-Z0-9_]*-\d+$/.test(issue.key || "") || /^(INT|HD)-/.test(issue.key)) return { state: "na" };
  return entry && entry.result ? entry.result : { state: "unknown" };
}

export function historyView(result) {
  // Mordi as the reporter is a fact from the ticket itself, so it shows even when the assignee history is not known.
  if (result && result.reporterIsMordi && result.state !== "ever") return { state: result.state, label: "M: reporter", tone: "ever" };
  switch (result && result.state) {
    case "ever": return { state: "ever", label: "M: checked", tone: "ever" };
    case "never": return { state: "never", label: "M: notassigned", tone: "never" };
    case "na": return { state: "na", label: "", tone: "" };
    default: return { state: "unknown", label: "M: unknown", tone: "unknown" };
  }
}

// A filter of "" shows everything. Any other choice hides not-applicable tickets.
export function passesHistoryFilter(result, filter) {
  if (!filter) return true;
  return historyView(result).state === filter;
}

const when = (iso) => {
  if (!iso) return "";
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return "";
  return d.toLocaleString("en-GB", { timeZone: "Asia/Jerusalem", day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
};

// Lines for the details panel. Only dates the history actually gives are shown.
export function historyDetails(result) {
  const lines = [];
  if (!result || result.state === "na") return ["Not applicable: this ticket was not created in Jira, so it has no Jira assignment history."];
  if (result.reporterIsMordi) lines.push("Mordi is the reporter of this ticket.");
  if (result.state === "ever") lines.push("Mordi was assigned to this ticket.");
  else if (result.state === "never") lines.push("The complete Jira history was checked: Mordi was never assigned to this ticket.");
  else lines.push("Unknown: " + (result.reason || "the Jira history hasn't been checked."));
  for (const e of result.events || []) {
    if (e.kind === "creation") lines.push("Assigned to Mordi from creation" + (when(e.at) ? " (" + when(e.at) + ")" : "") + ".");
    else if (e.kind === "start") lines.push("Assigned to Mordi before " + (when(e.before) || "the first recorded change") + ".");
    else if (e.kind === "assigned") lines.push("Assigned to Mordi on " + (when(e.at) || "an unknown date") + (e.by ? " by " + e.by : "") + ".");
  }
  if (result.lastLeftAt) lines.push("Last moved away from Mordi on " + (when(result.lastLeftAt) || "an unknown date") + (result.lastLeftBy ? " by " + result.lastLeftBy : "") + ".");
  if (result.verifiedAt) lines.push("Jira history checked " + when(result.verifiedAt) + ".");
  return lines;
}

// "mordi:ever", "mordi:never" or "mordi:unknown" typed in the search box pick the Mordi history filter. The rest of
// the text is the normal search. Returns null when the text has no such word.
export function parseMordiSearch(text) {
  const src = String(text || "");
  const m = /(?:^|\s)mordi:(ever|never|unknown)(?=\s|$)/i.exec(src);
  if (!m) return null;
  const rest = (src.slice(0, m.index) + " " + src.slice(m.index + m[0].length)).replace(/\s+/g, " ").trim();
  return { filter: m[1].toLowerCase(), rest };
}
