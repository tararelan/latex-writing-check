# LaTeX Writing Check

A VS Code extension for LaTeX writers: spelling, grammar/passive/wordy/
unclear/uncited-claim checks, and repeated-phrasing detection, all aware of
LaTeX syntax so it doesn't flag citation keys, labels, file paths, math, or
code as prose.

## Features

- **Spelling** - local, instant, dictionary-based (British or American
  English). Skips LaTeX commands, math, tables, code listings, and
  non-prose command arguments automatically, so it only ever checks actual
  prose.
- **Writing quality** - grammar, unnecessary passive voice, wordiness,
  unclear sentences, and factual claims with no nearby citation. Backed by
  an LLM: [Ollama](https://ollama.com) locally by default (free, private),
  or your own API key for OpenAI, Claude, Gemini, or DeepSeek.
- **Repetition detection** - flags a point restated in different words
  within the same section, both deterministically (no LLM needed) and,
  optionally, with an extra LLM pass for reused phrasing.
- **Quick-fixes** for every squiggle via the lightbulb / `Ctrl+.` - add a
  word to your dictionary, accept a suggested correction, or dismiss a
  specific suggestion for good.

## Requirements

- VS Code 1.85+. Registers `.tex`/`.latex`/`.ltx` itself, so it works
  without any other LaTeX extension installed (though you'll still want one
  for compiling/preview).
- An LLM backend for the writing-quality and repetition checks: either
  [Ollama](https://ollama.com) running locally (free), or your own API key
  for a cloud provider. Spelling needs neither.
- You can turn the LLM checks off entirely (`latexWritingCheck.enableLLM:
  false`) and just get spelling + basic repetition detection, no setup
  required.

## Setup

**Option A - Ollama (local, free):**

```bash
ollama pull qwen2.5:1.5b-instruct
```
Make sure Ollama is running (`ollama serve`, or it runs as a background
service after install).

**Option B - your own API key** for OpenAI, Claude, Gemini, or DeepSeek:

1. Run **"LaTeX Writing Check: Set API Key"** from the command palette and
   paste your key (stored securely via VS Code, never in `settings.json`).
2. Set `latexWritingCheck.provider` to that provider (`openai`, `claude`, `gemini`, `deepseek`).
3. Set `latexWritingCheck.model` to a model id that provider currently
   supports.

Sending your document's text to a third-party API is a tradeoff
worth understanding before you flip that switch - see
[`docs/PROVIDERS.md`](docs/PROVIDERS.md) for what each provider's policy
actually says about training and data retention, and what guardrails this
extension puts around it either way.

## Usage

Open a `.tex` file - the current paragraph is checked automatically a
couple of seconds after you stop typing. From the command palette:

- **Check Whole Document** - full pass: writing quality, spelling, and
  repetition.
- **Check Current Paragraph** - just the paragraph your cursor is in.
- **Check Selected Text** - just what you've highlighted (repetition still
  compares against the whole document, since it needs that context).

To act on a squiggle, put your cursor in it and press `Ctrl+.` (`Cmd+.` on
Mac) or click the lightbulb.

## Configuration

Settings (`Ctrl+,` → search "latex writing check"):

| Setting | Default | Notes |
|---|---|---|
| `latexWritingCheck.provider` | `ollama` | `ollama`, `openai`, `claude`, `gemini`, or `deepseek` |
| `latexWritingCheck.model` | `qwen2.5:1.5b-instruct` | Ollama model tag, or (required, no default) a model id for a cloud provider |
| `latexWritingCheck.ollamaUrl` | `http://127.0.0.1:11434` | Only used when `provider` is `ollama` |
| `latexWritingCheck.enableLLM` | `true` | Master switch for all LLM-backed checks |
| `latexWritingCheck.confirmCloudCalls` | `true` | Confirmation dialogs before sending anything to a cloud provider |
| `latexWritingCheck.dictionaryLocale` | `en-GB` | `en-GB` (British) or `en` (American) |
| `latexWritingCheck.checkOnType` / `checkOnSave` | `true` | Automatic checking triggers |
| `latexWritingCheck.enableGrammar` / `enablePassive` / `enableWordy` / `enableUnclear` / `enableUncited` / `enableRepetition` | `true` | Per-category on/off |

API keys aren't a setting - use **"LaTeX Writing Check: Set API Key"** /
**"...: Clear API Key"** from the command palette.

## Known limitations

- Only British and American English dictionaries are included; other
  regional variants aren't wired yet.
- Custom dictionary is a flat accept-list (via the quick-fix), not
  imported from your `.bib`/existing files.
- No automated test suite yet.

## More detail

For the reasoning behind specific behaviors (why certain word shapes are
skipped when spellchecking, the full list of recognized non-prose LaTeX
commands, performance/caching internals, cloud-provider privacy specifics,
and detailed troubleshooting), see [`docs/DETAILS.md`](docs/DETAILS.md).

## License

MIT
