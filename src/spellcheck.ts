import * as vscode from 'vscode';
// @ts-ignore -- no bundled types for this package
import nspell from 'nspell';
import { computeSkippedLines } from './latexUtils';

// TypeScript would normally rewrite a dynamic import() back into require()
// when compiling to CommonJS -- which fails here because dictionary-en v4+
// is ESM-only. Wrapping it in `new Function` hides it from that rewrite so
// it stays a genuine dynamic import at runtime.
const dynamicImport = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<any>;

export interface Misspelling {
  word: string;
  range: vscode.Range;
  suggestions: string[];
}

// Commands whose argument content is NOT prose (labels, keys, paths, urls) and
// should be skipped entirely rather than spellchecked.
// As exhaustive a list as practical of commands whose argument(s) are a
// machine-readable key/path/identifier rather than prose, grouped by what
// package family defines them. Command names are matched in lowercase (see
// getProseMask), so casing variants (Cref/cref, Gls/GLS/gls) collapse to
// one entry here. The substring fallback below (NON_PROSE_NAME_SUBSTRINGS)
// catches anything from a package not listed here by name.
const NON_PROSE_ARG_COMMANDS = new Set([
  // Citations -- natbib
  'cite', 'citep', 'citet', 'citeauthor', 'citeyear', 'citeyearpar',
  'citealt', 'citealp', 'citenum', 'citetext', 'nocite',
  // Citations -- biblatex
  'parencite', 'textcite', 'autocite', 'footcite', 'footcitetext',
  'fullcite', 'citetitle', 'citedate', 'citeurl', 'smartcite', 'cites',
  'parencites', 'textcites', 'autocites', 'supercite',
  // Cross-references -- hyperref/cleveref/varioref/fancyref
  'ref', 'eqref', 'pageref', 'autoref', 'nameref', 'subref', 'vref',
  'fref', 'cref', 'crefrange', 'labelcref',
  // Labels / bibliography item keys
  'label', 'bibitem',
  // Acronyms / glossaries
  'gls', 'glspl', 'glsxtr', 'acrshort', 'acrlong', 'acrfull', 'ac',
  'newacronym',
  // Hyperlinks
  'href', 'url', 'nolinkurl', 'hyperlink', 'hypertarget', 'phantomsection',
  // Includes / graphics / external files
  'includegraphics', 'input', 'include', 'includeonly', 'includepdf',
  'subfile', 'lstinputlisting',
  // Bibliography / package / class setup
  'bibliography', 'bibliographystyle', 'addbibresource', 'usepackage',
  'requirepackage', 'documentclass',
  // Macro / environment definitions -- all args skipped, including the
  // definition body, which is a known tradeoff: see Known limitations in
  // the README for the case where that body is itself genuine prose.
  'newcommand', 'renewcommand', 'providecommand', 'declaremathoperator',
  'newenvironment', 'renewenvironment', 'def', 'let', 'newcolumntype',
  // Layout / counters -- no prose content
  'setlength', 'addtolength', 'setcounter', 'addtocounter', 'pagestyle',
  'thispagestyle', 'pagenumbering',
  // Inline code
  'lstinline', 'mintinline',
  // Paths
  'path'
]);

// Command-name substrings that mean "this command's argument is a
// machine-readable key/path, not prose" regardless of which package
// defines it -- covers biblatex (textcite/parencite/autocite/footcite/...),
// cleveref (cref/Cref/crefrange/...), glossaries (gls/Gls/glspl/...), and
// hyperref (hyperlink/hypertarget/phantomsection) without needing an
// ever-growing exact list of every citation/cross-reference command every
// package might define. A rare false match here just means a genuinely
// prose-bearing custom command is skipped -- a much cheaper mistake than
// the reverse (a real citation/label key flagged as a typo).
const NON_PROSE_NAME_SUBSTRINGS = ['cite', 'ref', 'label', 'gls', 'hyperlink', 'hypertarget', 'phantomsection'];

function isNonProseCommand(name: string): boolean {
  if (NON_PROSE_ARG_COMMANDS.has(name)) return true;
  return NON_PROSE_NAME_SUBSTRINGS.some(s => name.includes(s));
}

// One nspell instance per locale, loaded lazily and cached -- so switching
// latexWritingCheck.dictionaryLocale mid-session works without a reload,
// and the (unused) other locale's dictionary is never loaded at all.
const spellCheckers = new Map<string, any>();
const loadingPromises = new Map<string, Promise<any>>();

function packageForLocale(locale: string): string {
  return locale === 'en-GB' ? 'dictionary-en-gb' : 'dictionary-en';
}

function loadDictionary(pkg: string): Promise<any> {
  return dynamicImport(pkg).then((mod: any) => {
    const dict = mod.default ?? mod;
    return nspell(dict);
  });
}

export async function getSpellChecker(context: vscode.ExtensionContext): Promise<any> {
  const locale = vscode.workspace.getConfiguration('latexWritingCheck').get<string>('dictionaryLocale', 'en-GB');
  const pkg = packageForLocale(locale);

  const cached = spellCheckers.get(pkg);
  if (cached) return cached;

  let loading = loadingPromises.get(pkg);
  if (!loading) {
    loading = loadDictionary(pkg).then(sp => {
      spellCheckers.set(pkg, sp);
      const custom = context.globalState.get<string[]>('latexWritingCheck.customDictionary', []);
      for (const word of custom) sp.add(word);
      return sp;
    });
    loadingPromises.set(pkg, loading);
  }
  return loading;
}

export async function addWordToDictionary(context: vscode.ExtensionContext, word: string): Promise<void> {
  const sp = await getSpellChecker(context);
  sp.add(word);
  const custom = context.globalState.get<string[]>('latexWritingCheck.customDictionary', []);
  if (!custom.includes(word)) {
    custom.push(word);
    await context.globalState.update('latexWritingCheck.customDictionary', custom);
  }
}

/**
 * Build a per-character prose mask for a line: true where the character is
 * part of actual prose that should be spellchecked, false where it's LaTeX
 * syntax, a command name, math, a comment, or a non-prose command argument
 * (citation key, label, file path, etc).
 *
 * This is a pragmatic single-pass scanner, not a full LaTeX parser -- it
 * handles the common cases (commands, one level of braces, inline math,
 * comments) well enough to keep false positives low, not perfectly.
 */
function getProseMask(line: string): boolean[] {
  const mask = new Array(line.length).fill(true);
  let i = 0;

  while (i < line.length) {
    const ch = line[i];

    // Comment (unescaped %) runs to end of line
    if (ch === '%' && line[i - 1] !== '\\') {
      for (let j = i; j < line.length; j++) mask[j] = false;
      break;
    }

    // Inline math: $...$
    if (ch === '$') {
      let j = i;
      mask[j] = false;
      j++;
      while (j < line.length && line[j] !== '$') { mask[j] = false; j++; }
      if (j < line.length) mask[j] = false;
      i = j + 1;
      continue;
    }

    // Line break \\
    if (ch === '\\' && line[i + 1] === '\\') {
      mask[i] = false; mask[i + 1] = false;
      i += 2;
      continue;
    }

    // Command: \name[opt]{arg}{arg}...
    if (ch === '\\') {
      let j = i + 1;
      mask[i] = false;
      const nameStart = j;
      while (j < line.length && /[a-zA-Z]/.test(line[j])) { mask[j] = false; j++; }
      const commandName = line.slice(nameStart, j).toLowerCase();

      if (line[j] === '*') { mask[j] = false; j++; }
      if (line[j] === '[') {
        mask[j] = false; j++;
        while (j < line.length && line[j] !== ']') { mask[j] = false; j++; }
        if (j < line.length) { mask[j] = false; j++; }
      }

      const skipArgs = isNonProseCommand(commandName);
      while (line[j] === '{') {
        mask[j] = false; // opening brace
        j++;
        let depth = 1;
        while (j < line.length && depth > 0) {
          if (line[j] === '{') depth++;
          else if (line[j] === '}') depth--;
          if (skipArgs || line[j] === '{' || (line[j] === '}' && depth === 0)) {
            mask[j] = false;
          }
          j++;
        }
      }
      i = j;
      continue;
    }

    // Stray braces (formatting commands' braces already consumed above;
    // this catches leftovers like grouping braces with no preceding command)
    if (ch === '{' || ch === '}') {
      mask[i] = false;
      i++;
      continue;
    }

    i++;
  }

  return mask;
}

// General-purpose English dictionaries (dictionary-en/-gb included) mark
// which prefixes/suffixes are productive for each individual word in their
// affix rules, and technical/academic vocabulary often just isn't covered
// even when the derivation is completely standard English morphology --
// "directed" is in the dictionary but "undirected" and "directedness"
// aren't, "computed" is but "precomputed" isn't, and so on. Rather than
// maintain a hand-picked wordlist of every technical term this might hit
// (which would need constant upkeep and still never be complete), this
// strips a common derivational prefix/suffix and accepts the word if the
// remaining stem is itself a real word -- covering any field's jargon that
// follows ordinary prefixing/suffixing, not just one dictionary's picks.
//
// This deliberately does NOT include inflectional endings (-s, -ed, -ing)
// -- general dictionaries already handle those natively via their own
// affix rules, so if "computeing" is flagged, it's an actual typo
// ("computing" is what was meant), not a coverage gap like the derivational
// cases above.
const DERIVATIONAL_PREFIXES = [
  'un', 'non', 'pre', 're', 'sub', 'super', 'inter', 'multi', 'co', 'post',
  'semi', 'mis', 'over', 'under', 'anti', 'pseudo', 'de'
];
const DERIVATIONAL_SUFFIXES = ['ness', 'ity', 'ism', 'ist', 'ize', 'ise', 'ify', 'less', 'ful', 'hood', 'ship'];

function isLikelyValidVariant(word: string, sp: any): boolean {
  const lower = word.toLowerCase();

  // Plural possessive: "algorithms'" = "algorithms" (a real word) + a bare
  // trailing apostrophe, standard English orthography with no exceptions.
  // Most dictionaries' affix rules generate the singular possessive
  // ("algorithm's") and the plain plural ("algorithms") but not this form,
  // so a perfectly correctly-punctuated plural possessive gets flagged as
  // if it were a typo of one of those two.
  if (lower.endsWith("s'") && sp.correct(lower.slice(0, -1))) return true;

  for (const prefix of DERIVATIONAL_PREFIXES) {
    if (lower.length > prefix.length + 2 && lower.startsWith(prefix)) {
      if (sp.correct(lower.slice(prefix.length))) return true;
    }
  }
  for (const suffix of DERIVATIONAL_SUFFIXES) {
    if (lower.length > suffix.length + 2 && lower.endsWith(suffix)) {
      const stem = lower.slice(0, -suffix.length);
      if (sp.correct(stem) || sp.correct(stem + 'e')) return true; // "-ize" etc. often drop a trailing "e"
    }
  }
  return false;
}

// Note: hyphens are deliberately excluded from the word-char class so that
// "low-resource" tokenizes as "low" and "resource" separately -- checking a
// hyphenated compound as one string against the dictionary almost always
// fails even when both halves are correctly spelled.
const WORD_RE = /[A-Za-z']+/g;

/**
 * Spellcheck the prose portions of a document range, returning one
 * Misspelling per flagged word with its exact range in the document.
 */
export async function spellcheckRange(
  context: vscode.ExtensionContext,
  document: vscode.TextDocument,
  range: vscode.Range
): Promise<Misspelling[]> {
  const sp = await getSpellChecker(context);
  const misspellings: Misspelling[] = [];
  const skippedLines = computeSkippedLines(document);

  for (let lineNum = range.start.line; lineNum <= range.end.line; lineNum++) {
    if (skippedLines.has(lineNum)) continue;
    const line = document.lineAt(lineNum).text;
    const mask = getProseMask(line);

    let match: RegExpExecArray | null;
    WORD_RE.lastIndex = 0;
    while ((match = WORD_RE.exec(line)) !== null) {
      const word = match[0];
      const start = match.index;
      const end = start + word.length;

      // Only check words that are entirely within prose (not command names,
      // not citation keys, etc).
      const inProse = mask.slice(start, end).every(Boolean);
      if (!inProse) continue;

      // Skip very short "words", acronyms/units (all caps, any length -- the
      // same "ignore words in UPPERCASE" behaviour Word has on by default,
      // so MCSPLIT/API/GPU aren't treated as English prose regardless of
      // how long the acronym is), and words with an internal capital that
      // isn't just the first letter (McSplit, PyTorch, TensorFlow, NetworkX,
      // BibTeX -- almost always a proper noun/product/algorithm name or a
      // code identifier, essentially never a real English word by accident,
      // so checking it against an English dictionary is the wrong move
      // even when it IS genuinely misspelled as a name).
      if (word.length < 3) continue;
      if (word === word.toUpperCase()) continue;
      if (word.slice(1) !== word.slice(1).toLowerCase()) continue;

      if (!sp.correct(word) && !isLikelyValidVariant(word, sp)) {
        const suggestions: string[] = sp.suggest(word).slice(0, 5);
        misspellings.push({
          word,
          range: new vscode.Range(lineNum, start, lineNum, end),
          suggestions
        });
      }
    }
  }

  return misspellings;
}
