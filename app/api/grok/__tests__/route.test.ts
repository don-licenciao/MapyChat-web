import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const encoder = new TextEncoder();

const buildStream = () =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"hola"}}]}\n\n'));
      controller.enqueue(encoder.encode('data: [DONE]\n\n'));
      controller.close();
    },
  });

const BASE_BODY = {
  model: 'grok-4-fast-reasoning',
  temperature: 0.8,
  systemPrompt: 'hola',
  characterPrompt: '',
};

type BodyOverrides = Record<string, unknown>;

const buildRequest = (overrides: BodyOverrides = {}) =>
  new NextRequest('https://example.com/api/grok', {
    method: 'POST',
    headers: new Headers({
      'content-type': 'application/json',
      origin: 'https://example.com',
    }),
    body: JSON.stringify({
      ...BASE_BODY,
      messages: [{ role: 'user', content: 'hola' }],
      ...overrides,
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

  it('procesa mensajes multimodales con texto e imagen embebida y conserva encabezados RateLimit-*', async () => {
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
    const imageDataUrl =
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Yl7iOsAAAAASUVORK5CYII=';

    const response = await POST(
      buildRequest({
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'hola' },
              { type: 'image_url', image_url: { url: imageDataUrl, detail: 'auto' } },
            ],
          },
        ],
        responseLevel: 4,
      }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('ratelimit-limit')).toBe('10');
    expect(response.headers.get('ratelimit-remaining')).toBe('9');

    const fetchArgs = fetchMock.mock.calls[0];
    expect(fetchArgs).toBeDefined();
    const payload = JSON.parse(fetchArgs[1]?.body as string);
    expect(payload.messages).toHaveLength(2);
    const userMessage = payload.messages[1];
    expect(Array.isArray(userMessage.content)).toBe(true);
    expect(userMessage.content[0]).toEqual({ type: 'text', text: 'hola' });
    expect(userMessage.content[1]).toEqual({
      type: 'image_url',
      image_url: { url: imageDataUrl, detail: 'auto' },
    });
    expect(payload.max_output_tokens).toBe(1024);
  });

  it('mantiene el orden de múltiples imágenes en el contenido del usuario', async () => {
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
    const firstUrl = 'https://cdn.example.com/uno.jpg';
    const secondUrl = 'https://cdn.example.com/dos.png';

    const response = await POST(
      buildRequest({
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'hola' },
              { type: 'image_url', image_url: { url: firstUrl, detail: 'low' } },
              { type: 'image_url', image_url: { url: secondUrl, detail: 'high' } },
            ],
          },
        ],
      }),
    );

    expect(response.status).toBe(200);
    const body = JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string);
    const content = body.messages[1].content;
    expect(content[0]).toEqual({ type: 'text', text: 'hola' });
    expect(content[1]).toEqual({ type: 'image_url', image_url: { url: firstUrl, detail: 'low' } });
    expect(content[2]).toEqual({ type: 'image_url', image_url: { url: secondUrl, detail: 'high' } });
  });

  it('normaliza valores inválidos de detail a auto', async () => {
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
    const imageUrl = 'https://cdn.example.com/img.png';

    const response = await POST(
      buildRequest({
        messages: [
          {
            role: 'user',
            content: [{ type: 'image_url', image_url: { url: imageUrl, detail: 'ultra' } }],
          },
        ],
      }),
    );

    expect(response.status).toBe(200);
    const body = JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string);
    expect(body.messages[1].content[0]).toEqual({
      type: 'image_url',
      image_url: { url: imageUrl, detail: 'auto' },
    });
  });

  it('rechaza data URLs mayores a 20 MiB con error 400', async () => {
    const { POST } = await import('../route');
    const bytes = 20 * 1024 * 1024 + 10;
    const base64Length = Math.ceil(bytes / 3) * 4;
    const oversizedBase64 = 'A'.repeat(base64Length);
    const bigDataUrl = `data:image/png;base64,${oversizedBase64}`;

    const response = await POST(
      buildRequest({
        messages: [
          {
            role: 'user',
            content: [{ type: 'image_url', image_url: { url: bigDataUrl } }],
          },
        ],
      }),
    );

    expect(response.status).toBe(400);
    const payload = await response.json();
    expect(payload.error).toMatch(/20 MiB/);
  });

  it('acepta mensajes solo de texto y aplica límites por defecto', async () => {
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

    const response = await POST(buildRequest());
    expect(response.status).toBe(200);
    const body = JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string);
    expect(body.max_output_tokens).toBe(512);
    expect(body.messages[0]).toEqual({ role: 'system', content: 'hola' });
    expect(body.messages[1]).toEqual({ role: 'user', content: 'hola' });
  });

  it('devuelve 429 con encabezados Retry-After y RateLimit-* cuando se excede el límite', async () => {
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
});
