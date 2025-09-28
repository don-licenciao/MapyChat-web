'use client';

import { FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import { guardOrThrow } from '@/lib/nsfwGuard';

type Message = {
  role: 'user' | 'assistant';
  content: string;
};

const DEFAULT_SYSTEM_PROMPT = `Eres un asistente útil y amigable. Siempre responde en español de México. Rechaza cualquier solicitud que involucre a menores de edad, contenido ilegal, violencia o explotación. Nunca pidas datos personales sensibles como direcciones, números de teléfono o información real. Mantén las respuestas seguras y responsables.`;
const DEFAULT_CHARACTER_PROMPT = '';

const estimateSegmentTokens = (segment: string) => {
  const sanitized = segment.replace(/\s+/g, ' ').trim();
  if (!sanitized) return 0;
  const words = sanitized.split(' ').filter(Boolean).length;
  const punctuation = sanitized.match(/[^\w\s]/g)?.length ?? 0;
  const charBased = Math.ceil(sanitized.length / 4);
  return Math.max(charBased, words + Math.ceil(punctuation / 4));
};

const STORAGE_KEY = 'mapychat.age.v1';
const MAX_STREAM_RETRIES = 2;
const RETRY_BASE_DELAY_MS = 1000;

export default function Home() {
  const [ageConfirmed, setAgeConfirmed] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [systemPrompt, setSystemPrompt] = useState(DEFAULT_SYSTEM_PROMPT);
  const [model, setModel] = useState('grok-4-fast-reasoning');
  const [temperature, setTemperature] = useState(0.8);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [characterPrompt, setCharacterPrompt] = useState(DEFAULT_CHARACTER_PROMPT);
  const [showSystemPrompt, setShowSystemPrompt] = useState(true);
  const [showCharacterPrompt, setShowCharacterPrompt] = useState(false);
  const abortControllerRef = useRef<AbortController | null>(null);
  const chatRef = useRef<HTMLDivElement | null>(null);

  const approximateTokenCount = useMemo(() => {
    const historyTokens = messages.reduce(
      (total, message) => total + estimateSegmentTokens(message.content),
      0,
    );
    return (
      estimateSegmentTokens(systemPrompt) +
      estimateSegmentTokens(characterPrompt) +
      historyTokens +
      estimateSegmentTokens(input)
    );
  }, [messages, systemPrompt, characterPrompt, input]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      const stored = window.localStorage.getItem(STORAGE_KEY);
      if (stored) {
        const data = JSON.parse(stored) as { ok?: boolean; ts?: number };
        if (data?.ok && data?.ts) {
          setAgeConfirmed(true);
        }
      }
    } catch (storageError) {
      console.error('No se pudo leer Age Gate almacenado:', storageError);
    }
  }, []);

  useEffect(() => {
    if (!chatRef.current) return;
    chatRef.current.scrollTop = chatRef.current.scrollHeight;
  }, [messages]);

  const confirmAge = () => {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ ok: true, ts: Date.now() }));
    } catch (storageError) {
      console.error('No se pudo persistir Age Gate:', storageError);
    }
    setAgeConfirmed(true);
  };

  const sanitizePrompt = (value: string) => value.replace(/[\x00-\x1F\x7F-\x9F]/g, '');

  const handleSystemPromptChange = (value: string) => {
    const sanitized = sanitizePrompt(value);
    setSystemPrompt(sanitized.slice(0, 4000));
  };

  const handleCharacterPromptChange = (value: string) => {
    const sanitized = sanitizePrompt(value);
    setCharacterPrompt(sanitized.slice(0, 4000));
  };

  const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  const streamWithRetries = async (
    payload: {
      model: string;
      temperature: number;
      systemPrompt: string;
      characterPrompt: string;
      messages: Message[];
    },
    attempt = 0,
  ): Promise<void> => {
    const controller = new AbortController();
    abortControllerRef.current = controller;

    try {
      const response = await fetch('/api/grok', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'text/event-stream',
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      if (!response.ok) {
        let errorMessage = 'Error en la solicitud';
        try {
          const errorJson = await response.json();
          if (typeof errorJson?.error === 'string') {
            errorMessage = errorJson.error;
          }
        } catch (parseError) {
          console.error('No se pudo parsear error del proxy:', parseError);
        }
        throw new Error(errorMessage);
      }

      const reader = response.body?.getReader();
      if (!reader) {
        throw new Error('No se pudo leer la respuesta del servidor');
      }

      const decoder = new TextDecoder();
      let buffer = '';
      let done = false;

      while (!done) {
        const { value, done: readerDone } = await reader.read();
        done = readerDone;
        if (value) {
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';

          for (const rawLine of lines) {
            const line = rawLine.trim();
            if (!line.startsWith('data:')) {
              continue;
            }
            const data = line.slice(5).trim();
            if (!data) {
              continue;
            }
            if (data === '[DONE]') {
              done = true;
              break;
            }
            try {
              const parsed = JSON.parse(data) as {
                choices?: { delta?: { content?: string } }[];
              };
              const content = parsed.choices?.[0]?.delta?.content;
              if (content) {
                setMessages((prev) => {
                  const updated = [...prev];
                  const lastIndex = updated.length - 1;
                  if (lastIndex >= 0) {
                    const last = updated[lastIndex];
                    updated[lastIndex] = { ...last, content: `${last.content}${content}` };
                  }
                  return updated;
                });
              }
            } catch (streamError) {
              console.error('No se pudo parsear chunk SSE:', streamError);
            }
          }
        }
      }
    } catch (error) {
      if ((error as Error).name === 'AbortError') {
        throw error;
      }

      if (attempt < MAX_STREAM_RETRIES) {
        abortControllerRef.current = null;
        const backoff = RETRY_BASE_DELAY_MS * (attempt + 1);
        await delay(backoff);
        return streamWithRetries(payload, attempt + 1);
      }

      throw error;
    } finally {
      if (abortControllerRef.current === controller) {
        abortControllerRef.current = null;
      }
    }
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const sanitizedInput = input.trim();
    if (!sanitizedInput || isLoading) return;

    setError(null);

    try {
      guardOrThrow(sanitizedInput);
    } catch (guardError) {
      setError('Lo siento, eso viola nuestras reglas de contenido seguro. ¿Quieres probar algo diferente?');
      return;
    }

    const nextMessages: Message[] = [...messages, { role: 'user', content: sanitizedInput }];
    setMessages([...nextMessages, { role: 'assistant', content: '' }]);
    setInput('');
    setIsLoading(true);

    try {
      await streamWithRetries(
        {
          model,
          temperature,
          systemPrompt,
          characterPrompt,
          messages: nextMessages,
        },
        0,
      );
    } catch (fetchError) {
      if ((fetchError as Error).name !== 'AbortError') {
        setError((fetchError as Error).message || 'Error de conexión. Intenta de nuevo.');
        setMessages((prev) => {
          if (!prev.length) {
            return prev;
          }
          const updated = [...prev];
          const last = updated[updated.length - 1];
          if (last.role === 'assistant' && last.content.length === 0) {
            updated.pop();
          }
          return updated;
        });
      }
    } finally {
      setIsLoading(false);
      if (abortControllerRef.current) {
        abortControllerRef.current = null;
      }
    }
  };

  const stopStreaming = () => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
  };

  if (!ageConfirmed) {
    return (
      <div className="flex h-screen items-center justify-center bg-gray-900 text-white">
        <div className="max-w-sm rounded-lg bg-gray-800 p-8 text-center shadow-lg">
          <p className="mb-6 text-lg">Esta app es solo para mayores de 18 años.</p>
          <button
            type="button"
            onClick={confirmAge}
            className="rounded bg-blue-600 px-4 py-2 font-semibold transition hover:bg-blue-500"
          >
            Soy mayor de 18 y acepto
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="relative flex h-screen flex-col bg-gray-900 text-white">
      <div className="pointer-events-none fixed right-4 top-4 rounded-full bg-gray-800/80 px-5 py-2 text-sm font-medium text-gray-200 shadow">
        Tokens aprox: {approximateTokenCount}
      </div>
      <header className="border-b border-gray-800 bg-gray-950/70 p-4 lg:px-8">
        <h1 className="text-2xl font-semibold">MapyChat Web</h1>
        <p className="text-sm text-gray-400">Streaming SSE con Grok y guardas de seguridad reforzadas.</p>
      </header>
      <main
        ref={chatRef}
        className="flex-1 space-y-5 overflow-y-auto px-4 py-4 md:px-8 lg:px-16"
      >
        {messages.map((message, index) => (
          <div
            key={`${message.role}-${index}`}
            className={`flex w-full ${message.role === 'user' ? 'justify-end' : 'justify-start'}`}
          >
            <div
              className={`w-full max-w-4xl whitespace-pre-wrap rounded-xl px-5 py-3 text-base shadow-md transition ${
                message.role === 'user' ? 'bg-blue-600/80' : 'bg-gray-800/80'
              }`}
            >
              {message.content || (message.role === 'assistant' ? '…' : '')}
            </div>
          </div>
        ))}
        {error && <p className="text-sm text-red-400">{error}</p>}
      </main>
      <form onSubmit={handleSubmit} className="space-y-4 border-t border-gray-800 bg-gray-950/70 p-4 lg:px-8">
        <div className="grid gap-4 lg:grid-cols-2">
          <div className="rounded-md border border-gray-800 bg-gray-900/60">
            <div className="flex items-center justify-between gap-4 border-b border-gray-800 px-4 py-3">
              <div>
                <label htmlFor="systemPrompt" className="text-sm font-medium text-gray-200">
                  System Prompt
                </label>
                <p className="text-xs text-gray-400">Configura el comportamiento base del asistente.</p>
              </div>
              <button
                type="button"
                onClick={() => setShowSystemPrompt((prev) => !prev)}
                className="rounded-md border border-gray-700 px-3 py-1 text-xs font-semibold text-gray-200 transition hover:border-blue-500 hover:text-white"
                aria-expanded={showSystemPrompt}
              >
                Mostrar / Ocultar
              </button>
            </div>
            {showSystemPrompt && (
              <textarea
                id="systemPrompt"
                value={systemPrompt}
                onChange={(event) => handleSystemPromptChange(event.target.value)}
                className="h-32 w-full rounded-b-md border-0 bg-transparent p-4 text-sm text-white focus:outline-none"
                maxLength={4000}
              />
            )}
          </div>
          <div className="rounded-md border border-gray-800 bg-gray-900/60">
            <div className="flex items-center justify-between gap-4 border-b border-gray-800 px-4 py-3">
              <div>
                <label htmlFor="characterPrompt" className="text-sm font-medium text-gray-200">
                  Prompt de personaje
                </label>
                <p className="text-xs text-gray-400">Define voz y rasgos del personaje.</p>
              </div>
              <button
                type="button"
                onClick={() => setShowCharacterPrompt((prev) => !prev)}
                className="rounded-md border border-gray-700 px-3 py-1 text-xs font-semibold text-gray-200 transition hover:border-blue-500 hover:text-white"
                aria-expanded={showCharacterPrompt}
              >
                Mostrar / Ocultar
              </button>
            </div>
            {showCharacterPrompt && (
              <textarea
                id="characterPrompt"
                value={characterPrompt}
                onChange={(event) => handleCharacterPromptChange(event.target.value)}
                className="h-32 w-full rounded-b-md border-0 bg-transparent p-4 text-sm text-white focus:outline-none"
                maxLength={4000}
                placeholder="Ejemplo: Responde como un guía turístico amable con humor ligero."
              />
            )}
          </div>
        </div>
        <div className="flex flex-col gap-3 md:flex-row md:items-end">
          <div className="flex-1">
            <label htmlFor="model" className="mb-2 block text-sm font-medium text-gray-300">
              Modelo
            </label>
            <select
              id="model"
              value={model}
              onChange={(event) => setModel(event.target.value)}
              className="w-full rounded-md border border-gray-700 bg-gray-800 p-3 text-sm text-white focus:border-blue-500 focus:outline-none"
            >
              <option value="grok-4-fast-reasoning">grok-4-fast-reasoning</option>
              <option value="grok-4-fast-non-reasoning">grok-4-fast-non-reasoning</option>
            </select>
          </div>
          <div className="flex flex-1 flex-col">
            <label htmlFor="temperature" className="mb-2 block text-sm font-medium text-gray-300">
              Temperatura: {temperature.toFixed(1)}
            </label>
            <input
              id="temperature"
              type="range"
              min={0}
              max={2}
              step={0.1}
              value={temperature}
              onChange={(event) => setTemperature(Number(event.target.value))}
              className="w-full"
            />
          </div>
        </div>
        <div className="flex flex-col gap-3 md:flex-row">
          <input
            type="text"
            value={input}
            onChange={(event) => setInput(event.target.value.slice(0, 8000))}
            placeholder="Escribe tu mensaje..."
            className="flex-1 rounded-md border border-gray-700 bg-gray-800 p-3 text-white focus:border-blue-500 focus:outline-none"
            aria-label="Mensaje de usuario"
            disabled={isLoading}
          />
          <div className="flex gap-2">
            <button
              type="submit"
              className="rounded-md bg-blue-600 px-4 py-2 font-semibold transition hover:bg-blue-500 disabled:cursor-not-allowed"
              disabled={isLoading}
            >
              Enviar
            </button>
            {isLoading && (
              <button
                type="button"
                onClick={stopStreaming}
                className="rounded-md bg-red-600 px-4 py-2 font-semibold transition hover:bg-red-500"
              >
                Detener
              </button>
            )}
          </div>
        </div>
      </form>
    </div>
  );
}
