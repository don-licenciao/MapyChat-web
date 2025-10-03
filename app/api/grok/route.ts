import { NextRequest, NextResponse } from 'next/server';
import { guardOrThrow } from '@/lib/nsfwGuard';

type DetailLevel = 'auto' | 'low' | 'high';

type TextPart = { type: 'text'; text: string };
type ImagePart = { type: 'image_url'; image_url: { url: string; detail: DetailLevel } };
type MessagePart = TextPart | ImagePart;
type MessageContent = string | MessagePart[];

type ChatMessage = {
  role: 'system' | 'user' | 'assistant';
  content: MessageContent;
};

type RequestBody = {
  model?: string;
  temperature?: number;
  systemPrompt?: string;
  characterPrompt?: string;
  messages?: unknown;
  responseLevel?: number;
  maxTokens?: number;
};

const ALLOWED_MODELS = new Set(['grok-4-fast-reasoning', 'grok-4-fast-non-reasoning']);

const RATE_LIMIT_WINDOW_MS = Number.parseInt(process.env.RATE_LIMIT_WINDOW_MS ?? '60000', 10);
const RATE_LIMIT_MAX_REQUESTS = Number.parseInt(process.env.RATE_LIMIT_MAX_REQUESTS ?? '10', 10);

const BASE = 128;
const MIN_OUTPUT_TOKENS = BASE;
const MAX_OUTPUT_TOKENS = BASE * 2 ** (5 - 1);
const DEFAULT_OUTPUT_TOKENS = BASE * 2 ** (3 - 1);

const TOKEN_FIELD = 'max_output_tokens' as const; // Grok expects max_output_tokens to limit the response length.

const MAX_MESSAGES = 50;
const MAX_TEXT_CHARS = 8000;
const MAX_PROMPT_CHARS = 4000;
const MAX_DATA_URL_BYTES = 20 * 1024 * 1024; // 20 MiB

const DATA_URL_PATTERN = /^data:image\/(png|jpe?g);base64,([a-z0-9+/=\r\n]+)$/i;

const DETAIL_LEVELS: DetailLevel[] = ['auto', 'low', 'high'];

type RateEntry = {
  count: number;
  resetAt: number;
};

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

const sanitizePrompt = (value: string) => value.replace(/[\x00-\x1F\x7F-\x9F]/g, '').trim();

const sanitizeTextSegment = (value: string) =>
  value.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/g, '');

const normalizeDetail = (detail?: string): DetailLevel => {
  if (!detail) return 'auto';
  const lowered = detail.toLowerCase();
  return DETAIL_LEVELS.includes(lowered as DetailLevel) ? (lowered as DetailLevel) : 'auto';
};

const isHttpUrl = (url: string) => {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch (error) {
    return false;
  }
};

const getDataUrlPayload = (url: string) => {
  const match = DATA_URL_PATTERN.exec(url);
  if (!match) {
    return null;
  }
  const [, mime, rawBase64] = match;
  const base64 = rawBase64.replace(/\s+/g, '');
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
  const bytes = Math.floor(base64.length / 4) * 3 - padding;
  return { mime: mime.toLowerCase(), base64, bytes };
};

const isValidDataUrl = (url: string) => Boolean(getDataUrlPayload(url));

const coerceMessage = (input: unknown): ChatMessage => {
  if (!input || typeof input !== 'object') {
    throw new Error('Mensaje inválido');
  }

  const role = (input as { role?: unknown }).role;
  if (role !== 'system' && role !== 'user' && role !== 'assistant') {
    throw new Error('Rol de mensaje inválido.');
  }

  const rawContent = (input as { content?: unknown }).content;

  if (typeof rawContent === 'string') {
    const sanitized = sanitizeTextSegment(rawContent);
    if (!sanitized || sanitized.length > MAX_TEXT_CHARS) {
      throw new Error('Mensaje inválido');
    }
    return { role, content: sanitized } satisfies ChatMessage;
  }

  if (!Array.isArray(rawContent)) {
    throw new Error('Mensaje inválido');
  }

  const parts: MessagePart[] = [];

  for (const part of rawContent) {
    if (!part || typeof part !== 'object') {
      throw new Error('Mensaje inválido');
    }

    const type = (part as { type?: unknown }).type;

    if (type === 'text') {
      const textValue = sanitizeTextSegment((part as { text?: unknown }).text as string);
      if (!textValue || textValue.length > MAX_TEXT_CHARS) {
        throw new Error('Mensaje inválido');
      }
      parts.push({ type: 'text', text: textValue });
      continue;
    }

    if (type === 'image_url') {
      const imagePart = (part as { image_url?: unknown }).image_url;
      if (!imagePart || typeof imagePart !== 'object') {
        throw new Error('Mensaje inválido');
      }
      const url = ((imagePart as { url?: unknown }).url as string | undefined)?.trim() ?? '';
      if (!url) {
        throw new Error('URL de imagen inválida');
      }

      const detail = normalizeDetail((imagePart as { detail?: unknown }).detail as string | undefined);

      if (url.startsWith('data:')) {
        const payload = getDataUrlPayload(url);
        if (!payload) {
          throw new Error('Data URL de imagen inválida');
        }
        if (payload.bytes > MAX_DATA_URL_BYTES) {
          throw new Error('La imagen adjunta supera el límite de 20 MiB');
        }
      } else if (!isHttpUrl(url)) {
        throw new Error('URL de imagen inválida');
      }

      parts.push({ type: 'image_url', image_url: { url, detail } });
      continue;
    }

    throw new Error('Mensaje inválido');
  }

  if (parts.length === 0) {
    throw new Error('Mensaje inválido');
  }

  return { role, content: parts } satisfies ChatMessage;
};

const extractTextSegments = (content: MessageContent): string[] => {
  if (typeof content === 'string') {
    return [content];
  }
  return content.filter((part): part is TextPart => part.type === 'text').map((part) => part.text);
};

function tokensForLevel(level: number): number {
  const n = Math.max(1, Math.min(5, Math.floor(Number.isFinite(level) ? level : 3)));
  return BASE * 2 ** (n - 1);
}

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

    const body = (await req.json()) as RequestBody;
    const { model, temperature, systemPrompt, characterPrompt, messages, responseLevel, maxTokens } = body;

    if (!model || !ALLOWED_MODELS.has(model)) {
      return jsonError('Modelo no válido', 400, 'bad_request', rateLimitHeaders);
    }

    if (typeof systemPrompt !== 'string' || systemPrompt.length === 0 || systemPrompt.length > MAX_PROMPT_CHARS) {
      return jsonError('systemPrompt inválido o demasiado largo', 400, 'bad_request', rateLimitHeaders);
    }

    const systemPromptValue = sanitizePrompt(systemPrompt);
    if (systemPromptValue.length === 0) {
      return jsonError('systemPrompt inválido o demasiado largo', 400, 'bad_request', rateLimitHeaders);
    }

    const characterPromptValue =
      typeof characterPrompt === 'string' ? sanitizePrompt(characterPrompt).slice(0, MAX_PROMPT_CHARS) : '';

    if (!Array.isArray(messages) || messages.length === 0 || messages.length > MAX_MESSAGES) {
      return jsonError('messages inválido o demasiados elementos', 400, 'bad_request', rateLimitHeaders);
    }

    let safeMsgs: ChatMessage[];
    try {
      safeMsgs = messages.map((message) => coerceMessage(message));
    } catch (parseError) {
      const errorMessage = parseError instanceof Error ? parseError.message : 'Mensaje inválido';
      return jsonError(errorMessage, 400, 'bad_request', rateLimitHeaders);
    }

    if (characterPromptValue) {
      safeMsgs = [{ role: 'system', content: characterPromptValue }, ...safeMsgs];
    }

    const lastUserMessage = [...safeMsgs].reverse().find((msg) => msg.role === 'user');
    if (!lastUserMessage) {
      return jsonError('No hay mensaje de usuario', 400, 'bad_request', rateLimitHeaders);
    }

    const textSegments = extractTextSegments(lastUserMessage.content);
    for (const segment of textSegments) {
      try {
        guardOrThrow(segment);
      } catch (error) {
        if (error instanceof Error) {
          return jsonError(error.message, 400, 'bad_request', rateLimitHeaders);
        }
        return jsonError('Contenido no permitido', 400, 'bad_request', rateLimitHeaders);
      }
    }

    const clampedTemp = Math.min(Math.max(typeof temperature === 'number' ? temperature : 0.8, 0), 2);

    let resolvedMaxTokens: number;
    if (typeof responseLevel === 'number' && Number.isFinite(responseLevel)) {
      resolvedMaxTokens = tokensForLevel(responseLevel);
    } else if (typeof maxTokens === 'number' && Number.isFinite(maxTokens)) {
      const coerced = Math.floor(maxTokens);
      resolvedMaxTokens = Math.min(Math.max(coerced, MIN_OUTPUT_TOKENS), MAX_OUTPUT_TOKENS);
    } else {
      resolvedMaxTokens = DEFAULT_OUTPUT_TOKENS;
    }

    const systemMsg: ChatMessage = { role: 'system', content: systemPromptValue };
    const finalMsgs: ChatMessage[] = [systemMsg, ...safeMsgs].slice(-51);

    const payload = {
      model,
      temperature: clampedTemp,
      stream: true,
      messages: finalMsgs,
      [TOKEN_FIELD]: resolvedMaxTokens,
    } satisfies {
      model: string;
      temperature: number;
      stream: boolean;
      messages: ChatMessage[];
      [TOKEN_FIELD]: number;
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
