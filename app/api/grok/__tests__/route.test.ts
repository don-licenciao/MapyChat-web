import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const buildRequest = () =>
  new NextRequest('https://example.com/api/grok', {
    method: 'POST',
    headers: new Headers({
      'content-type': 'application/json',
      origin: 'https://example.com',
    }),
    body: JSON.stringify({
      model: 'grok-4-fast-reasoning',
      temperature: 0.8,
      systemPrompt: 'hola',
      messages: [{ role: 'user', content: 'hola' }],
    }),
  });

describe('POST /api/grok', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-01-01T00:00:00Z'));
    process.env.XAI_API_KEY = 'test-key';
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    vi.resetModules();
  });

  it('incluye encabezados RateLimit-* en respuestas exitosas', async () => {
    const textEncoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          textEncoder.encode('data: {"choices":[{"delta":{"content":"hola"}}] }\n\n'),
        );
        controller.enqueue(textEncoder.encode('data: [DONE]\n\n'));
        controller.close();
      },
    });

    global.fetch = vi.fn().mockResolvedValue(
      new Response(stream, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      }),
    );

    const { POST } = await import('../route');
    const response = await POST(buildRequest());
    const limit = response.headers.get('ratelimit-limit');
    const remaining = response.headers.get('ratelimit-remaining');
    const reset = response.headers.get('ratelimit-reset');

    expect(response.status).toBe(200);
    expect(limit).toBe('10');
    expect(remaining).toBe('9');
    expect(Number(reset)).toBeGreaterThanOrEqual(1);
  });

  it('responde con 429 y encabezados informativos al superar el límite', async () => {
    const textEncoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          textEncoder.encode('data: {"choices":[{"delta":{"content":"hola"}}] }\n\n'),
        );
        controller.enqueue(textEncoder.encode('data: [DONE]\n\n'));
        controller.close();
      },
    });

    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(stream, {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        }),
      );

    global.fetch = fetchMock;

    const { POST } = await import('../route');

    for (let i = 0; i < 10; i += 1) {
      const okResponse = await POST(buildRequest());
      expect(okResponse.status).toBe(200);
    }

    const limitedResponse = await POST(buildRequest());
    expect(limitedResponse.status).toBe(429);
    expect(limitedResponse.headers.get('retry-after')).toBe('60');
    expect(limitedResponse.headers.get('ratelimit-limit')).toBe('10');
    expect(limitedResponse.headers.get('ratelimit-remaining')).toBe('0');
    expect(limitedResponse.headers.get('ratelimit-reset')).toBe('60');
    expect(fetchMock).toHaveBeenCalledTimes(10);
  });
});
