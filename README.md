# LaTeX Writing Check

A VS Code extension for LaTeX writers: spelling, grammar/passive/wordy/
unclear/uncited-claim checks, and repeated-phrasing detection, all aware of
LaTeX syntax so it doesn't flag citation keys, labels, file paths, math, or
code as prose.

## Features

- **Spelling** — local, instant, dictionary-based (British or American
  English). Skips LaTeX commands, math, tables, code listings, and
  non-prose command arguments automatically, so it only ever checks actual
  prose.
- **Passive voice & wordy phrasing** — local, rule-based pattern matching,
  no LLM or setup needed. Always on.
- **Grammar, unclear sentences, and uncited claims** — backed by an LLM.
  Pick whichever fits: [Ollama](https://ollama.com) locally (free,
  private), a small bundled local model that downloads itself on first use
  (free, private, nothing else to install), GitHub Copilot via VS Code's
  own Language Model API (if you already have it), or your own API key for
  OpenAI, Claude, Gemini, or DeepSeek.
- **Repetition detection** — flags a point restated in different words
  within the same section, both deterministically (no LLM needed) and,
  optionally, with an extra LLM pass for reused phrasing.
- **Quick-fixes** for every squiggle via the lightbulb / `Ctrl+.` — add a
  word to your dictionary, accept a suggested correction, or dismiss a
  specific suggestion for good.

## Requirements

- VS Code 1.93+. Registers `.tex`/`.latex`/`.ltx` itself, so it works
  without any other LaTeX extension installed (though you'll still want one
  for compiling/preview).
- Spelling and passive/wordy checks need nothing extra and work out of the
  box.
- Grammar, unclear-sentence, and uncited-claim checks (plus the extra LLM
  pass on repetition) need one backend: Ollama, the bundled local model,
  Copilot, or your own cloud API key — see Setup below. You can also turn
  these off entirely (`latexWritingCheck.enableLLM: false`) and just get
  spelling + passive/wordy + basic repetition detection, no setup required.

## Setup

Pick one of these for `latexWritingCheck.provider` (default is `ollama`):

**Option A — Ollama (local, free):**

```bash
ollama pull qwen2.5:1.5b-instruct
```
Make sure Ollama is running (`ollama serve`, or it runs as a background
service after install). This is the default — nothing else to configure.

**Option B — bundled local model (`provider: "bundled"`), nothing to
install separately:** just set the provider. The first check downloads a
small model (~1GB, one-time, with a cancellable progress notification)
into this extension's own storage and runs it locally from then on — no
separate app, no PATH setup.

**Option C — GitHub Copilot (`provider: "copilot"`):** if you already
have Copilot Chat installed and signed in, just set the provider. VS Code
picks the model and handles its own consent prompt; no API key or
`latexWritingCheck.model` needed.

**Option D — your own API key** for OpenAI, Claude, Gemini, or DeepSeek:

1. Run **"LaTeX Writing Check: Set API Key"** from the command palette and
   paste your key (stored securely via VS Code, never in `settings.json`).
2. Set `latexWritingCheck.provider` to that provider.
3. Set `latexWritingCheck.model` to a model id that provider currently
   supports (there's no default for cloud providers — model names change
   too often to hardcode reliably).

Sending your document's text to a third-party API (Option C or D) is a
real tradeoff worth understanding before you flip that switch — see
[`docs/PROVIDERS.md`](docs/PROVIDERS.md) for what each provider's policy
actually says about training and data retention, and what guardrails this
extension puts around it either way. Options A and B never send your text
anywhere.

## Usage

Open a `.tex` file — the current paragraph is checked automatically a
couple of seconds after you stop typing. From the command palette:

- **Check Whole Document** — full pass: writing quality, spelling, and
  repetition.
- **Check Current Paragraph** — just the paragraph your cursor is in.
- **Check Selected Text** — just what you've highlighted (repetition still
  compares against the whole document, since it needs that context).

To act on a squiggle, put your cursor in it and press `Ctrl+.` (`Cmd+.` on
Mac) or click the lightbulb.

## Configuration

Settings (`Ctrl+,` → search "latex writing check"):

| Setting | Default | Notes |
|---|---|---|
| `latexWritingCheck.provider` | `ollama` | `ollama`, `bundled`, `copilot`, `openai`, `claude`, `gemini`, or `deepseek` |
| `latexWritingCheck.model` | `qwen2.5:1.5b-instruct` | Ollama model tag, or (required, no default) a model id for a cloud provider. Not used for `bundled`/`copilot`. |
| `latexWritingCheck.ollamaUrl` | `http://127.0.0.1:11434` | Only used when `provider` is `ollama` |
| `latexWritingCheck.enableLLM` | `true` | Master switch for the LLM-backed checks (grammar/unclear/uncited + extra repetition pass) |
| `latexWritingCheck.confirmCloudCalls` | `true` | Confirmation dialogs before sending anything to `copilot` or a cloud API key provider. No effect for `ollama`/`bundled`. |
| `latexWritingCheck.dictionaryLocale` | `en-GB` | `en-GB` (British) or `en` (American) |
| `latexWritingCheck.checkOnType` / `checkOnSave` | `true` | Automatic checking triggers |
| `latexWritingCheck.enablePassive` / `enableWordy` | `true` | Rule-based, always available regardless of `enableLLM`/`provider` |
| `latexWritingCheck.enableGrammar` / `enableUnclear` / `enableUncited` / `enableRepetition` | `true` | LLM-backed, per-category on/off |

API keys aren't a setting — use **"LaTeX Writing Check: Set API Key"** /
**"...: Clear API Key"** from the command palette.

## Known limitations

- Only British and American English dictionaries are included; other
  regional variants aren't wired up yet.
- Custom dictionary is a flat accept-list (via the quick-fix), not
  imported from your `.bib`/existing files.
- Passive/wordy detection is pattern matching, not a parser — it can have
  false positives/negatives; dismiss a wrong one via "Ignore this
  suggestion".
- The bundled local model needs its native module (`node-llama-cpp`)
  installed with the correct platform binary — run `npm install` in a real
  shell on the machine you're packaging/running for, not inside a
  Linux-based sandbox/VM, or it won't have a matching binary at runtime.
- No automated test suite yet.

## More detail

For the reasoning behind specific behaviors (why certain word shapes are
skipped when spellchecking, the full list of recognized non-prose LaTeX
commands, performance/caching internals, cloud-provider privacy specifics,
and detailed troubleshooting), see [`docs/DETAILS.md`](docs/DETAILS.md).

## License

MIT
