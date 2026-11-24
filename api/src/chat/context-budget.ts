import { ChatTurn } from '../llm/llm.provider';

/**
 * Rough token estimate (about 4 characters per token for English text, plus a small
 * per-message overhead). Good enough for budgeting; swap in a real tokenizer
 * (e.g. tiktoken) if a provider needs exact counts.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4) + 4;
}

export interface WindowInput {
  /** Turns not yet folded into the summary, oldest first. The last one is the new user message. */
  turns: ChatTurn[];
  systemPrompt: string;
  summary: string | null;
  /** Total tokens we allow ourselves to send per request. */
  budget: number;
  /** Tokens kept free for the model's reply. */
  replyReserve: number;
}

export interface WindowResult {
  /** Index of the first turn that is sent as-is. Turns before it must be summarised. */
  startIndex: number;
  /** Tokens used by the turns that are sent. */
  usedTokens: number;
}

/**
 * Picks the newest turns that fit the budget after the system prompt, the running
 * summary and the reply reserve. Older turns are never dropped silently: the caller
 * folds everything before `startIndex` into the summary.
 * The newest turn is always kept, even if it alone is over budget.
 */
export function selectWindow(input: WindowInput): WindowResult {
  const fixed =
    estimateTokens(input.systemPrompt) + (input.summary ? estimateTokens(input.summary) : 0) + input.replyReserve;
  const available = Math.max(0, input.budget - fixed);

  let used = 0;
  let start = input.turns.length;
  for (let i = input.turns.length - 1; i >= 0; i--) {
    const cost = estimateTokens(input.turns[i].content);
    const isNewest = i === input.turns.length - 1;
    if (!isNewest && used + cost > available) break;
    used += cost;
    start = i;
  }
  // Never start the window on an assistant reply: the model should see the question first.
  while (start > 0 && start < input.turns.length - 1 && input.turns[start].role === 'assistant') start++;
  return { startIndex: start, usedTokens: used };
}
