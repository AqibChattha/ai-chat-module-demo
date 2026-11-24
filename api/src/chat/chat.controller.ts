import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Res } from '@nestjs/common';
import type { Response } from 'express';
import { ChatService } from './chat.service';
import { CreateConversationDto, SendMessageDto } from './dto/chat.dto';

@Controller('conversations')
export class ChatController {
  constructor(private readonly chat: ChatService) {}

  @Post()
  create(@Body() dto: CreateConversationDto) {
    return this.chat.createConversation(dto.title);
  }

  @Get(':id/messages')
  history(@Param('id', ParseUUIDPipe) id: string) {
    return this.chat.history(id);
  }

  /**
   * Streams the reply as Server-Sent Events over a POST response
   * (events: token, done, error). If the client goes away, the model call is
   * aborted, so a closed tab never keeps a stream (and its cost) running.
   */
  @Post(':id/messages')
  async send(@Param('id', ParseUUIDPipe) id: string, @Body() dto: SendMessageDto, @Res() res: Response) {
    await this.chat.getConversation(id); // 404 as normal JSON before the stream starts

    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no'); // disable proxy buffering (nginx)
    res.flushHeaders();

    const abort = new AbortController();
    res.on('close', () => {
      if (!res.writableEnded) abort.abort();
    });
    const heartbeat = setInterval(() => res.write(': ping\n\n'), 15000);

    try {
      // Keep consuming after a disconnect: the aborted signal ends the model call,
      // and the service then saves the partial reply. Only the writes stop.
      for await (const event of this.chat.reply(id, dto.content, abort.signal)) {
        if (!abort.signal.aborted) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      }
    } catch {
      if (!abort.signal.aborted) {
        res.write(`event: error\ndata: ${JSON.stringify({ type: 'error', message: 'Something went wrong.' })}\n\n`);
      }
    } finally {
      clearInterval(heartbeat);
      if (!res.writableEnded) res.end();
    }
  }
}
