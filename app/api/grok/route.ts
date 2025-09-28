import { NextRequest, NextResponse } from 'next/server';
import { guardOrThrow } from '@/lib/nsfwGuard';

type ChatMessage = {
  role: 'system' | 'user' | 'assistant';
  content: string;
};

type RequestBody = {
  model: string;
  temperature?: number;
  systemPrompt: string;
  messages: ChatMessage[];
};

const ALLOWED_MODELS = new Set(['grok-4-fast-reasoning', 'grok-4-fast-non-reasoning']);

const RATE_LIMIT_WINDOW_MS = Number.parseInt(process.env.RATE_LIMIT_WINDOW_MS ?? '60000', 10);
const RATE_LIMIT_MAX_REQUESTS = Number.parseInt(process.env.RATE_LIMIT_MAX_REQUESTS ?? '10', 10);

type RateEntry = {
  count: number;
  resetAt: number;
};

// Edge runtime keeps module scope between invocations on the same isolate.
const rateState = new Map<string, RateEntry>();

const getClientId = (req: NextRequest) => {
  const forwarded = req.headers.get('x-forwarded-for');
  if (forwarded) {
    return forwarded.split(',')[0]?.trim() || 'unknown';
  }
  return req.ip ?? 'unknown';
};

type RateLimitResult =
  | {
      allowed: true;
      limit: number;
      remaining: number;
      resetSeconds: number;
    }
  | {
      allowed: false;
      limit: number;
      retryAfterSeconds: number;
      resetSeconds: number;
    };

const cleanupRateState = (now: number) => {
  for (const [id, entry] of rateState.entries()) {
    if (entry.resetAt <= now) {
      rateState.delete(id);
    }
  }
};

const applyRateLimit = (clientId: string): RateLimitResult => {
  const now = Date.now();
  cleanupRateState(now);

  const limit = Number.isFinite(RATE_LIMIT_MAX_REQUESTS) && RATE_LIMIT_MAX_REQUESTS > 0 ? RATE_LIMIT_MAX_REQUESTS : 10;
  const windowMs = Number.isFinite(RATE_LIMIT_WINDOW_MS) && RATE_LIMIT_WINDOW_MS > 0 ? RATE_LIMIT_WINDOW_MS : 60_000;

  const existing = rateState.get(clientId);
  const resetSeconds = existing
    ? Math.max(1, Math.ceil((existing.resetAt - now) / 1000))
    : Math.max(1, Math.ceil(windowMs / 1000));

  if (!existing || existing.resetAt <= now) {
    const resetAt = now + windowMs;
    rateState.set(clientId, { count: 1, resetAt });
    return {
      allowed: true,
      limit,
      remaining: Math.max(0, limit - 1),
      resetSeconds: Math.max(1, Math.ceil((resetAt - now) / 1000)),
    };
  }

  if (existing.count >= limit) {
    const retryAfterSeconds = Math.max(1, Math.ceil((existing.resetAt - now) / 1000));
    return {
      allowed: false,
      limit,
      retryAfterSeconds,
      resetSeconds: retryAfterSeconds,
    };
  }

  existing.count += 1;
  rateState.set(clientId, existing);

  return {
    allowed: true,
    limit,
    remaining: Math.max(0, limit - existing.count),
    resetSeconds,
  };
};

export const runtime = 'edge';

const jsonError = (
  message: string,
  status: number,
  code: string,
  headers?: Record<string, string>,
) => NextResponse.json({ error: message, code }, { status, headers });

export async function POST(req: NextRequest) {
  let rateLimitHeaders: Record<string, string> | undefined;
  try {
    const origin = new URL(req.url).origin;
    const requestOrigin = req.headers.get('origin');
    if (requestOrigin && requestOrigin !== origin) {
      return jsonError('Acceso prohibido: Origen no autorizado', 403, 'forbidden');
    }

    const contentType = req.headers.get('content-type');
    if (!contentType || !contentType.includes('application/json')) {
      return jsonError('Content-Type debe ser application/json', 415, 'unsupported_media_type');
    }

    const clientId = getClientId(req);
    const rateLimit = applyRateLimit(clientId);

    if (!rateLimit.allowed) {
      const retryAfter = rateLimit.retryAfterSeconds;
      return jsonError(
        'Demasiadas solicitudes. Intenta de nuevo en unos segundos.',
        429,
        'rate_limited',
        {
          'Retry-After': retryAfter.toString(),
          'RateLimit-Limit': rateLimit.limit.toString(),
          'RateLimit-Remaining': '0',
          'RateLimit-Reset': rateLimit.resetSeconds.toString(),
        },
      );
    }

    rateLimitHeaders = {
      'RateLimit-Limit': rateLimit.limit.toString(),
      'RateLimit-Remaining': Math.max(0, rateLimit.remaining).toString(),
      'RateLimit-Reset': rateLimit.resetSeconds.toString(),
    };

    const body = (await req.json()) as Partial<RequestBody>;
    const { model, temperature, systemPrompt, messages } = body;

    if (!model || !ALLOWED_MODELS.has(model)) {
      return jsonError('Modelo no válido', 400, 'bad_request', rateLimitHeaders);
    }

    if (typeof systemPrompt !== 'string' || systemPrompt.length === 0 || systemPrompt.length > 4000) {
      return jsonError('systemPrompt inválido o demasiado largo', 400, 'bad_request', rateLimitHeaders);
    }

    if (!Array.isArray(messages) || messages.length === 0 || messages.length > 50) {
      return jsonError('messages inválido o demasiados elementos', 400, 'bad_request', rateLimitHeaders);
    }

    for (const message of messages) {
      if (
        !message ||
        (message.role !== 'user' && message.role !== 'assistant' && message.role !== 'system') ||
        typeof message.content !== 'string' ||
        message.content.length === 0 ||
        message.content.length > 8000
      ) {
        return jsonError('Mensaje inválido', 400, 'bad_request', rateLimitHeaders);
      }
    }

    const lastUserMessage = [...messages].reverse().find((msg) => msg.role === 'user');
    if (!lastUserMessage) {
      return jsonError('No hay mensaje de usuario', 400, 'bad_request', rateLimitHeaders);
    }

    guardOrThrow(lastUserMessage.content);

    const clampedTemp = Math.min(Math.max(typeof temperature === 'number' ? temperature : 0.8, 0), 2);

    const payload = {
      model,
      temperature: clampedTemp,
      stream: true,
      messages: [{ role: 'system', content: systemPrompt }, ...messages].slice(-51),
    } satisfies {
      model: string;
      temperature: number;
      stream: boolean;
      messages: ChatMessage[];
    };

    const apiKey = process.env.XAI_API_KEY;
    if (!apiKey) {
      return jsonError('Configuración del servidor incompleta', 500, 'internal_server_error', rateLimitHeaders);
    }

    const apiRes = await fetch('https://api.x.ai/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    if (!apiRes.ok || !apiRes.body) {
      let errorMessage = 'Error en la API de xAI';
      try {
        const errorJson = await apiRes.json();
        if (typeof errorJson?.error === 'string') {
          errorMessage = errorJson.error;
        }
      } catch (error) {
        console.error('No se pudo parsear error de xAI:', error);
      }
      console.error('Error de xAI API:', apiRes.status, errorMessage);
      return jsonError(errorMessage, apiRes.status || 502, 'internal_server_error', rateLimitHeaders);
    }

    return new NextResponse(apiRes.body, {
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-Robots-Tag': 'noindex',
        ...rateLimitHeaders,
      },
    });
  } catch (error) {
    console.error('Error en proxy:', error);
    if (error instanceof Error && error.message.includes('viola nuestras reglas')) {
      return jsonError(error.message, 400, 'bad_request', rateLimitHeaders);
    }
    return jsonError('Error interno del servidor', 500, 'internal_server_error', rateLimitHeaders);
  }
}
