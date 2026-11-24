import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';

process.env.DB_TYPE = 'memory';
process.env.LLM_PROVIDER = 'mock';
process.env.CONTEXT_BUDGET_TOKENS = '250'; // tiny, so summarising kicks in after a few turns
process.env.REPLY_RESERVE_TOKENS = '50';
process.env.MOCK_DELAY_MS = '1';
jest.setTimeout(20_000);

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { AppModule } = require('../src/app.module');

function parseSse(body: string) {
  return body
    .split('\n\n')
    .filter((block) => block.startsWith('event:'))
    .map((block) => JSON.parse(block.split('\n').find((l) => l.startsWith('data: '))!.slice(6)));
}

describe('Chat API (end to end, in-memory DB, mock model)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
  });
  afterAll(() => app.close());

  it('streams a reply as SSE and saves both messages', async () => {
    const conv = await request(app.getHttpServer()).post('/conversations').send({}).expect(201);
    const res = await request(app.getHttpServer())
      .post(`/conversations/${conv.body.id}/messages`)
      .send({ content: 'Hello there' })
      .expect(200)
      .expect('Content-Type', /text\/event-stream/);

    const events = parseSse(res.text);
    expect(events.filter((e) => e.type === 'token').length).toBeGreaterThan(3);
    expect(events[events.length - 1]).toMatchObject({ type: 'done', status: 'complete' });

    const history = await request(app.getHttpServer()).get(`/conversations/${conv.body.id}/messages`).expect(200);
    expect(history.body.map((m: any) => m.role)).toEqual(['user', 'assistant']);
    expect(history.body[1].content).toContain('Hello there');
  });

  it('summarises older turns instead of dropping them when the budget is exceeded', async () => {
    const conv = await request(app.getHttpServer()).post('/conversations').send({}).expect(201);
    let last = '';
    for (let i = 1; i <= 4; i++) {
      const res = await request(app.getHttpServer())
        .post(`/conversations/${conv.body.id}/messages`)
        .send({ content: `Message number ${i}: ` + 'details '.repeat(25) })
        .expect(200);
      last = parseSse(res.text).filter((e) => e.type === 'token').map((e) => e.text).join('');
    }
    expect(last).toContain('plus a summary of older turns');
  });

  it('stops the model when the client disconnects and keeps the partial reply', async () => {
    // A separate app whose mock model types slowly, so the disconnect lands mid-reply.
    process.env.MOCK_DELAY_MS = '50';
    const slow = (await Test.createTestingModule({ imports: [AppModule] }).compile()).createNestApplication();
    process.env.MOCK_DELAY_MS = '1';
    slow.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await slow.listen(0);
    const base = `http://127.0.0.1:${(slow.getHttpServer().address() as any).port}`;
    const conv: any = await (await fetch(`${base}/conversations`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).json();

    const abort = new AbortController();
    const res = await fetch(`${base}/conversations/${conv.id}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'stop me' }),
      signal: abort.signal,
    });
    const reader = res.body!.getReader();
    await reader.read(); // first chunk arrived: the stream is running
    abort.abort();
    await new Promise((r) => setTimeout(r, 300));

    const history: any = await (await fetch(`${base}/conversations/${conv.id}/messages`)).json();
    expect(history.map((m: any) => m.role)).toEqual(['user', 'assistant']);
    expect(history[1].status).toBe('stopped');
    expect(history[1].content.length).toBeGreaterThan(0);
    expect(history[1].content).not.toContain('real model'); // cut off before the end
    await slow.close();
  });

  it('rejects empty and oversized messages', async () => {
    const conv = await request(app.getHttpServer()).post('/conversations').send({}).expect(201);
    await request(app.getHttpServer()).post(`/conversations/${conv.body.id}/messages`).send({ content: '' }).expect(400);
    await request(app.getHttpServer())
      .post(`/conversations/${conv.body.id}/messages`)
      .send({ content: 'x'.repeat(4001) })
      .expect(400);
  });

  it('returns 404 for an unknown conversation', async () => {
    await request(app.getHttpServer())
      .post('/conversations/00000000-0000-4000-8000-000000000000/messages')
      .send({ content: 'hi' })
      .expect(404);
  });
});
