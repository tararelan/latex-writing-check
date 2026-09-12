// Request/response handling for the cloud LLM backends. Each function here
// takes an already-resolved API key and model id and returns the raw text
// content of the model's reply -- callModel() in llmClient.ts is responsible
// for picking which of these to call, and for turning a resolved provider +
// model + prompt into one of these calls.
//
// Deliberately NOT hardcoding a default model id for any of these (unlike
// Ollama, which ships with qwen2.5:1.5b-instruct as a sane local default):
// OpenAI/Gemini/Claude/DeepSeek model names change often enough that a
// hardcoded default would likely be wrong or discontinued by the time this
// is read. latexWritingCheck.model must be set explicitly for any non-Ollama
// provider; llmClient.ts throws a clear error if it isn't.

export interface ProviderCallOptions {
  apiKey: string;
  model: string;
  systemPrompt: string;
  userContent: string;
  signal: AbortSignal;
}

/**
 * OpenAI-compatible chat-completions endpoint. Covers both OpenAI itself and
 * DeepSeek, which implements the same request/response shape at a different
 * base URL -- only baseUrl and the error text differ between the two.
 */
export async function callOpenAICompatible(
  baseUrl: string,
  providerLabel: string,
  opts: ProviderCallOptions
): Promise<string> {
  const res = await fetch(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${opts.apiKey}`
    },
    signal: opts.signal,
    body: JSON.stringify({
      model: opts.model,
      temperature: 0.1,
      messages: [
        { role: 'system', content: opts.systemPrompt },
        { role: 'user', content: opts.userContent }
      ]
    })
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(
      `${providerLabel} request failed: ${res.status} ${res.statusText}${body ? ` -- ${body.slice(0, 200)}` : ''}. Check latexWritingCheck.model is a valid ${providerLabel} model id and your API key is correct.`
    );
  }

  const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  return data.choices?.[0]?.message?.content?.trim() ?? '[]';
}

/** Anthropic Messages API (Claude). */
export async function callClaude(opts: ProviderCallOptions): Promise<string> {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': opts.apiKey,
      'anthropic-version': '2023-06-01'
    },
    signal: opts.signal,
    body: JSON.stringify({
      model: opts.model,
      max_tokens: 1024,
      system: opts.systemPrompt,
      messages: [{ role: 'user', content: opts.userContent }]
    })
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(
      `Claude request failed: ${res.status} ${res.statusText}${body ? ` -- ${body.slice(0, 200)}` : ''}. Check latexWritingCheck.model is a valid Claude model id and your API key is correct.`
    );
  }

  const data = (await res.json()) as { content?: { type?: string; text?: string }[] };
  const textBlock = data.content?.find(b => b.type === 'text');
  return textBlock?.text?.trim() ?? '[]';
}

/** Google Gemini generateContent REST API. */
export async function callGemini(opts: ProviderCallOptions): Promise<string> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(opts.model)}:generateContent?key=${encodeURIComponent(opts.apiKey)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: opts.signal,
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: opts.systemPrompt }] },
      contents: [{ role: 'user', parts: [{ text: opts.userContent }] }],
      generationConfig: { temperature: 0.1 }
    })
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(
      `Gemini request failed: ${res.status} ${res.statusText}${body ? ` -- ${body.slice(0, 200)}` : ''}. Check latexWritingCheck.model is a valid Gemini model id and your API key is correct.`
    );
  }

  const data = (await res.json()) as {
    candidates?: { content?: { parts?: { text?: string }[] } }[];
  };
  const parts = data.candidates?.[0]?.content?.parts ?? [];
  return parts.map(p => p.text ?? '').join('').trim() || '[]';
}
