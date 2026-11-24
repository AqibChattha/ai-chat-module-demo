import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { MoreThan, Repository } from 'typeorm';
import { ChatTurn, LLM_PROVIDER, LlmProvider } from '../llm/llm.provider';
import { selectWindow } from './context-budget';
import { Conversation, Message } from './entities';

export const BASE_SYSTEM_PROMPT =
  'You are a helpful assistant inside a SaaS application. Answer clearly and concisely.';

export type StreamEvent =
  | { type: 'token'; text: string }
  | { type: 'done'; messageId: number; status: 'complete' | 'stopped' }
  | { type: 'error'; message: string };

@Injectable()
export class ChatService {
  private readonly log = new Logger(ChatService.name);
  private readonly budget: number;
  private readonly replyReserve: number;
  private readonly maxReplyTokens: number;

  constructor(
    @InjectRepository(Conversation) private readonly conversations: Repository<Conversation>,
    @InjectRepository(Message) private readonly messages: Repository<Message>,
    @Inject(LLM_PROVIDER) private readonly llm: LlmProvider,
    config: ConfigService,
  ) {
    this.budget = Number(config.get('CONTEXT_BUDGET_TOKENS', 6000));
    this.replyReserve = Number(config.get('REPLY_RESERVE_TOKENS', 1000));
    this.maxReplyTokens = Number(config.get('MAX_REPLY_TOKENS', 800));
  }

  createConversation(title?: string) {
    return this.conversations.save(this.conversations.create({ title: title ?? 'New chat' }));
  }

  async getConversation(id: string) {
    const conv = await this.conversations.findOne({ where: { id } });
    if (!conv) throw new NotFoundException('Conversation not found');
    return conv;
  }

  async history(id: string) {
    await this.getConversation(id);
    return this.messages.find({
      where: { conversation: { id } },
      order: { id: 'ASC' },
      select: { id: true, role: true, content: true, status: true, createdAt: true },
    });
  }

  /**
   * Saves the user's message, builds a token-budgeted context and streams the reply.
   * The reply is saved when it finishes, or saved as "stopped" with the partial text
   * when the client disconnects. Nothing is lost silently.
   */
  async *reply(conversationId: string, content: string, signal: AbortSignal): AsyncGenerator<StreamEvent> {
    const conv = await this.getConversation(conversationId);
    await this.messages.save(this.messages.create({ conversation: conv, role: 'user', content }));

    const { system, turns } = await this.buildContext(conv);

    let text = '';
    let persisted = false;
    const save = async (status: 'complete' | 'stopped') => {
      persisted = true;
      return this.messages.save(this.messages.create({ conversation: conv, role: 'assistant', content: text.trim(), status }));
    };

    try {
      try {
        for await (const chunk of this.llm.stream({ system, messages: turns, maxTokens: this.maxReplyTokens }, signal)) {
          text += chunk;
          yield { type: 'token', text: chunk };
        }
      } catch (err: any) {
        if (!signal.aborted) {
          this.log.error(`LLM stream failed: ${err?.message ?? err}`);
          yield { type: 'error', message: 'The AI service is unavailable right now. Please retry.' };
          return;
        }
      }

      const status = signal.aborted ? 'stopped' : 'complete';
      if (text.length === 0 && status === 'stopped') return;
      const saved = await save(status);
      yield { type: 'done', messageId: saved.id, status };
    } finally {
      // Runs even if the consumer stops iterating early: partial replies are never lost.
      if (!persisted && text.length > 0) await save('stopped');
    }
  }

  /** Fits the conversation into the budget, folding older turns into the running summary. */
  private async buildContext(conv: Conversation): Promise<{ system: string; turns: ChatTurn[] }> {
    const pending = await this.messages.find({
      where: { conversation: { id: conv.id }, id: MoreThan(conv.summarizedUpTo) },
      order: { id: 'ASC' },
    });
    const turns: ChatTurn[] = pending.map((m) => ({ role: m.role, content: m.content }));

    const { startIndex } = selectWindow({
      turns,
      systemPrompt: BASE_SYSTEM_PROMPT,
      summary: conv.summary,
      budget: this.budget,
      replyReserve: this.replyReserve,
    });

    if (startIndex > 0) {
      const older = turns.slice(0, startIndex);
      const previous = conv.summary ? `Previous summary: ${conv.summary}\n\n` : '';
      conv.summary = await this.llm.complete({
        system: 'Summarise this conversation in under 150 words. Keep names, numbers and decisions.',
        messages: [{ role: 'user', content: previous + older.map((t) => `${t.role}: ${t.content}`).join('\n') }],
        maxTokens: 300,
      });
      conv.summarizedUpTo = pending[startIndex - 1].id;
      await this.conversations.save(conv);
    }

    const system = conv.summary
      ? `${BASE_SYSTEM_PROMPT}\n\nSummary of earlier conversation: ${conv.summary}`
      : BASE_SYSTEM_PROMPT;
    return { system, turns: turns.slice(startIndex) };
  }
}
