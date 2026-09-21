import { HELP_CATEGORIES, HELP_FAQS } from "./help-content";

/**
 * Local search over the Help Centre's own content. No index service, no
 * request: the whole Help Centre is a few dozen short articles, and ranking
 * them in the browser is instant.
 *
 * A question is reduced to its meaningful words ("How do I connect my bank?"
 * → connect, bank), and each word is matched against the start of words in
 * a result — so "connect" finds "connecting" and "bank" finds "banks".
 * Matches in a title outweigh matches in keywords, which outweigh matches in
 * the body. A result must match at least half the words asked for, so one
 * common word cannot drag in everything.
 */

export interface HelpSearchResult {
  kind: "article" | "faq";
  /** The anchor on /help. FAQ anchors open their answer. */
  anchor: string;
  title: string;
  snippet: string;
  section: string;
  score: number;
}

const STOP_WORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "can", "could", "do", "does", "for", "from", "get", "how", "i", "if", "in",
  "is", "it", "its", "me", "my", "of", "on", "or", "should", "so", "that", "the", "their", "there", "this", "to", "use", "using",
  "was", "we", "what", "when", "where", "which", "who", "why", "will", "with", "would", "you", "your", "countorra",
]);

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .split(/[^a-z0-9&]+/)
    .filter(Boolean);
}

function queryTerms(query: string): string[] {
  const words = tokenize(query);
  const meaningful = words.filter((word) => !STOP_WORDS.has(word));
  // "How do I…" on its own still deserves an answer.
  return [...new Set(meaningful.length ? meaningful : words)];
}

interface Document {
  kind: HelpSearchResult["kind"];
  anchor: string;
  title: string;
  snippet: string;
  section: string;
  fields: { words: string[]; weight: number }[];
}

const DOCUMENTS: Document[] = [
  ...HELP_CATEGORIES.flatMap((category) =>
    category.articles.map(
      (article): Document => ({
        kind: "article",
        anchor: article.id,
        title: article.title,
        snippet: article.summary,
        section: category.title,
        fields: [
          { words: tokenize(article.title), weight: 6 },
          { words: tokenize((article.keywords ?? []).join(" ")), weight: 4 },
          { words: tokenize(article.summary), weight: 2 },
          { words: tokenize([...article.body, ...(article.points ?? []), article.where ?? ""].join(" ")), weight: 1 },
        ],
      }),
    ),
  ),
  ...HELP_FAQS.map(
    (faq): Document => ({
      kind: "faq",
      anchor: `faq-${faq.id}`,
      title: faq.question,
      snippet: faq.answer[0] ?? "",
      section: "FAQ",
      fields: [
        { words: tokenize(faq.question), weight: 6 },
        { words: tokenize((faq.keywords ?? []).join(" ")), weight: 4 },
        { words: tokenize([...faq.answer, ...(faq.points ?? [])].join(" ")), weight: 1 },
      ],
    }),
  ),
];

/**
 * The best match in each field, added up across fields: an article that is
 * about a word — in its title, keywords, summary and body — outranks one
 * that only mentions it in passing.
 */
function termScore(term: string, document: Document): number {
  let total = 0;
  for (const field of document.fields) {
    let best = 0;
    for (const word of field.words) {
      // Whole-word matches count fully; a word that merely starts with the
      // term ("connect" → "connecting") counts a little less.
      const score = word === term ? field.weight : word.startsWith(term) && term.length >= 3 ? field.weight * 0.75 : 0;
      if (score > best) best = score;
    }
    total += best;
  }
  return total;
}

export function searchHelp(query: string, limit = 8): HelpSearchResult[] {
  const terms = queryTerms(query);
  if (terms.length === 0) return [];
  const required = Math.ceil(terms.length / 2);

  return DOCUMENTS.map((document) => {
    const scores = terms.map((term) => termScore(term, document));
    const matched = scores.filter((score) => score > 0).length;
    const score = matched >= required ? scores.reduce((sum, value) => sum + value, 0) * (matched / terms.length) : 0;
    return { kind: document.kind, anchor: document.anchor, title: document.title, snippet: document.snippet, section: document.section, score };
  })
    .filter((result) => result.score > 0)
    .sort((a, b) => b.score - a.score || a.title.localeCompare(b.title))
    .slice(0, limit);
}
