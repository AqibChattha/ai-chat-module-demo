import { Controller, Get, Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { TypeOrmModule, TypeOrmModuleOptions } from '@nestjs/typeorm';
import { ChatModule } from './chat/chat.module';
import { Conversation, Message } from './chat/entities';
import { LlmModule } from './llm/llm.module';

@Controller('health')
class HealthController {
  @Get()
  ok() {
    return { status: 'ok' };
  }
}

export function databaseOptions(config: ConfigService): TypeOrmModuleOptions {
  const entities = [Conversation, Message];
  if (config.get('DB_TYPE', 'postgres') === 'memory') {
    // In-memory SQL database for a quick try without PostgreSQL. Data is lost on restart.
    return { type: 'sqljs', entities, synchronize: true };
  }
  return {
    type: 'postgres',
    url: config.get('DATABASE_URL', 'postgres://postgres:postgres@localhost:5432/aichat'),
    entities,
    // Fine for a demo. In a real app, use migrations instead of synchronize.
    synchronize: true,
  };
}

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    TypeOrmModule.forRootAsync({ inject: [ConfigService], useFactory: databaseOptions }),
    // 20 requests per minute per client IP. Key this by user id once the app has auth.
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 20 }]),
    LlmModule,
    ChatModule,
  ],
  controllers: [HealthController],
  providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class AppModule {}
