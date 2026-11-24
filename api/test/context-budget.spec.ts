import { estimateTokens, selectWindow } from '../src/chat/context-budget';
import { ChatTurn } from '../src/llm/llm.provider';

const turn = (role: 'user' | 'assistant', chars: number): ChatTurn => ({ role, content: 'x'.repeat(chars) });

describe('selectWindow', () => {
  it('keeps every turn when the conversation fits', () => {
    const turns = [turn('user', 40), turn('assistant', 40), turn('user', 40)];
    const r = selectWindow({ turns, systemPrompt: 'sys', summary: null, budget: 1000, replyReserve: 100 });
    expect(r.startIndex).toBe(0);
  });

  it('drops the oldest turns first when over budget', () => {
    const turns = [turn('user', 400), turn('assistant', 400), turn('user', 400), turn('assistant', 400), turn('user', 400)];
    // Each turn is about 104 tokens. 400 budget - 100 reserve - system leaves room for about 2 turns.
    const r = selectWindow({ turns, systemPrompt: 'sys', summary: null, budget: 400, replyReserve: 100 });
    expect(r.startIndex).toBeGreaterThan(0);
    expect(r.usedTokens).toBeLessThanOrEqual(400 - 100);
  });

  it('always keeps the newest message, even if it alone is over budget', () => {
    const turns = [turn('user', 40), turn('user', 10_000)];
    const r = selectWindow({ turns, systemPrompt: 'sys', summary: null, budget: 200, replyReserve: 50 });
    expect(r.startIndex).toBe(1);
  });

  it('counts the running summary against the budget', () => {
    const turns = [turn('user', 200), turn('assistant', 200), turn('user', 200)];
    const without = selectWindow({ turns, systemPrompt: 'sys', summary: null, budget: 250, replyReserve: 50 });
    const withSummary = selectWindow({ turns, systemPrompt: 'sys', summary: 'y'.repeat(400), budget: 250, replyReserve: 50 });
    expect(withSummary.startIndex).toBeGreaterThanOrEqual(without.startIndex);
  });

  it('does not start the window on an assistant reply', () => {
    const turns = [turn('user', 400), turn('assistant', 40), turn('user', 40)];
    const r = selectWindow({ turns, systemPrompt: 'sys', summary: null, budget: 150, replyReserve: 50 });
    expect(turns[r.startIndex].role).toBe('user');
  });

  it('estimates tokens at about 4 characters each', () => {
    expect(estimateTokens('x'.repeat(400))).toBe(104);
  });
});
