/**
 * Server-side BYOK provider calls (Phase E). Ported from the accuracy branch's
 * lib/ai/providers.ts, adapted to our conventions:
 *  - the user's key arrives per call, is never stored/logged here;
 *  - server-side `fetch` only (no browser direct-access header);
 *  - JSON mode where the provider supports it.
 *
 * HARD CONSTRAINT: this runs on the backend only — the browser never holds a
 * provider key and never calls a provider directly. Used ONLY by the analysis
 * AI step; the main Штурман agent stays on the built-in Anthropic client.
 */
export type AiProvider = 'openai' | 'gemini' | 'claude' | 'openrouter';

interface ProviderMeta {
  label: string;
  defaultModel: string;
}

/** Default model per provider (modern, JSON-capable). */
export const PROVIDERS: Record<AiProvider, ProviderMeta> = {
  openai: { label: 'OpenAI', defaultModel: 'gpt-4o' },
  gemini: { label: 'Gemini', defaultModel: 'gemini-2.0-flash' },
  claude: { label: 'Claude', defaultModel: 'claude-sonnet-5' },
  openrouter: { label: 'OpenRouter', defaultModel: 'openai/gpt-4o' },
};

export interface CallProviderOptions {
  system: string;
  user: string;
  maxTokens?: number;
  /** Override the provider's default model. */
  model?: string;
}

async function providerError(res: Response, provider: AiProvider): Promise<Error> {
  let msg = `${PROVIDERS[provider].label} API error ${res.status}`;
  try {
    const e = (await res.json()) as { error?: { message?: string } };
    if (e?.error?.message) msg = e.error.message;
  } catch {
    /* ignore non-JSON error bodies */
  }
  return new Error(msg);
}

/**
 * Call the user's chosen provider with a system+user prompt and return the raw
 * model text. JSON mode is requested where supported so the analysis JSON parser
 * downstream stays happy.
 */
export async function callProvider(
  provider: AiProvider,
  apiKey: string,
  opts: CallProviderOptions,
): Promise<string> {
  const { system, user } = opts;
  const maxTokens = opts.maxTokens ?? 8000;
  const model = opts.model || PROVIDERS[provider]?.defaultModel;
  if (!apiKey) throw new Error('BYOK API key is missing.');
  if (!model) throw new Error(`Unknown provider: ${provider}`);

  if (provider === 'openai' || provider === 'openrouter') {
    const endpoint =
      provider === 'openai'
        ? 'https://api.openai.com/v1/chat/completions'
        : 'https://openrouter.ai/api/v1/chat/completions';
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        temperature: 0,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
      }),
    });
    if (!res.ok) throw await providerError(res, provider);
    const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    return data.choices?.[0]?.message?.content ?? '';
  }

  if (provider === 'gemini') {
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
      model,
    )}:generateContent`;
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: system }] },
        contents: [{ role: 'user', parts: [{ text: user }] }],
        generationConfig: {
          maxOutputTokens: maxTokens,
          temperature: 0,
          responseMimeType: 'application/json',
        },
      }),
    });
    if (!res.ok) throw await providerError(res, provider);
    const data = (await res.json()) as {
      candidates?: { content?: { parts?: { text?: string }[] } }[];
    };
    return data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
  }

  // provider === 'claude' — the user's OWN Anthropic key (raw fetch, JSON-nudged).
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      system,
      messages: [
        { role: 'user', content: `${user}\n\nПоверни ТІЛЬКИ валідний JSON, без markdown.` },
      ],
    }),
  });
  if (!res.ok) throw await providerError(res, provider);
  const data = (await res.json()) as { content?: { type?: string; text?: string }[] };
  let text = '';
  for (const block of data.content ?? []) {
    if (block.type === 'text' && block.text) text += block.text;
  }
  return text;
}
