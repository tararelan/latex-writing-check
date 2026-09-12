import { WritingIssue } from './llmClient';

// ---------- Passive voice ----------
// Heuristic, not a real parser: matches a form of "to be" followed
// (optionally with a short word or two in between, e.g. "was clearly
// shown") by a past participle -- either a regular "-ed" one or one of the
// common irregular participles below. This will have some false positives
// (e.g. "is interested", where "interested" is really an adjective) and
// some false negatives (an irregular participle not in the list, or a
// be-verb and participle separated by more than a couple of words) -- it's
// a zero-setup, no-LLM substitute for the judgment an LLM check would
// apply, not a replacement for one. Any false positive can be dismissed
// with the existing "Ignore this suggestion" quick fix, same as any other
// diagnostic this extension produces.
const BE_FORMS = ['am', 'is', 'are', 'was', 'were', 'be', 'been', 'being'];

const IRREGULAR_PARTICIPLES = [
  'written', 'given', 'shown', 'taken', 'made', 'done', 'seen', 'known',
  'found', 'held', 'built', 'sent', 'spent', 'told', 'taught', 'brought',
  'thought', 'bought', 'caught', 'chosen', 'driven', 'drawn', 'fallen',
  'forgotten', 'grown', 'hidden', 'ridden', 'risen', 'spoken', 'stolen',
  'torn', 'worn', 'broken', 'frozen', 'gotten', 'proven', 'said', 'paid',
  'laid', 'meant', 'put', 'set', 'read', 'understood', 'begun', 'become',
  'come', 'run', 'gone', 'lost', 'won', 'felt', 'left', 'met', 'sold',
  'sat', 'stood', 'heard', 'led', 'kept'
];

const PASSIVE_RE = new RegExp(
  `\\b(?:${BE_FORMS.join('|')})\\b` +
    `(?:\\s+\\w+){0,2}?` + // up to two words in between, e.g. "was not clearly shown"
    `\\s+(?:\\w+ed|${IRREGULAR_PARTICIPLES.join('|')})\\b`,
  'gi'
);

function detectPassive(text: string): WritingIssue[] {
  const issues: WritingIssue[] = [];
  const seen = new Set<string>();
  for (const match of text.matchAll(PASSIVE_RE)) {
    const quote = match[0].trim();
    const key = quote.toLowerCase();
    if (seen.has(key)) continue; // same phrasing repeated in one paragraph -- one diagnostic is enough
    seen.add(key);
    issues.push({
      quote,
      category: 'passive',
      message: 'Passive voice -- consider rewriting in active voice if who/what is doing this matters.'
    });
    if (issues.length >= 5) break;
  }
  return issues;
}

// ---------- Wordy phrasing ----------
// A maintained list of common academic-writing filler phrases and a
// tighter replacement for each (empty suggestion means "just cut this").
// Purely a lookup, no judgment involved -- exactly the kind of check that
// doesn't need an LLM.
const WORDY_PHRASES: Array<{ phrase: string; suggestion: string }> = [
  { phrase: 'due to the fact that', suggestion: 'because' },
  { phrase: 'in spite of the fact that', suggestion: 'although' },
  { phrase: 'on the grounds that', suggestion: 'because' },
  { phrase: 'in order to', suggestion: 'to' },
  { phrase: 'in order for', suggestion: 'for' },
  { phrase: 'a large number of', suggestion: 'many' },
  { phrase: 'a small number of', suggestion: 'few' },
  { phrase: 'a majority of', suggestion: 'most' },
  { phrase: 'at this point in time', suggestion: 'now' },
  { phrase: 'in the event that', suggestion: 'if' },
  { phrase: 'in the near future', suggestion: 'soon' },
  { phrase: 'with regard to', suggestion: 'regarding' },
  { phrase: 'with respect to', suggestion: 'regarding' },
  { phrase: 'for the purpose of', suggestion: 'for' },
  { phrase: 'in the process of', suggestion: '' },
  { phrase: 'it is important to note that', suggestion: '' },
  { phrase: 'it should be noted that', suggestion: '' },
  { phrase: 'in a manner that is', suggestion: 'that is' },
  { phrase: 'has the ability to', suggestion: 'can' },
  { phrase: 'is able to', suggestion: 'can' },
  { phrase: 'in the majority of cases', suggestion: 'usually' },
  { phrase: 'a total of', suggestion: '' },
  { phrase: 'the fact that', suggestion: 'that' },
  { phrase: 'utilize', suggestion: 'use' },
  { phrase: 'utilizes', suggestion: 'uses' },
  { phrase: 'utilizing', suggestion: 'using' }
];

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function detectWordy(text: string): WritingIssue[] {
  const issues: WritingIssue[] = [];
  const matchedRanges: Array<[number, number]> = [];

  // Longest phrase first, so "due to the fact that" claims its match before
  // the shorter "the fact that" gets a chance to also match inside it --
  // otherwise a single wordy phrase could surface as two overlapping,
  // redundant diagnostics.
  const sorted = [...WORDY_PHRASES].sort((a, b) => b.phrase.length - a.phrase.length);

  for (const { phrase, suggestion } of sorted) {
    const re = new RegExp(`\\b${escapeRegExp(phrase)}\\b`, 'i');
    const match = text.match(re);
    if (!match || match.index === undefined) continue;

    const start = match.index;
    const end = start + match[0].length;
    if (matchedRanges.some(([s, e]) => start < e && end > s)) continue;
    matchedRanges.push([start, end]);

    issues.push({
      quote: match[0],
      category: 'wordy',
      message: suggestion
        ? `Wordy phrasing -- consider "${suggestion}" instead.`
        : 'Wordy phrasing -- consider cutting this.',
      suggestion: suggestion || undefined
    });
    if (issues.length >= 5) break;
  }
  return issues;
}

/**
 * Local, no-LLM detection for passive voice and wordy phrasing. Runs
 * regardless of latexWritingCheck.enableLLM / provider -- unlike grammar,
 * unclear-sentence, and uncited-claim detection, these two don't need an
 * LLM's semantic judgment, just pattern matching, so they now work with
 * zero setup the same way spelling already does.
 */
export function checkRuleBased(text: string): WritingIssue[] {
  return [...detectPassive(text), ...detectWordy(text)];
}
