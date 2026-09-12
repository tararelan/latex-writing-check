import * as vscode from 'vscode';
import { callOpenAICompatible, callClaude, callGemini } from './llmProviders';

export interface WritingIssue {
  /** Exact substring from the input paragraph that the issue refers to */
  quote: string;
  /** Category: grammar | passive | wordy | unclear | uncited */
  category: string;
  /** One-line explanation */
  message: string;
  /** Optional short suggested rewrite */
  suggestion?: string;
}

export interface RepetitionIssue {
  /** Index into the paragraphs array passed to checkSectionRepetition */
  paragraphIndex: number;
  /** Exact substring from that paragraph */
  quote: string;
  message: string;
}

export type LlmProvider = 'ollama' | 'openai' | 'claude' | 'gemini' | 'deepseek';

export function providerLabel(provider: LlmProvider): string {
  switch (provider) {
    case 'ollama': return 'Ollama';
    case 'openai': return 'OpenAI';
    case 'claude': return 'Claude';
    case 'gemini': return 'Gemini';
    case 'deepseek': return 'DeepSeek';
  }
}

/** Secrets key an API key for this provider is stored under. Not used for Ollama (no key needed). */
export function apiKeySecretKey(provider: LlmProvider): string {
  return `latexWritingCheck.apiKey.${provider}`;
}

/**
 * Rewrites "localhost" to "127.0.0.1" in a configured URL.
 *
 * This is the actual fix, not just a friendlier default: Node's `fetch`
 * (undici) can resolve the hostname "localhost" to the IPv6 loopback
 * address (::1) first, and Ollama only listens on the IPv4 loopback
 * (127.0.0.1) by default. That produces a "fetch failed" / ECONNREFUSED
 * error from this extension even while Ollama is fully reachable from
 * everything else on the machine (a browser, curl, Invoke-WebRequest),
 * which resolve it differently. Changing the setting's *default* doesn't
 * fully close this off, because an explicit user setting (an old
 * settings.json, a synced profile, a stale guide) always overrides an
 * extension's declared default -- so it's normalized here, in code, no
 * matter what ends up in latexWritingCheck.ollamaUrl.
 */
function normalizeOllamaUrl(raw: string): string {
  try {
    const url = new URL(raw);
    if (url.hostname.toLowerCase() === 'localhost') {
      url.hostname = '127.0.0.1';
    }
    return url.toString().replace(/\/$/, '');
  } catch {
    // Not a parseable URL -- let it through as-is so the fetch call below
    // surfaces a clear error instead of masking it here.
    return raw;
  }
}

const SYSTEM_PROMPT = `You are a terse writing checker for academic prose extracted from a LaTeX document.
You will be given a single paragraph of plain prose (LaTeX markup removed). Citation commands
in the original document have been replaced with the literal marker [CITATION] wherever a
citation appears in the source.

Identify real issues only, in these categories:
- grammar: grammatical errors (subject-verb agreement, tense, articles, etc). Do NOT flag spelling -- a separate tool handles that.
- passive: unnecessary passive voice
- wordy: wordiness that could be tightened
- unclear: ambiguous or hard-to-parse sentences
- uncited: a specific factual, empirical, or statistical claim (numbers, comparisons, "was shown", "outperforms", "is the first", etc) that has NO [CITATION] marker anywhere in or immediately after the sentence making the claim

Do not invent issues if the paragraph is fine. Do not flag or comment on the literal text
[CITATION] itself -- only use its presence or absence to decide the "uncited" category.

Respond with ONLY a JSON array (no markdown fences, no preamble). Each element:
{"quote": "<exact substring from the paragraph, under 12 words, never including the literal text [CITATION]>", "category": "<grammar|passive|wordy|unclear|uncited>", "message": "<one short sentence>", "suggestion": "<optional short rewrite>"}

If there are no issues, respond with: []
Return at most 5 issues. Keep messages under 15 words.`;

const REPETITION_SYSTEM_PROMPT = `You are checking a section of academic prose for repeated phrasing across paragraphs.
You will be given several paragraphs from the same section, each labeled with a number like [0], [1].
Identify phrases, transitions, or sentence constructions that are noticeably reused across two or
more of these paragraphs -- the same distinctive wording repeated rather than varied. Ignore common
short connective words; only flag genuinely repetitive phrasing a careful writer would want to vary.

Respond with ONLY a JSON array (no markdown fences, no preamble). Each element:
{"paragraphIndex": <number matching one of the [n] labels>, "quote": "<exact substring from that paragraph, under 12 words>", "message": "<one short sentence naming what it repeats>"}

Return at most 5 issues. If nothing stands out, respond with: []`;

const OPENAI_COMPAT_BASE_URL: Record<'openai' | 'deepseek', string> = {
  openai: 'https://api.openai.com/v1',
  deepseek: 'https://api.deepseek.com'
};

// Ollama is local, so a slow response usually just means the CPU is busy
// loading/running the model -- worth waiting longer for. A cloud provider
// hanging for that long more likely means a real network problem (flaky
// wifi, a VPN, a provider-side outage), so it gets a shorter timeout so a
// stuck request surfaces as a clear error instead of leaving the progress
// notification (or the status bar, for the live per-paragraph check)
// spinning indefinitely with no explanation.
const OLLAMA_TIMEOUT_MS = 60000;
const CLOUD_TIMEOUT_MS = 30000;

// Guardrails around cloud providers specifically (Ollama needs none of this
// -- it's local, free, and nothing leaves the machine). Both remembered
// per-VS-Code-session (module-level, not persisted) so they ask again next
// time the editor is reopened, but don't nag on every paragraph/keystroke
// within one sitting.
let cloudCallsConfirmedThisSession = false;
let cloudCallsDeclinedThisSession = false;

/**
 * One-time-per-session confirmation shown the first time any check is about
 * to actually send paragraph text to a cloud provider. This exists
 * separately from the batch-run confirmation in extension.ts because
 * checkOnType means this can happen continuously and automatically while
 * drafting, not just when explicitly running a check -- a materially
 * different thing to consent to than a single deliberate action.
 */
async function confirmCloudProviderUse(provider: LlmProvider, config: vscode.WorkspaceConfiguration): Promise<boolean> {
  if (provider === 'ollama') return true;
  if (cloudCallsConfirmedThisSession) return true;
  if (cloudCallsDeclinedThisSession) return false;
  if (!config.get<boolean>('confirmCloudCalls', true)) {
    cloudCallsConfirmedThisSession = true;
    return true;
  }

  const choice = await vscode.window.showWarningMessage(
    `LaTeX Writing Check is about to send paragraph text from this document to ${providerLabel(provider)}'s API, using your stored API key. ` +
      `If "check as you type" is enabled, this will keep happening automatically as you edit. Continue for the rest of this VS Code session?`,
    { modal: true },
    'Continue'
  );

  if (choice === 'Continue') {
    cloudCallsConfirmedThisSession = true;
    return true;
  }
  cloudCallsDeclinedThisSession = true;
  return false;
}

/**
 * Dispatches a single chat-style call to whichever provider is configured,
 * and returns the raw text of its reply. Ollama needs no API key and keeps
 * its existing qwen2.5:1.5b-instruct default; every cloud provider requires
 * latexWritingCheck.model to be set explicitly (see the comment in
 * llmProviders.ts for why no default is hardcoded for those) and an API key
 * in secrets (set via the "LaTeX Writing Check: Set API Key" command).
 */
async function callModel(
  systemPrompt: string,
  userContent: string,
  config: vscode.WorkspaceConfiguration,
  secrets: vscode.SecretStorage | undefined,
  token?: vscode.CancellationToken
): Promise<string> {
  const provider = config.get<LlmProvider>('provider', 'ollama');

  const consented = await confirmCloudProviderUse(provider, config);
  if (!consented) {
    throw new Error(
      `Declined: you chose not to send text to ${providerLabel(provider)} this session. Set latexWritingCheck.provider to "ollama", or reopen the editor to be asked again.`
    );
  }

  const controller = new AbortController();
  token?.onCancellationRequested(() => controller.abort());
  let timedOut = false;
  const timeoutMs = provider === 'ollama' ? OLLAMA_TIMEOUT_MS : CLOUD_TIMEOUT_MS;
  const timeoutHandle = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  try {
    if (provider === 'ollama') {
      const baseUrl = normalizeOllamaUrl(config.get<string>('ollamaUrl', 'http://127.0.0.1:11434'));
      const model = config.get<string>('model', 'qwen2.5:1.5b-instruct');

      const res = await fetch(`${baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          model,
          stream: false,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userContent }
          ],
          options: { temperature: 0.1 }
        })
      });

      if (!res.ok) {
        throw new Error(`Ollama request failed: ${res.status} ${res.statusText}. Is Ollama running (ollama serve) and is the model pulled (ollama pull ${model})?`);
      }

      const data = await res.json() as { message?: { content?: string } };
      return data.message?.content?.trim() ?? '[]';
    }

    // Every other provider is a cloud API and needs an explicit model id (no
    // hardcoded default -- see llmProviders.ts) and a stored API key.
    const model = config.get<string>('model', '').trim();
    if (!model || model === 'qwen2.5:1.5b-instruct') {
      throw new Error(
        `latexWritingCheck.model must be set to a valid ${providerLabel(provider)} model id -- there is no default for cloud providers, since model names in this space change often. Set it in your VS Code settings.`
      );
    }

    const apiKey = await secrets?.get(apiKeySecretKey(provider));
    if (!apiKey) {
      throw new Error(
        `No API key stored for ${providerLabel(provider)}. Run "LaTeX Writing Check: Set API Key" from the command palette and choose ${providerLabel(provider)}.`
      );
    }

    const callOpts = { apiKey, model, systemPrompt, userContent, signal: controller.signal };

    switch (provider) {
      case 'openai':
        return await callOpenAICompatible(OPENAI_COMPAT_BASE_URL.openai, 'OpenAI', callOpts);
      case 'deepseek':
        return await callOpenAICompatible(OPENAI_COMPAT_BASE_URL.deepseek, 'DeepSeek', callOpts);
      case 'claude':
        return await callClaude(callOpts);
      case 'gemini':
        return await callGemini(callOpts);
      default:
        throw new Error(`Unknown latexWritingCheck.provider value: ${provider}`);
    }
  } catch (err: any) {
    if (timedOut) {
      throw new Error(`Request to ${providerLabel(provider)} timed out after ${timeoutMs / 1000}s.`);
    }
    throw err;
  } finally {
    clearTimeout(timeoutHandle);
  }
}

function stripFences(raw: string): string {
  return raw.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '').trim();
}

export async function checkParagraph(
  text: string,
  config: vscode.WorkspaceConfiguration,
  secrets: vscode.SecretStorage | undefined,
  token?: vscode.CancellationToken
): Promise<WritingIssue[]> {
  const raw = await callModel(SYSTEM_PROMPT, text, config, secrets, token);
  const cleaned = stripFences(raw);
  try {
    const parsed = JSON.parse(cleaned);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((x: unknown): x is WritingIssue =>
        typeof x === 'object' && x !== null &&
        typeof (x as any).quote === 'string' &&
        typeof (x as any).message === 'string'
      )
      .slice(0, 5);
  } catch {
    // Model didn't return valid JSON -- fail quietly rather than showing garbage diagnostics.
    return [];
  }
}

/**
 * Check a set of paragraphs from the same section for reused phrasing across
 * them. Needs at least 2 paragraphs to have anything to compare.
 */
export async function checkSectionRepetition(
  paragraphs: string[],
  config: vscode.WorkspaceConfiguration,
  secrets: vscode.SecretStorage | undefined,
  token?: vscode.CancellationToken
): Promise<RepetitionIssue[]> {
  if (paragraphs.length < 2) return [];

  const labeled = paragraphs.map((p, i) => `[${i}] ${p}`).join('\n\n');
  const raw = await callModel(REPETITION_SYSTEM_PROMPT, labeled, config, secrets, token);
  const cleaned = stripFences(raw);

  try {
    const parsed = JSON.parse(cleaned);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((x: unknown): x is RepetitionIssue =>
        typeof x === 'object' && x !== null &&
        typeof (x as any).paragraphIndex === 'number' &&
        typeof (x as any).quote === 'string' &&
        (x as any).paragraphIndex >= 0 &&
        (x as any).paragraphIndex < paragraphs.length
      )
      .slice(0, 5);
  } catch {
    return [];
  }
}
