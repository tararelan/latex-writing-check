import * as vscode from 'vscode';
import { extractParagraphs, paragraphAt, ParagraphBlock } from './latexUtils';
import { checkParagraph, checkSectionRepetition, WritingIssue, RepetitionIssue, LlmProvider, providerLabel, apiKeySecretKey } from './llmClient';
import { findRepeatedSentences } from './repetition';
import { spellcheckRange, addWordToDictionary, Misspelling } from './spellcheck';
import { issueSignature, getIgnoredSet, addIgnored } from './ignoreStore';

let writingDiagnostics: vscode.DiagnosticCollection;
let spellDiagnostics: vscode.DiagnosticCollection;
let debounceTimer: NodeJS.Timeout | undefined;
let statusBarItem: vscode.StatusBarItem;
// Throttles the "<provider> unavailable" notification so a dead/misconfigured
// backend doesn't pop a dialog on every debounce tick while the user is typing.
let lastLlmWarningAt = 0;
function warnLlmOnce(message: string) {
  const now = Date.now();
  if (now - lastLlmWarningAt < 60000) return;
  lastLlmWarningAt = now;
  vscode.window.showWarningMessage(`LaTeX Writing Check: ${message}`);
}

// Caches LLM results keyed by the exact cleaned text that was sent, so
// "Check Whole Document" (and checkOnSave, which calls the same thing) only
// pays for paragraphs/sections that actually changed since last time,
// instead of re-checking the entire file on every save.
const MAX_CACHE_ENTRIES = 500;
function cacheSet<T>(cache: Map<string, T>, key: string, value: T) {
  if (!cache.has(key) && cache.size >= MAX_CACHE_ENTRIES) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey !== undefined) cache.delete(oldestKey);
  }
  cache.set(key, value);
}
const writingIssueCache = new Map<string, WritingIssue[]>();
const repetitionIssueCache = new Map<string, RepetitionIssue[]>();

interface CheckOptions {
  token?: vscode.CancellationToken;
  /** Called once per paragraph/section processed (cache hit or real call), for progress reporting. */
  onItemDone?: () => void;
}

const SPELL_SOURCE = 'LaTeX Spell Check';
const WRITING_SOURCE = 'LaTeX Writing Check';

const ALL_PROVIDERS: LlmProvider[] = ['ollama', 'openai', 'claude', 'gemini', 'deepseek'];

// Maps a writing-issue category to the config key that toggles it on/off.
const CATEGORY_CONFIG_KEY: Record<string, string> = {
  grammar: 'enableGrammar',
  passive: 'enablePassive',
  wordy: 'enableWordy',
  unclear: 'enableUnclear',
  uncited: 'enableUncited',
  repetition: 'enableRepetition'
};

function isCategoryEnabled(category: string, config: vscode.WorkspaceConfiguration): boolean {
  const key = CATEGORY_CONFIG_KEY[category];
  if (!key) return true;
  return config.get<boolean>(key, true);
}

export function activate(context: vscode.ExtensionContext) {
  writingDiagnostics = vscode.languages.createDiagnosticCollection('latexWritingCheck');
  spellDiagnostics = vscode.languages.createDiagnosticCollection('latexSpellCheck');
  context.subscriptions.push(writingDiagnostics, spellDiagnostics);

  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBarItem.text = '$(book) Writing check';
  statusBarItem.tooltip = 'LaTeX Writing Check (LLM + spellcheck)';
  context.subscriptions.push(statusBarItem);

  context.subscriptions.push(
    vscode.commands.registerCommand('latexWritingCheck.checkDocument', () =>
      checkDocument(context, vscode.window.activeTextEditor?.document)
    ),
    vscode.commands.registerCommand('latexWritingCheck.checkParagraph', () =>
      checkCurrentParagraph(context, vscode.window.activeTextEditor)
    ),
    vscode.commands.registerCommand('latexWritingCheck.checkSelection', () =>
      checkSelection(context, vscode.window.activeTextEditor)
    ),
    vscode.commands.registerCommand('latexWritingCheck.addWordToDictionary', async (word: string, docUri: vscode.Uri) => {
      await addWordToDictionary(context, word);
      const doc = vscode.workspace.textDocuments.find(d => d.uri.toString() === docUri.toString());
      if (doc) await runSpellCheck(context, doc, new vscode.Range(0, 0, doc.lineCount - 1, 0));
    }),
    vscode.commands.registerCommand('latexWritingCheck.ignoreSuggestion', async (signature: string, docUri: vscode.Uri) => {
      await addIgnored(context, signature);
      const doc = vscode.workspace.textDocuments.find(d => d.uri.toString() === docUri.toString());
      if (doc) {
        // Remove any currently-shown diagnostics matching this signature immediately,
        // rather than waiting for the next re-check. Signature could belong to either
        // collection, so check both.
        const existingWriting = writingDiagnostics.get(doc.uri) ?? [];
        writingDiagnostics.set(doc.uri, existingWriting.filter(d => d.code !== signature));
        const existingSpell = spellDiagnostics.get(doc.uri) ?? [];
        spellDiagnostics.set(doc.uri, existingSpell.filter(d => d.code !== signature));
      }
    }),
    vscode.commands.registerCommand('latexWritingCheck.setApiKey', () => setApiKey(context)),
    vscode.commands.registerCommand('latexWritingCheck.clearApiKey', () => clearApiKey(context))
  );

  context.subscriptions.push(
    vscode.languages.registerCodeActionsProvider('latex', new FixProvider(), {
      providedCodeActionKinds: [vscode.CodeActionKind.QuickFix]
    })
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument(e => {
      if (e.document.languageId !== 'latex') return;
      const config = vscode.workspace.getConfiguration('latexWritingCheck');
      if (!config.get<boolean>('checkOnType', true)) return;

      if (debounceTimer) clearTimeout(debounceTimer);
      const delay = config.get<number>('debounceMs', 2000);
      debounceTimer = setTimeout(() => {
        const editor = vscode.window.activeTextEditor;
        if (editor && editor.document === e.document) {
          checkCurrentParagraph(context, editor);
        }
      }, delay);
    })
  );

  // Spellcheck is cheap (no LLM call), so it's fine to also run it on open/save
  // independent of the writing-check debounce.
  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument(doc => {
      if (doc.languageId === 'latex') {
        runSpellCheck(context, doc, new vscode.Range(0, 0, doc.lineCount - 1, 0));
      }
    }),
    vscode.workspace.onDidSaveTextDocument(doc => {
      if (doc.languageId !== 'latex') return;
      const config = vscode.workspace.getConfiguration('latexWritingCheck');
      if (config.get<boolean>('checkOnSave', true)) {
        checkDocument(context, doc);
      } else {
        runSpellCheck(context, doc, new vscode.Range(0, 0, doc.lineCount - 1, 0));
      }
    })
  );

  if (vscode.window.activeTextEditor?.document.languageId === 'latex') {
    const doc = vscode.window.activeTextEditor.document;
    runSpellCheck(context, doc, new vscode.Range(0, 0, doc.lineCount - 1, 0));
  }
}

// ---------- API key management (cloud providers only -- Ollama needs none) ----------
// Keys are stored in VS Code's SecretStorage (context.secrets), never in a
// plain settings.json string, since settings sync/backup and workspace
// settings files aren't a safe place for a credential.

async function setApiKey(context: vscode.ExtensionContext) {
  const cloudProviders = ALL_PROVIDERS.filter(p => p !== 'ollama');
  const picked = await vscode.window.showQuickPick(
    cloudProviders.map(p => ({ label: providerLabel(p), provider: p })),
    { placeHolder: 'Which provider is this API key for?' }
  );
  if (!picked) return;

  const key = await vscode.window.showInputBox({
    prompt: `Paste your ${providerLabel(picked.provider)} API key`,
    password: true,
    ignoreFocusOut: true
  });
  if (!key) return;

  await context.secrets.store(apiKeySecretKey(picked.provider), key.trim());
  vscode.window.showInformationMessage(`Stored an API key for ${providerLabel(picked.provider)}.`);
}

async function clearApiKey(context: vscode.ExtensionContext) {
  const cloudProviders = ALL_PROVIDERS.filter(p => p !== 'ollama');
  const picked = await vscode.window.showQuickPick(
    cloudProviders.map(p => ({ label: providerLabel(p), provider: p })),
    { placeHolder: 'Clear the stored API key for which provider?' }
  );
  if (!picked) return;

  await context.secrets.delete(apiKeySecretKey(picked.provider));
  vscode.window.showInformationMessage(`Cleared the stored API key for ${providerLabel(picked.provider)}.`);
}

// ---------- Cloud-provider guardrails ----------
// The per-session "we're about to send text to a cloud provider" consent
// dialog (asked once, the first time any check actually reaches the
// network) lives in llmClient.ts, since it needs to cover checkOnType's
// automatic per-paragraph calls too, not just an explicit command. This one
// is different: it's specific to a single deliberate batch action (Check
// Whole Document / Check Selected Text) and names how many calls that
// action is actually about to make, since going from "one paragraph as I
// type" to "forty calls right now" is a distinct thing to weigh even after
// already having agreed to use a cloud provider at all -- particularly for
// cost, which the per-session dialog doesn't quantify.
function countUncachedWritingCalls(blocks: ParagraphBlock[]): number {
  return blocks.filter(b => !writingIssueCache.has(b.text)).length;
}

function countUncachedRepetitionCalls(blocks: ParagraphBlock[]): number {
  const bySection = new Map<number, ParagraphBlock[]>();
  for (const block of blocks) {
    const group = bySection.get(block.sectionIndex) ?? [];
    group.push(block);
    bySection.set(block.sectionIndex, group);
  }
  let count = 0;
  for (const group of bySection.values()) {
    if (group.length < 2) continue;
    const cacheKey = group.map(b => b.text).join('\n\n');
    if (!repetitionIssueCache.has(cacheKey)) count++;
  }
  return count;
}

/**
 * Returns true to proceed. Only ever prompts (and only ever counts calls)
 * when the configured provider is a cloud one and enableLLM is on --
 * Ollama has no cost or third-party exposure to warn about, and if the LLM
 * checks are off entirely there's nothing to count.
 */
async function confirmBatchCloudRun(
  config: vscode.WorkspaceConfiguration,
  writingBlocks: ParagraphBlock[],
  repetitionBlocks: ParagraphBlock[]
): Promise<boolean> {
  const provider = config.get<LlmProvider>('provider', 'ollama');
  if (provider === 'ollama' || !config.get<boolean>('enableLLM', true)) return true;
  if (!config.get<boolean>('confirmCloudCalls', true)) return true;

  const writingCalls = countUncachedWritingCalls(writingBlocks);
  const repetitionCalls = isCategoryEnabled('repetition', config) ? countUncachedRepetitionCalls(repetitionBlocks) : 0;
  const total = writingCalls + repetitionCalls;
  if (total === 0) return true; // everything's cached -- nothing new would actually be sent

  const choice = await vscode.window.showWarningMessage(
    `This will make up to ${total} API call(s) to ${providerLabel(provider)} (already-cached paragraphs/sections are free and not counted). Continue?`,
    { modal: true },
    'Continue'
  );
  return choice === 'Continue';
}

async function checkCurrentParagraph(context: vscode.ExtensionContext, editor: vscode.TextEditor | undefined) {
  if (!editor || editor.document.languageId !== 'latex') return;
  const block = paragraphAt(editor.document, editor.selection.active);
  if (!block) return;
  await runWritingCheck(context, editor.document, [block]);
  await runSpellCheck(context, editor.document, block.range);
}

// Checks whatever text is currently highlighted -- one or more whole
// paragraphs, or a chunk of one -- instead of the single paragraph the
// cursor sits in or the entire document. Handy for iterating on a section
// you're actively rewriting without paying the per-paragraph LLM cost
// for the rest of the file. Repetition still needs the whole document's
// paragraphs to have the right context to compare against (and is cheap --
// one LLM call per *section*, not per paragraph -- so there's no real
// benefit to scoping it down), so it isn't limited to the selection the way
// the writing-quality check and spellcheck are.
async function checkSelection(context: vscode.ExtensionContext, editor: vscode.TextEditor | undefined) {
  if (!editor || editor.document.languageId !== 'latex') return;
  if (editor.selection.isEmpty) {
    vscode.window.showInformationMessage('Select some text first, then run "Check Selected Text".');
    return;
  }

  const document = editor.document;
  const allBlocks = extractParagraphs(document);
  const selectedBlocks = allBlocks.filter(b => !!b.range.intersection(editor.selection));

  if (selectedBlocks.length === 0) {
    vscode.window.showInformationMessage('No prose paragraphs found in the selection.');
    return;
  }

  const config = vscode.workspace.getConfiguration('latexWritingCheck');
  if (!(await confirmBatchCloudRun(config, selectedBlocks, allBlocks))) return;

  await runWritingCheck(context, document, selectedBlocks);
  await runSpellCheck(context, document, editor.selection);
  await runRepetitionCheck(context, document, allBlocks);
}

async function checkDocument(context: vscode.ExtensionContext, document: vscode.TextDocument | undefined) {
  if (!document || document.languageId !== 'latex') {
    vscode.window.showInformationMessage('Open a .tex file to run a writing check.');
    return;
  }
  const blocks = extractParagraphs(document);
  if (blocks.length === 0) {
    vscode.window.showInformationMessage('No prose paragraphs found to check.');
    return;
  }

  const config = vscode.workspace.getConfiguration('latexWritingCheck');
  if (!(await confirmBatchCloudRun(config, blocks, blocks))) return;

  // The writing-quality pass is one LLM call per paragraph, sequential,
  // which is genuinely slow (especially on a CPU-only small local model) for
  // a document with many paragraphs -- a progress notification with a
  // Cancel button makes that wait visible and interruptible instead of the
  // status bar quietly spinning with no sense of how long is left.
  // Unchanged paragraphs/sections are served from cache (see
  // writingIssueCache above) so repeat runs -- e.g. checkOnSave while
  // editing one section -- are much faster than the first run.
  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: 'LaTeX Writing Check',
      cancellable: true
    },
    async (progress, token) => {
      const increment = blocks.length > 0 ? 100 / blocks.length : 100;
      progress.report({ message: `Checking ${blocks.length} paragraph(s)…` });
      await runWritingCheck(context, document, blocks, {
        token,
        onItemDone: () => progress.report({ increment })
      });
      if (token.isCancellationRequested) return;

      await runSpellCheck(context, document, new vscode.Range(0, 0, document.lineCount - 1, 0));
      if (token.isCancellationRequested) return;

      progress.report({ message: 'Checking for repeated phrasing…' });
      await runRepetitionCheck(context, document, blocks, { token });
    }
  );
}

// ---------- Writing-quality check (LLM-backed) ----------

async function runWritingCheck(
  context: vscode.ExtensionContext,
  document: vscode.TextDocument,
  blocks: ParagraphBlock[],
  options?: CheckOptions
) {
  const config = vscode.workspace.getConfiguration('latexWritingCheck');
  const provider = config.get<LlmProvider>('provider', 'ollama');

  if (!config.get<boolean>('enableLLM', true)) {
    // Grammar/passive/wordy/unclear/uncited are fully LLM-backed with no
    // local fallback -- there is nothing to check without an LLM backend, so
    // don't waste a network round-trip per paragraph just to discard the result.
    statusBarItem.text = '$(book) Writing check (local only)';
    statusBarItem.tooltip = 'LLM checks disabled (latexWritingCheck.enableLLM is false) -- spelling and wording-overlap repetition still run.';
    statusBarItem.show();
    return;
  }

  const ignored = getIgnoredSet(context);
  statusBarItem.text = '$(sync~spin) Checking writing…';
  statusBarItem.show();

  const newDiagnostics: vscode.Diagnostic[] = [];
  let checkedCount = 0;

  for (const block of blocks) {
    if (options?.token?.isCancellationRequested) break;
    try {
      let issues = writingIssueCache.get(block.text);
      if (!issues) {
        issues = await checkParagraph(block.text, config, context.secrets, options?.token);
        cacheSet(writingIssueCache, block.text, issues);
      }
      const filtered = issues.filter(issue =>
        isCategoryEnabled(issue.category, config) &&
        !ignored.has(issueSignature(issue.category, issue.quote))
      );
      newDiagnostics.push(...issuesToDiagnostics(document, block, filtered));
      checkedCount++;
    } catch (err: any) {
      if (options?.token?.isCancellationRequested) {
        // User hit Cancel -- the in-flight request was aborted deliberately,
        // not a real backend failure. Keep whatever we already found instead
        // of discarding it, and don't warn about something the user chose.
        break;
      }
      // Grammar/passive/wordy/uncited are fully LLM-backed with no local
      // fallback (unlike repetition), so a dead/misconfigured backend means
      // there's nothing more to find this pass. Leave whatever diagnostics
      // are already showing untouched -- they may be from the last time the
      // backend was reachable -- and surface the problem once via the
      // status bar rather than an error dialog on every debounce tick while
      // the user is mid-sentence.
      const message = err?.message ?? String(err);
      statusBarItem.text = `$(warning) ${providerLabel(provider)} unavailable`;
      statusBarItem.tooltip = `LaTeX Writing Check: ${message}`;
      warnLlmOnce(message);
      return;
    }
    options?.onItemDone?.();
  }

  // Only replace diagnostics for the paragraphs we actually finished
  // checking -- if cancelled partway through, leave the untouched ones as
  // they were rather than wiping them with nothing.
  const checkedRanges = blocks.slice(0, checkedCount).map(b => b.range);
  const existing = writingDiagnostics.get(document.uri) ?? [];
  const kept = existing.filter(d => !checkedRanges.some(r => r.intersection(d.range)));

  writingDiagnostics.set(document.uri, [...kept, ...newDiagnostics]);
  statusBarItem.text = '$(book) Writing check';
  statusBarItem.tooltip = 'LaTeX Writing Check (LLM + spellcheck)';
}

function issuesToDiagnostics(document: vscode.TextDocument, block: ParagraphBlock, issues: WritingIssue[]): vscode.Diagnostic[] {
  const diagnostics: vscode.Diagnostic[] = [];
  const paragraphText = document.getText(block.range);

  for (const issue of issues) {
    const idx = paragraphText.indexOf(issue.quote);
    let range: vscode.Range;
    if (idx === -1) {
      range = new vscode.Range(block.range.start, document.lineAt(block.range.start.line).range.end);
    } else {
      const startOffset = document.offsetAt(block.range.start) + idx;
      const endOffset = startOffset + issue.quote.length;
      range = new vscode.Range(document.positionAt(startOffset), document.positionAt(endOffset));
    }

    const message = issue.suggestion
      ? `${issue.message} (suggestion: ${issue.suggestion})`
      : issue.message;

    const diagnostic = new vscode.Diagnostic(range, `[${issue.category}] ${message}`, vscode.DiagnosticSeverity.Hint);
    diagnostic.source = WRITING_SOURCE;
    diagnostic.code = issueSignature(issue.category, issue.quote);
    diagnostics.push(diagnostic);
  }

  return diagnostics;
}

// ---------- Repetition check (section-scoped, LLM-backed) ----------
// Runs only on a full-document check, not the per-paragraph live check,
// since it needs multiple paragraphs from the same section to compare.

async function runRepetitionCheck(
  context: vscode.ExtensionContext,
  document: vscode.TextDocument,
  blocks: ParagraphBlock[],
  options?: CheckOptions
) {
  const config = vscode.workspace.getConfiguration('latexWritingCheck');
  if (!isCategoryEnabled('repetition', config)) return;
  const ignored = getIgnoredSet(context);

  const bySection = new Map<number, ParagraphBlock[]>();
  for (const block of blocks) {
    const group = bySection.get(block.sectionIndex) ?? [];
    group.push(block);
    bySection.set(block.sectionIndex, group);
  }

  const newDiagnostics: vscode.Diagnostic[] = [];
  const llmEnabled = config.get<boolean>('enableLLM', true);
  let llmUnavailable = false;

  for (const group of bySection.values()) {
    if (group.length < 2) continue;
    if (options?.token?.isCancellationRequested) break;

    // Deterministic, LLM-free near-duplicate sentence detection -- catches a
    // point restated in different words (including two sentences inside the
    // very same paragraph), which is the most common shape of unwanted
    // repetition and doesn't depend on the model's semantic judgment.
    // Always runs, LLM backend or not.
    const deterministicIssues = findRepeatedSentences(group);

    // LLM-backed check for reused phrasing/transitions that don't share
    // enough vocabulary for the deterministic check to catch. Skipped
    // outright if the LLM backend is disabled by choice (no warning --
    // that's expected, not a failure); best-effort otherwise: if the
    // backend errors, skip it (once) rather than losing the deterministic
    // results -- and everything found so far -- to one error. Cached by the
    // section's combined text so an unchanged section is free on the next run.
    let llmIssues: RepetitionIssue[] = [];
    if (llmEnabled && !llmUnavailable) {
      const cacheKey = group.map(b => b.text).join('\n\n');
      const cached = repetitionIssueCache.get(cacheKey);
      if (cached) {
        llmIssues = cached;
      } else {
        try {
          llmIssues = await checkSectionRepetition(group.map(b => b.text), config, context.secrets, options?.token);
          cacheSet(repetitionIssueCache, cacheKey, llmIssues);
        } catch (err: any) {
          if (options?.token?.isCancellationRequested) break;
          llmUnavailable = true;
          warnLlmOnce(
            `Section-repetition model check unavailable (${err?.message ?? err}); showing wording-overlap results only.`
          );
        }
      }
    }

    const seenInGroup = new Set<string>();
    for (const issue of [...deterministicIssues, ...llmIssues]) {
      const signature = issueSignature('repetition', issue.quote);
      if (ignored.has(signature) || seenInGroup.has(signature)) continue;
      seenInGroup.add(signature);

      const block = group[issue.paragraphIndex];
      if (!block) continue;
      const paragraphText = document.getText(block.range);
      const idx = paragraphText.indexOf(issue.quote);
      let range: vscode.Range;
      if (idx === -1) {
        range = new vscode.Range(block.range.start, document.lineAt(block.range.start.line).range.end);
      } else {
        const startOffset = document.offsetAt(block.range.start) + idx;
        const endOffset = startOffset + issue.quote.length;
        range = new vscode.Range(document.positionAt(startOffset), document.positionAt(endOffset));
      }
      const diagnostic = new vscode.Diagnostic(range, `[repetition] ${issue.message}`, vscode.DiagnosticSeverity.Hint);
      diagnostic.source = WRITING_SOURCE;
      diagnostic.code = signature;
      newDiagnostics.push(diagnostic);
    }
  }

  // Replace any repetition diagnostics from a previous run that fall inside
  // the ranges just re-checked, instead of appending forever (previously
  // every "Check Whole Document" / save left the old squiggles in place and
  // piled duplicates on top).
  const checkedRanges = blocks.map(b => b.range);
  const existing = writingDiagnostics.get(document.uri) ?? [];
  const kept = existing.filter(d => {
    const isRepetition = typeof d.code === 'string' && d.code.startsWith('repetition::');
    return !(isRepetition && checkedRanges.some(r => r.intersection(d.range)));
  });
  writingDiagnostics.set(document.uri, [...kept, ...newDiagnostics]);
}

// ---------- Spellcheck (local dictionary, no LLM) ----------

async function runSpellCheck(context: vscode.ExtensionContext, document: vscode.TextDocument, range: vscode.Range) {
  let misspellings: Misspelling[];
  try {
    misspellings = await spellcheckRange(context, document, range);
  } catch (err: any) {
    vscode.window.showErrorMessage(`Spellcheck failed to load dictionary: ${err?.message ?? err}`);
    return;
  }

  const ignored = getIgnoredSet(context);
  const filtered = misspellings.filter(m => !ignored.has(issueSignature('spelling', m.word)));

  const newDiagnostics = filtered.map(m => {
    const suggestionText = m.suggestions.length ? ` (try: ${m.suggestions.slice(0, 3).join(', ')})` : '';
    const diagnostic = new vscode.Diagnostic(
      m.range,
      `Possible misspelling: "${m.word}"${suggestionText}`,
      vscode.DiagnosticSeverity.Warning
    );
    diagnostic.source = SPELL_SOURCE;
    diagnostic.code = issueSignature('spelling', m.word);
    return diagnostic;
  });

  const existing = spellDiagnostics.get(document.uri) ?? [];
  const kept = existing.filter(d => !range.intersection(d.range));
  spellDiagnostics.set(document.uri, [...kept, ...newDiagnostics]);
}

// ---------- Quick fixes ----------

class FixProvider implements vscode.CodeActionProvider {
  provideCodeActions(
    document: vscode.TextDocument,
    range: vscode.Range,
    codeActionContext: vscode.CodeActionContext
  ): vscode.CodeAction[] {
    const actions: vscode.CodeAction[] = [];

    for (const diagnostic of codeActionContext.diagnostics) {
      if (diagnostic.source === SPELL_SOURCE) {
        const signature = String(diagnostic.code);
        const word = signature.startsWith('spelling::') ? signature.slice('spelling::'.length) : signature;

        const addAction = new vscode.CodeAction(`Add "${word}" to dictionary`, vscode.CodeActionKind.QuickFix);
        addAction.command = {
          command: 'latexWritingCheck.addWordToDictionary',
          title: 'Add to dictionary',
          arguments: [word, document.uri]
        };
        addAction.diagnostics = [diagnostic];
        actions.push(addAction);

        const match = diagnostic.message.match(/try: ([^)]+)\)/);
        if (match) {
          for (const suggestion of match[1].split(',').map(s => s.trim())) {
            const fix = new vscode.CodeAction(`Replace with "${suggestion}"`, vscode.CodeActionKind.QuickFix);
            fix.edit = new vscode.WorkspaceEdit();
            fix.edit.replace(document.uri, diagnostic.range, suggestion);
            fix.diagnostics = [diagnostic];
            actions.push(fix);
          }
        }

        const ignoreAction = new vscode.CodeAction('Ignore this suggestion', vscode.CodeActionKind.QuickFix);
        ignoreAction.command = {
          command: 'latexWritingCheck.ignoreSuggestion',
          title: 'Ignore this suggestion',
          arguments: [signature, document.uri]
        };
        ignoreAction.diagnostics = [diagnostic];
        actions.push(ignoreAction);
      } else if (diagnostic.source === WRITING_SOURCE) {
        const signature = String(diagnostic.code);
        const ignoreAction = new vscode.CodeAction('Ignore this suggestion', vscode.CodeActionKind.QuickFix);
        ignoreAction.command = {
          command: 'latexWritingCheck.ignoreSuggestion',
          title: 'Ignore this suggestion',
          arguments: [signature, document.uri]
        };
        ignoreAction.diagnostics = [diagnostic];
        actions.push(ignoreAction);
      }
    }

    return actions;
  }
}

export function deactivate() {
  if (debounceTimer) clearTimeout(debounceTimer);
  writingDiagnostics?.dispose();
  spellDiagnostics?.dispose();
}
