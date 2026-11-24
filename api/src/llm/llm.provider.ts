export type Role = 'user' | 'assistant';

export interface ChatTurn {
  role: Role;
  content: string;
}

export interface LlmRequest {
  system: string;
  messages: ChatTurn[];
  maxTokens: number;
}

/**
 * The one interface the rest of the app talks to. OpenAI, Anthropic and the mock
 * provider implement it, so switching models is a config change, not a code change.
 */
export interface LlmProvider {
  readonly name: string;
  /** Streams the reply as text chunks. Stops early when `signal` is aborted. */
  stream(req: LlmRequest, signal: AbortSignal): AsyncIterable<string>;
  /** Non-streaming call, used for summarising older turns. */
  complete(req: LlmRequest): Promise<string>;
}

export const LLM_PROVIDER = Symbol('LLM_PROVIDER');
