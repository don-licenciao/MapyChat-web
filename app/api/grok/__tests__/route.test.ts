import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const buildRequest = (overrides: Record<string, unknown> = {}) =>
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
      ...overrides,
    }),
  });

const encoder = new TextEncoder();
const buildStream = () =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"hola"}}]}\n\n'));
      controller.enqueue(encoder.encode('data: [DONE]\n\n'));
      controller.close();
    },
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

  it('incluye encabezados RateLimit-* y max_output_tokens según responseLevel', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(buildStream(), {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        }),
      );

    global.fetch = fetchMock;

    const { POST } = await import('../route');
    const response = await POST(buildRequest({ responseLevel: 4 }));
    const limit = response.headers.get('ratelimit-limit');
    const remaining = response.headers.get('ratelimit-remaining');
    const reset = response.headers.get('ratelimit-reset');

    expect(response.status).toBe(200);
    expect(limit).toBe('10');
    expect(remaining).toBe('9');
    expect(Number(reset)).toBeGreaterThanOrEqual(1);

    const body = JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string);
    expect(body.max_output_tokens).toBe(1024);
  });

  it('responde con 429 y encabezados informativos al superar el límite', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(buildStream(), {
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

  it('antepone el prompt de personaje como mensaje de sistema', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(buildStream(), {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        }),
      );

    global.fetch = fetchMock;

    const { POST } = await import('../route');

    const response = await POST(
      buildRequest({ characterPrompt: '  voz heroica \u0000\n' }),
    );

    expect(response.status).toBe(200);
    const fetchArgs = fetchMock.mock.calls[0];
    expect(fetchArgs).toBeDefined();
    const body = JSON.parse(fetchArgs[1]?.body as string);
    expect(body.messages).toHaveLength(3);
    expect(body.messages[0]).toEqual({ role: 'system', content: 'hola' });
    expect(body.messages[1]).toEqual({ role: 'system', content: 'voz heroica' });
    expect(body.messages[2]).toEqual({ role: 'user', content: 'hola' });
    expect(body.max_output_tokens).toBe(512);
  });

  it('aplica clamping de responseLevel y maxTokens directos', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(buildStream(), {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        }),
      );

    global.fetch = fetchMock;

    const { POST } = await import('../route');

    const highLevelResponse = await POST(buildRequest({ responseLevel: 9 }));
    expect(highLevelResponse.status).toBe(200);
    let body = JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string);
    expect(body.max_output_tokens).toBe(2048);

    fetchMock.mockClear();

    const lowLevelResponse = await POST(buildRequest({ responseLevel: 0 }));
    expect(lowLevelResponse.status).toBe(200);
    body = JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string);
    expect(body.max_output_tokens).toBe(128);

    fetchMock.mockClear();

    const defaultResponse = await POST(buildRequest());
    expect(defaultResponse.status).toBe(200);
    body = JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string);
    expect(body.max_output_tokens).toBe(512);

    fetchMock.mockClear();

    const maxTokensResponse = await POST(buildRequest({ maxTokens: 9999 }));
    expect(maxTokensResponse.status).toBe(200);
    body = JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string);
    expect(body.max_output_tokens).toBe(2048);
  });
});
