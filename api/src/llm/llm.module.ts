import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { LLM_PROVIDER, LlmProvider } from './llm.provider';
import { AnthropicProvider, MockProvider, OpenAiProvider } from './providers';

/** Picks the provider from LLM_PROVIDER. API keys stay on the server; the browser never sees them. */
@Global()
@Module({
  providers: [
    {
      provide: LLM_PROVIDER,
      inject: [ConfigService],
      useFactory: (config: ConfigService): LlmProvider => {
        const name = config.get<string>('LLM_PROVIDER', 'mock');
        const key = (k: string) => {
          const v = config.get<string>(k);
          if (!v) throw new Error(`${k} is required when LLM_PROVIDER=${name}`);
          return v;
        };
        switch (name) {
          case 'openai':
            return new OpenAiProvider(key('OPENAI_API_KEY'), config.get('OPENAI_MODEL', 'gpt-4o-mini'));
          case 'anthropic':
            return new AnthropicProvider(key('ANTHROPIC_API_KEY'), config.get('ANTHROPIC_MODEL', 'claude-sonnet-4-5'));
          case 'mock':
            return new MockProvider(Number(config.get('MOCK_DELAY_MS', 40)));
          default:
            throw new Error(`Unknown LLM_PROVIDER "${name}" (use mock, openai or anthropic)`);
        }
      },
    },
  ],
  exports: [LLM_PROVIDER],
})
export class LlmModule {}
