# Details

The full reasoning behind specific behaviors in LaTeX Writing Check, split
out of the main README to keep that one skimmable. Nothing here changes
what the extension does - it's the "why," for anyone who wants it.

## Quick-fixes (lightbulb / `Ctrl+.`), in full

Every squiggle -- spelling or writing -- carries its fixes as a VS Code
quick-fix, not a command you run from the palette. Put your cursor
anywhere inside the squiggled text, then either click the 💡 lightbulb that
appears just above/beside it, or press `Ctrl+.` (`Cmd+.` on Mac).

**On a spelling squiggle** (warning, source "LaTeX Spell Check"):
- **"Add '\<word\>' to dictionary"** - adds the word to your personal
  dictionary (VS Code extension storage, persists across sessions); never
  flagged again, in this file or any other. Use this for names, jargon,
  and terminology that keeps coming up.
- **"Replace with '\<suggestion\>'"** - one entry per suggested correction
  (up to 3), only shown if the spellchecker found any.
- **"Ignore this suggestion"** - suppresses that exact flagged word
  without adding it to the dictionary.

**On a writing-quality squiggle** (hint, source "LaTeX Writing Check"):
just **"Ignore this suggestion"**, suppressing that exact flagged phrase
(matched on category + quoted text) for good.

There's also a palette command, **"LaTeX Writing Check: Add Word to
Dictionary"** - don't invoke it directly; it exists only to be called by
the quick-fix action above (which passes the specific word under your
cursor). Run with no word supplied, it does nothing.

## Choosing an LLM provider, in full

`latexWritingCheck.provider` picks which backend runs the grammar/passive/
wordy/unclear/uncited/repetition checks. This extension has no opinion on
whether using a particular third-party API is appropriate for your
situation (institutional policy, funder terms, whatever else might apply)
- that's yours to judge. What follows is the mechanical difference between
the options.

**Ollama** runs entirely on your own machine. Your paragraph text never
leaves it. No API key, no per-request cost, no internet connection needed
once the model is pulled. The tradeoff is quality and speed: a 1-2B local
model on a CPU is noticeably less sharp and slower than a frontier cloud
model (see "Why this size of model" below).

**OpenAI / Claude / Gemini / DeepSeek** send each paragraph's text (and,
for repetition, several paragraphs at once) to that provider's API over
the network, using an API key you provide:

- Your document's text leaves your machine and is processed by a third
  party under their terms, not this extension's. If your document contains
  unpublished work, anything under embargo, or anything else sensitive,
  that's worth weighing before switching off Ollama - and the four
  providers are not equivalent here (see PROVIDERS.md).
- Real per-token cost, billed to whichever account the API key belongs to
  - unlike Ollama, which is free once installed.
- Model quality/latency varies by provider and by which model you pick;
  this extension doesn't hardcode a recommendation.

Switching back to Ollama is just setting `latexWritingCheck.provider` back
to `"ollama"` - nothing about a stored cloud API key is lost, and no cloud
key is required to use Ollama.

### Guardrails around cloud providers

None of this applies to Ollama - it's local, nothing to confirm.

- The **first time** any check actually reaches a cloud provider's API in a
  given VS Code session, a confirmation dialog names the provider and
  explains that this will keep happening automatically while `checkOnType`
  is on, before anything is sent. Answering once covers the rest of that
  session; reopening the editor asks again.
- Before **"Check Whole Document"** or **"Check Selected Text"**
  specifically, a second dialog states how many calls that run is actually
  about to make (already-cached paragraphs/sections aren't counted). This
  is separate from the one above because going from "one paragraph as I
  type" to "forty calls right now" is worth a second look.
- Both are controlled by `latexWritingCheck.confirmCloudCalls` (default
  `true`).
- Cloud requests time out after 30 seconds (Ollama gets 60, since a slow
  local CPU is a different situation than a stalled network call).

## How it works

1. `latexUtils.ts` splits the document into paragraphs, skips non-prose
   environments (`equation`, `table`, `lstlisting`, etc.), and strips LaTeX
   commands/math down to plain prose text.
2. `llmClient.ts` picks the configured provider and sends the paragraph
   with a prompt asking for a strict JSON list of issues, parsing the
   response defensively since small models especially can wrap output in
   code fences or add stray text. Per-provider request/response handling
   (OpenAI-compatible chat completions for OpenAI and DeepSeek, Anthropic's
   Messages API for Claude, Google's `generateContent` for Gemini, Ollama's
   own `/api/chat`) lives in `llmProviders.ts`.
3. `extension.ts` locates each flagged quote back in the original document
   and draws it as a diagnostic, debounced and scoped to one paragraph at a
   time.
4. `spellcheck.ts` scans each line to build a "prose mask" - which
   characters are actual words vs. LaTeX syntax, math, or a non-prose
   command argument - then checks only the masked-in words via `nspell`.
   Whole lines inside a skipped environment (`table`, `figure`,
   `equation`/`align`, `verbatim`/`lstlisting`/`minted`, `array`/`matrix`)
   are excluded entirely.

## Recognized non-prose commands

Spelling deliberately does not check the argument of any command below --
these hold a citation key, a label, a file path, or similar, not prose.
Command names are matched case-insensitively. Anything not listed still
gets caught by a substring fallback if its name contains `cite`, `ref`,
`label`, `gls`, `hyperlink`, `hypertarget`, or `phantomsection`.

| Category | Commands |
|---|---|
| Citations (natbib) | `\cite`, `\citep`, `\citet`, `\citeauthor`, `\citeyear`, `\citeyearpar`, `\citealt`, `\citealp`, `\citenum`, `\citetext`, `\nocite` |
| Citations (biblatex) | `\parencite`, `\textcite`, `\autocite`, `\footcite`, `\footcitetext`, `\fullcite`, `\citetitle`, `\citedate`, `\citeurl`, `\smartcite`, `\cites`, `\parencites`, `\textcites`, `\autocites`, `\supercite` |
| Cross-references | `\ref`, `\eqref`, `\pageref`, `\autoref`, `\nameref`, `\subref`, `\vref`, `\fref`, `\cref`, `\crefrange`, `\labelcref` |
| Labels / bib keys | `\label`, `\bibitem` |
| Acronyms / glossaries | `\gls`, `\glspl`, `\glsxtr`, `\acrshort`, `\acrlong`, `\acrfull`, `\ac`, `\newacronym` |
| Hyperlinks | `\href`, `\url`, `\nolinkurl`, `\hyperlink`, `\hypertarget`, `\phantomsection` |
| Includes / graphics / files | `\includegraphics`, `\input`, `\include`, `\includeonly`, `\includepdf`, `\subfile`, `\lstinputlisting` |
| Bibliography / package / class setup | `\bibliography`, `\bibliographystyle`, `\addbibresource`, `\usepackage`, `\RequirePackage`, `\documentclass` |
| Macro / environment definitions* | `\newcommand`, `\renewcommand`, `\providecommand`, `\DeclareMathOperator`, `\newenvironment`, `\renewenvironment`, `\def`, `\let`, `\newcolumntype` |
| Layout / counters | `\setlength`, `\addtolength`, `\setcounter`, `\addtocounter`, `\pagestyle`, `\thispagestyle`, `\pagenumbering` |
| Inline code | `\lstinline`, `\mintinline` |
| Paths | `\path` |

\* All arguments are skipped for these, including the definition body --
so `\newcommand{\myterm}{Some prose default}` won't have "Some prose
default" checked either. Getting it right would mean knowing which
argument position holds the definition for each of these (they differ),
which isn't worth the complexity for how rarely a macro's default
expansion is meaningful, spelling-checkable prose.

Structural commands (`\section`, `\subsection`, `\chapter`, `\caption`,
`\title`, `\author`, `\footnote`, `\emph`, `\textbf`, `\textit`, ...) are
deliberately not on this list - their content genuinely is prose and is
spellchecked normally.

## Spelling: what gets skipped, and why

Modelled loosely on Microsoft Word's own spelling defaults, extended a bit
further for LaTeX/academic writing:

- **ALL-CAPS words, any length** - `MCSPLIT`, `API`, `GPU` are skipped
  outright, the same as Word's "Ignore words in UPPERCASE" (on by default).
- **Words with an internal capital letter** - `McSplit`, `PyTorch`,
  `TensorFlow`, `NetworkX`, `BibTeX` are skipped too, on the reasoning that
  a real English word essentially never has a capital letter partway
  through by accident. **This is not literally how Word behaves** - Word
  has no such rule, and would flag `McSplit` and rely on you adding it to
  your custom dictionary. The tradeoff: once a term matches this pattern, a
  genuine typo of it is also silently skipped, because it never reaches the
  dictionary check at all.
- **Plural possessives** (`algorithms'`, `results'`, `papers'`) - accepted
  if the word without the trailing apostrophe is valid. Most dictionaries'
  affix rules generate the singular possessive and the plain plural but not
  this form.
- **Derivational prefixes/suffixes** (`un-`, `pre-`, `re-`, `-ness`,
  `-ity`, `-ize`, ...) - a word like `undirected` or `precomputed` is
  accepted if stripping the prefix/suffix leaves a real word, even if the
  dictionary doesn't happen to list that exact derived form. Doesn't apply
  to simple inflection (`-s`/`-ed`/`-ing`) - dictionaries already handle
  that natively.

## Spelling dictionary / English locale

| Value | Variant | Package |
|---|---|---|
| `en-GB` (default) | British English | `dictionary-en-gb` |
| `en` | American English | `dictionary-en` |

Not supported yet: Australian, Canadian, South African, or other regional
variants. Each would need the same package added, a line in
`packageForLocale()` in `spellcheck.ts`, and a new enum value in
`package.json`.

## Performance ("Check Whole Document" is slow)

The writing-quality check is one LLM call per paragraph, sequential -- on
Ollama's CPU-only small model especially, a document with many paragraphs
can genuinely take a while. Mitigations:

- **Progress + cancel**: a cancellable progress notification instead of a
  silently spinning status bar.
- **Result caching**: results are cached by the exact paragraph/section
  text sent. Only what actually changed pays for a fresh call.
- **Scope it down**: "Check Selected Text" instead of the whole document.

What this doesn't do: parallelize in-flight requests. A single local
Ollama instance on a CPU generally processes requests one at a time
regardless; for a cloud provider it might help but adds real complexity
(rate limits, cost spikes, out-of-order UI updates) for limited benefit.

## Why this size of model

For Ollama specifically: 1.5B/1B instruct models are the smallest tier that
reliably follows a "return strict JSON" instruction. Anything smaller
tends to ignore the format or hallucinate issues. This keeps the whole
thing runnable on a normal laptop CPU with no GPU required, at the cost of
being less sharp than a frontier model. A cloud provider doesn't have this
constraint but brings the tradeoffs described above and in PROVIDERS.md.

## Troubleshooting

Status bar showing "\<provider\> unavailable", or an error mentioning
"fetch failed" or an HTTP status:

**Ollama:**

- **`ollama` not recognized (PowerShell)** - either not installed
  (`winget install Ollama.Ollama`, or [ollama.com/download](https://ollama.com/download)),
  or a stale terminal PATH after a fresh install. Open a new terminal, or
  run by full path: `& "$env:LOCALAPPDATA\Programs\Ollama\ollama.exe" list`.
- **"Ollama unavailable" again after it worked before** - Ollama isn't
  running; it doesn't auto-start as a service by default. Check the system
  tray, relaunch from the Start menu if missing.
- **"fetch failed"** - couldn't open a connection at all. Confirm Ollama is
  running (`ollama list`); if it is and other tools reach it fine but this
  extension doesn't, that's Node's `fetch` resolving `localhost` to IPv6
  first. `llmClient.ts` rewrites `localhost` to `127.0.0.1` automatically,
  so this shouldn't come up on a current build.
- **"404 Not Found"** - the exact model tag in `latexWritingCheck.model`
  isn't pulled. Tags are matched exactly (`qwen2.5` ≠ `qwen2.5:1.5b-instruct`).
  Run `ollama list`, then `ollama pull <tag>` if missing.

**Cloud providers:**

- **"latexWritingCheck.model must be set..."** - set `model` to a valid id
  for that provider; there's no default for cloud providers.
- **"No API key stored..."** - run "LaTeX Writing Check: Set API Key".
- **401/403** - the stored key is wrong, expired, or lacks permission;
  re-run "Set API Key".
- **404 / "model not found"** - the model id isn't one that provider
  currently serves.
- **429** - rate limit/quota hit; check that provider's dashboard.
- **"Request to \<provider\> timed out after 30s"** - a deliberate timeout,
  not a bug; retry or check your connection.
- **Confirmation dialogs are annoying** - set
  `latexWritingCheck.confirmCloudCalls` to `false`.

**Either way:**

- **Stuck at "Activating Extensions..." on a large document** - should not
  happen on a current build (non-prose environments are skipped before
  spellchecking); if it does, check for an unusually large table/listing.
- **Don't want to deal with any of this** - set `latexWritingCheck.enableLLM`
  to `false` for spelling + basic repetition detection with zero setup.

## Known limitations, in full

- Quote-matching to relocate issues in the source is exact-substring only;
  a paraphrased (not quoted) issue falls back to underlining the
  paragraph's first line.
- Custom dictionary is a flat accept-list; no automatic domain-term import
  from `.bib`/existing files yet.
- The prose-mask scanner handles one level of braces and common command
  patterns well but isn't a full LaTeX parser.
- Only British and American English dictionaries are wired up.
- No hardcoded default model id for any cloud provider, by design.
- No automated test suite (fixes verified against hand-written examples,
  and cloud-provider request/response handling against each provider's
  documented API shape with a mocked `fetch`, during development).
