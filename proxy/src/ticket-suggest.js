// Suggestions from similar past tickets: which developer should take a ticket, and whether it is billable.
// Pure functions only (no store or Jira calls), so the loader can be tested separately.
// Method: TF-IDF over summary, description, epic and labels, then a similarity-weighted vote over the
// candidates' developer labels or billing value. A suggestion is withheld when there is too little evidence.

const STOPWORDS = new Set(["the", "and", "for", "with", "that", "this", "from", "into", "not", "are", "was", "has", "have", "but", "its", "our", "you", "all", "any", "can", "will", "should", "when", "then", "via", "of", "to", "in", "on", "is", "it"]);

export const tokenize = (text) =>
  String(text || "")
    .toLowerCase()
    .match(/[a-z0-9]+/g)
    ?.filter((t) => t.length > 1 && !STOPWORDS.has(t)) || [];

// Labels are whole tokens, so they are weighted above words.
const LABEL_WEIGHT = 2;

function termCounts(ticket) {
  const counts = new Map();
  const add = (term, weight) => counts.set(term, (counts.get(term) || 0) + weight);
  for (const t of [...tokenize(ticket.summary), ...tokenize(ticket.description)]) add(t, 1);
  if (ticket.epic) add(`epic:${ticket.epic}`, 1);
  for (const label of ticket.labels || []) add(`label:${String(label).toLowerCase()}`, LABEL_WEIGHT);
  return counts;
}

// Builds a TF-IDF index over the corpus. Each document vector is L2-normalised, so the dot product is cosine similarity.
export function buildIndex(tickets) {
  const docs = tickets.map((ticket) => ({ ticket, counts: termCounts(ticket) }));
  const df = new Map();
  for (const { counts } of docs) for (const term of counts.keys()) df.set(term, (df.get(term) || 0) + 1);
  const n = docs.length;
  const idf = (term) => Math.log((n + 1) / ((df.get(term) || 0) + 1)) + 1;
  const vectorise = (counts) => {
    const vector = new Map();
    for (const [term, tf] of counts) if (df.has(term)) vector.set(term, tf * idf(term));
    const norm = Math.sqrt([...vector.values()].reduce((sum, w) => sum + w * w, 0));
    if (norm > 0) for (const [term, w] of vector) vector.set(term, w / norm);
    return vector;
  };
  return { docs: docs.map(({ ticket, counts }) => ({ ticket, vector: vectorise(counts) })), vectorise: (ticket) => vectorise(termCounts(ticket)) };
}

// Returns the top k corpus tickets most similar to the target, excluding the target itself.
export function rankSimilar(target, index, k = 10) {
  const query = index.vectorise(target);
  if (query.size === 0) return [];
  return index.docs
    .filter(({ ticket }) => ticket.key !== target.key)
    .map(({ ticket, vector }) => {
      let similarity = 0;
      for (const [term, w] of query) similarity += w * (vector.get(term) || 0);
      return { ticket, similarity };
    })
    .filter((c) => c.similarity > 0)
    .sort((a, b) => b.similarity - a.similarity || String(a.ticket.key).localeCompare(String(b.ticket.key)))
    .slice(0, k);
}

// Similarity-weighted vote. valuesOf(ticket) returns the values a candidate contributes (for example its developer labels,
// or [billing] when billing is set). Returns { value, confidence, evidence, reason }; value is null when the evidence is too thin.
export function vote(candidates, valuesOf, { minCandidates = 3, minConfidence = 0.5, maxEvidence = 5 } = {}) {
  const usable = candidates.filter((c) => valuesOf(c.ticket).length > 0);
  if (usable.length < minCandidates) return { value: null, confidence: 0, evidence: [], reason: "insufficient-data" };
  const scores = new Map();
  let total = 0;
  for (const c of usable) {
    total += c.similarity;
    for (const value of valuesOf(c.ticket)) scores.set(value, (scores.get(value) || 0) + c.similarity);
  }
  const [value, best] = [...scores].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])))[0];
  const confidence = Math.round((best / total) * 100) / 100;
  if (confidence < minConfidence) return { value: null, confidence, evidence: [], reason: "low-confidence" };
  const evidence = usable
    .filter((c) => valuesOf(c.ticket).includes(value))
    .slice(0, maxEvidence)
    .map((c) => c.ticket.key);
  return { value, confidence, evidence, reason: "similar-tickets" };
}

// Developer labels for a candidate: the ai1_ prefix is already stripped by the caller (normDev), so values are plain names.
export const developerValues = (ticket) => (ticket.devs || []).filter(Boolean);

// Billing value for a candidate, only when it is set. Other values are not treated as evidence.
export const billingValues = (ticket) => (ticket.billing === "billable" || ticket.billing === "not_billable" ? [ticket.billing] : []);
