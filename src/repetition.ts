import { ParagraphBlock } from './latexUtils';

export interface DeterministicRepetitionIssue {
  /** Index into the paragraph-block array passed to findRepeatedSentences */
  paragraphIndex: number;
  /** Exact substring from that paragraph's cleaned text */
  quote: string;
  message: string;
}

// A deliberately small, generic stopword list -- just enough to keep function
// words from dominating the overlap score. Not exhaustive by design.
const STOPWORDS = new Set(
  `a an and are as at be been being but by for from has have had in into is it
   its itself of on or our so such than that the their this these they to was
   we were with about across against also no not all any more most some do
   does did he she his her him between over under while when where which who
   whom what`
    .trim()
    .split(/\s+/)
);

/**
 * Very small suffix stripper -- just enough to line up plurals/tenses of the
 * same word (outperformed/outperform, baseline/baselines, tested/tests)
 * without pulling in a real stemming library. Not linguistically rigorous.
 */
function stem(word: string): string {
  if (word.length > 4 && /ies$/.test(word)) return word.slice(0, -3) + 'y';
  if (word.length > 4 && /(s|x|z|ch|sh)es$/.test(word)) return word.slice(0, -2);
  if (word.length > 3 && word.endsWith('s') && !word.endsWith('ss')) return word.slice(0, -1);
  if (word.length > 5 && word.endsWith('ing')) return word.slice(0, -3);
  if (word.length > 4 && word.endsWith('ed')) return word.slice(0, -2);
  return word;
}

function contentWords(sentence: string): Set<string> {
  const words = sentence
    .toLowerCase()
    .replace(/\[citation\]/g, ' ')
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  const out = new Set<string>();
  for (const w of words) {
    if (w.length < 3 || STOPWORDS.has(w)) continue;
    out.add(stem(w));
  }
  return out;
}

/** |A ∩ B| / min(|A|, |B|) -- robust to one sentence being longer/shorter than the other. */
function overlapCoefficient(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const w of a) {
    if (b.has(w)) intersection++;
  }
  return intersection / Math.min(a.size, b.size);
}

/** Best-effort sentence split on cleaned prose. Not abbreviation-aware. */
function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+(?=[A-Z0-9"'(\[])/)
    .map(s => s.trim())
    .filter(s => s.length > 0);
}

// Tuned by hand against a few paraphrase examples: ~1.0 for a near-verbatim
// restatement, ~0.5-0.7 for a clear paraphrase of the same claim, ~0.15-0.3
// for two unrelated sentences on the same general topic.
const OVERLAP_THRESHOLD = 0.5;
const MIN_CONTENT_WORDS = 4;

/**
 * Deterministic, LLM-free detector for near-duplicate sentences within a
 * section: the same underlying point restated in different words. This is
 * the most common shape unwanted repetition takes in a paper draft, and it
 * does not depend on a small local model's semantic judgment to catch --
 * unlike checkSectionRepetition() in llmClient.ts, which asks the model
 * to notice reused *wording* across paragraphs and can miss a paraphrase,
 * and never looks for repetition between two sentences in the *same*
 * paragraph at all.
 *
 * Every sentence in the group is compared against every sentence that comes
 * before it (including earlier sentences in its own paragraph); the later
 * sentence is flagged when they share enough stopword-stripped, lightly
 * stemmed vocabulary.
 */
export function findRepeatedSentences(group: ParagraphBlock[]): DeterministicRepetitionIssue[] {
  interface Entry {
    paragraphIndex: number;
    sentence: string;
    words: Set<string>;
  }

  const entries: Entry[] = [];
  group.forEach((block, paragraphIndex) => {
    for (const sentence of splitSentences(block.text)) {
      const words = contentWords(sentence);
      if (words.size < MIN_CONTENT_WORDS) continue;
      entries.push({ paragraphIndex, sentence, words });
    }
  });

  const issues: DeterministicRepetitionIssue[] = [];
  for (let i = 1; i < entries.length; i++) {
    let best: { entry: Entry; score: number } | undefined;
    for (let j = 0; j < i; j++) {
      const score = overlapCoefficient(entries[i].words, entries[j].words);
      if (score >= OVERLAP_THRESHOLD && (!best || score > best.score)) {
        best = { entry: entries[j], score };
      }
    }
    if (best) {
      const preview =
        best.entry.sentence.length > 80 ? best.entry.sentence.slice(0, 77) + '...' : best.entry.sentence;
      issues.push({
        paragraphIndex: entries[i].paragraphIndex,
        quote: entries[i].sentence,
        message: `Restates a point already made in this section: "${preview}"`
      });
    }
  }
  return issues;
}
