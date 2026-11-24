import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import { LlmProvider, LlmRequest } from './llm.provider';

/** Retries 429 and 5xx responses with exponential backoff. Other errors fail fast. */
async function withRetry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  let delay = 500;
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (err: any) {
      const status = err?.status ?? err?.response?.status;
      const retryable = status === 429 || (status >= 500 && status < 600);
      if (!retryable || i >= attempts) throw err;
      await new Promise((r) => setTimeout(r, delay));
      delay *= 2;
    }
  }
}

export class OpenAiProvider implements LlmProvider {
  readonly name = 'openai';
  private readonly client: OpenAI;
  constructor(apiKey: string, private readonly model: string) {
    this.client = new OpenAI({ apiKey });
  }

  private toMessages(req: LlmRequest) {
    return [{ role: 'system' as const, content: req.system }, ...req.messages];
  }

  async *stream(req: LlmRequest, signal: AbortSignal): AsyncIterable<string> {
    const stream = await withRetry(() =>
      this.client.chat.completions.create(
        { model: this.model, max_tokens: req.maxTokens, stream: true, messages: this.toMessages(req) },
        { signal },
      ),
    );
    for await (const chunk of stream) {
      const text = chunk.choices[0]?.delta?.content;
      if (text) yield text;
    }
  }

  async complete(req: LlmRequest): Promise<string> {
    const res = await withRetry(() =>
      this.client.chat.completions.create({ model: this.model, max_tokens: req.maxTokens, messages: this.toMessages(req) }),
    );
    return res.choices[0]?.message?.content ?? '';
  }
}

export class AnthropicProvider implements LlmProvider {
  readonly name = 'anthropic';
  private readonly client: Anthropic;
  constructor(apiKey: string, private readonly model: string) {
    this.client = new Anthropic({ apiKey });
  }

  async *stream(req: LlmRequest, signal: AbortSignal): AsyncIterable<string> {
    const stream = await withRetry(async () =>
      this.client.messages.stream(
        { model: this.model, max_tokens: req.maxTokens, system: req.system, messages: req.messages },
        { signal },
      ),
    );
    for await (const event of stream) {
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') yield event.delta.text;
    }
  }

  async complete(req: LlmRequest): Promise<string> {
    const res = await withRetry(() =>
      this.client.messages.create({ model: this.model, max_tokens: req.maxTokens, system: req.system, messages: req.messages }),
    );
    return res.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
  }
}

/**
 * Runs the whole app without an API key: streams a short reply word by word so the
 * streaming, cancellation and persistence paths can be tried end to end.
 */
export class MockProvider implements LlmProvider {
  readonly name = 'mock';
  /** Delay between words, so streaming is visible in the UI. Tests set it near 0. */
  constructor(private readonly delayMs = 40) {}

  async *stream(req: LlmRequest, signal: AbortSignal): AsyncIterable<string> {
    const last = req.messages[req.messages.length - 1]?.content ?? '';
    const reply =
      `(mock model) You said: "${last.slice(0, 120)}". ` +
      `I can see ${req.messages.length} message(s) in my context window` +
      (req.system.includes('Summary of earlier conversation') ? ', plus a summary of older turns.' : '.') +
      ' Set LLM_PROVIDER=openai or anthropic to talk to a real model.';
    for (const word of reply.split(' ')) {
      if (signal.aborted) return;
      await new Promise((r) => setTimeout(r, this.delayMs));
      yield word + ' ';
    }
  }

  async complete(req: LlmRequest): Promise<string> {
    return `Earlier, the user discussed: ${req.messages
      .filter((m) => m.role === 'user')
      .map((m) => m.content.slice(0, 40))
      .join('; ')}`;
  }
}
