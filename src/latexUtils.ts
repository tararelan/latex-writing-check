import * as vscode from 'vscode';

export interface ParagraphBlock {
  /** Cleaned prose text (commands/math stripped) sent to the model */
  text: string;
  /** Range in the original document this paragraph occupies */
  range: vscode.Range;
  /** Index of the top-level \section this paragraph falls under (0 = before the first \section) */
  sectionIndex: number;
}

// Environments whose contents are not prose and should be skipped entirely.
export const SKIP_ENVIRONMENTS = [
  'equation', 'equation*', 'align', 'align*', 'table', 'figure',
  'tabular', 'verbatim', 'lstlisting', 'minted', 'array', 'matrix'
];

// Citation commands are replaced with an explicit [CITATION] marker (rather
// than stripped like other commands) so the writing-quality model can tell
// whether a claim has a citation nearby, without seeing raw citation keys.
const CITATION_COMMANDS = ['cite', 'citep', 'citet', 'citeauthor', 'citeyear', 'nocite'];
const CITATION_PATTERN = new RegExp(
  `\\\\(?:${CITATION_COMMANDS.join('|')})\\*?(\\[[^\\]]*\\])?\\{[^{}]*\\}`,
  'g'
);

/**
 * Strip LaTeX commands, math, and comments from a line, leaving prose.
 * Deliberately simple (regex-based) rather than a full parser -- good
 * enough to stop a language model from being confused by markup, not
 * meant to be a compiler.
 */
function stripLatexMarkup(line: string): string {
  let s = line;

  // Comments
  s = s.replace(/(?<!\\)%.*$/, '');

  // Inline math $...$ and \(...\)
  s = s.replace(/\$[^$]*\$/g, ' ');
  s = s.replace(/\\\([^)]*\\\)/g, ' ');

  // Citations -> explicit marker, before the generic command stripping below
  // (otherwise the generic rule would just leave the raw citation key as text)
  s = s.replace(CITATION_PATTERN, ' [CITATION] ');

  // Commands with arguments: \command{arg} -> arg (keep the text, drop the command)
  // Repeated a few times to unwrap nested commands like \textbf{\emph{word}}
  for (let i = 0; i < 3; i++) {
    s = s.replace(/\\[a-zA-Z]+\*?(\[[^\]]*\])?\{([^{}]*)\}/g, '$2');
  }

  // Remaining commands with no braces (e.g. \noindent, \\)
  s = s.replace(/\\[a-zA-Z]+\*?/g, ' ');
  s = s.replace(/\\\\/g, ' ');

  // Leftover braces
  s = s.replace(/[{}]/g, '');

  return s.trim();
}

export function isEnvironmentBoundary(line: string): { begin?: string; end?: string } {
  const beginMatch = line.match(/\\begin\{([^}]+)\}/);
  const endMatch = line.match(/\\end\{([^}]+)\}/);
  return {
    begin: beginMatch ? beginMatch[1] : undefined,
    end: endMatch ? endMatch[1] : undefined
  };
}

/**
 * Every line number that falls inside a SKIP_ENVIRONMENTS block (table,
 * figure, equation/align math, verbatim/lstlisting/minted code, array,
 * matrix), including the \\begin{...}/\\end{...} lines themselves.
 *
 * extractParagraphs() already skips these for the writing-quality and
 * repetition checks, but spellcheck.ts scans lines directly rather than
 * going through paragraph blocks, so it needs this separately -- without
 * it, code inside a listing, numbers inside a table, and math inside
 * align/equation all get spellchecked character-by-character as if they
 * were prose, which is both wrong and (for a document with sizeable
 * tables or code listings) slow, since every "misspelled" token found
 * this way still pays for an nspell suggestion lookup.
 */
export function computeSkippedLines(document: vscode.TextDocument): Set<number> {
  const skipped = new Set<number>();
  let skipDepth = 0;

  for (let i = 0; i < document.lineCount; i++) {
    const line = document.lineAt(i).text;
    const { begin, end } = isEnvironmentBoundary(line);

    if (begin && SKIP_ENVIRONMENTS.includes(begin)) {
      skipped.add(i);
      skipDepth++;
      continue;
    }
    if (end && SKIP_ENVIRONMENTS.includes(end)) {
      skipped.add(i);
      skipDepth = Math.max(0, skipDepth - 1);
      continue;
    }
    if (skipDepth > 0) {
      skipped.add(i);
    }
  }

  return skipped;
}

/**
 * Split a document into paragraph blocks (blank-line separated), skipping
 * non-prose environments (math, tables, code listings, etc.), and strip
 * LaTeX markup down to prose text for each paragraph.
 */
export function extractParagraphs(document: vscode.TextDocument): ParagraphBlock[] {
  const blocks: ParagraphBlock[] = [];
  let skipDepth = 0;
  let sectionIndex = 0;

  let currentLines: string[] = [];
  let startLine = -1;

  const flush = (endLine: number) => {
    if (currentLines.length === 0) return;
    const cleaned = currentLines.map(stripLatexMarkup).join(' ').replace(/\s+/g, ' ').trim();
    // Skip paragraphs that are mostly markup noise (too short after cleaning)
    if (cleaned.length >= 20) {
      blocks.push({
        text: cleaned,
        range: new vscode.Range(startLine, 0, endLine, document.lineAt(endLine).text.length),
        sectionIndex
      });
    }
    currentLines = [];
    startLine = -1;
  };

  for (let i = 0; i < document.lineCount; i++) {
    const line = document.lineAt(i).text;
    const { begin, end } = isEnvironmentBoundary(line);

    if (begin && SKIP_ENVIRONMENTS.includes(begin)) {
      flush(i - 1);
      skipDepth++;
      continue;
    }
    if (end && SKIP_ENVIRONMENTS.includes(end)) {
      skipDepth = Math.max(0, skipDepth - 1);
      continue;
    }
    if (skipDepth > 0) {
      continue;
    }

    const isBlank = line.trim().length === 0;
    // Also treat preamble/structural-only lines (pure commands, e.g. \section{..})
    // as paragraph breaks so headings don't get glued to body text.
    const isNewSection = /^\s*\\section\b/.test(line);
    const isStructural = /^\s*\\(section|subsection|subsubsection|chapter|paragraph|title|author|maketitle|item)\b/.test(line);

    if (isBlank || isStructural) {
      flush(i - 1);
      if (isNewSection) {
        sectionIndex++;
      }
      if (isStructural) {
        // Structural lines themselves aren't prose we check; skip them.
        continue;
      }
    } else {
      if (startLine === -1) startLine = i;
      currentLines.push(line);
    }
  }
  flush(document.lineCount - 1);

  return blocks;
}

/** Find the current paragraph block containing the given position, if any. */
export function paragraphAt(document: vscode.TextDocument, position: vscode.Position): ParagraphBlock | undefined {
  const blocks = extractParagraphs(document);
  return blocks.find(b => b.range.contains(position));
}
