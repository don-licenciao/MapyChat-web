'use client';
/* eslint-disable @next/next/no-img-element */

import React, {
  ChangeEvent,
  ClipboardEvent,
  DragEvent,
  FormEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { guardOrThrow } from '@/lib/nsfwGuard';

type DetailLevel = 'auto' | 'low' | 'high';

type TextPart = { type: 'text'; text: string };
type ImagePart = { type: 'image_url'; image_url: { url: string; detail: DetailLevel } };
type MessagePart = TextPart | ImagePart;
type MessageContent = string | MessagePart[];

type Message = {
  role: 'user' | 'assistant';
  content: MessageContent;
};

type QueuedImage = {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  dataUrl: string;
};

const DEFAULT_SYSTEM_PROMPT = `Eres un asistente útil y amigable. Siempre responde en español de México. Rechaza cualquier solicitud que involucre a menores de edad, contenido ilegal, violencia o explotación. Nunca pidas datos personales sensibles como direcciones, números de teléfono o información real. Mantén las respuestas seguras y responsables.`;
const DEFAULT_CHARACTER_PROMPT = '';

const STORAGE_KEY = 'mapychat.age.v1';
const RESPONSE_LEVEL_STORAGE_KEY = 'mapychat.responseLevel.v1';
const DRAWER_STORAGE_KEY = 'mapychat.drawer.open.v1';
const IMAGE_DETAIL_STORAGE_KEY = 'mapychat.pref.image.detail.v1';

const BASE_OUTPUT_TOKENS = 128;
const IMAGE_TOKEN_ESTIMATE = 64;
const MAX_STREAM_RETRIES = 2;
const RETRY_BASE_DELAY_MS = 1000;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const COMPRESSION_THRESHOLD = 2 * 1024 * 1024;
const MAX_CANVAS_DIMENSION = 1600;

const DETAIL_OPTIONS: DetailLevel[] = ['auto', 'low', 'high'];

const DATA_URL_PATTERN = /^data:image\/(png|jpe?g);base64,([a-z0-9+/=\r\n]+)$/i;

const createId = () =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2);

const tokensForLevel = (level: number) => {
  const n = Math.max(1, Math.min(5, Math.floor(Number.isFinite(level) ? level : 3)));
  return BASE_OUTPUT_TOKENS * 2 ** (n - 1);
};

const estimateSegmentTokens = (segment: string) => {
  const sanitized = segment.replace(/\s+/g, ' ').trim();
  if (!sanitized) return 0;
  const words = sanitized.split(' ').filter(Boolean).length;
  const punctuation = sanitized.match(/[^\w\s]/g)?.length ?? 0;
  const charBased = Math.ceil(sanitized.length / 4);
  return Math.max(charBased, words + Math.ceil(punctuation / 4));
};

const estimateMessageTokens = (content: MessageContent) => {
  if (typeof content === 'string') {
    return estimateSegmentTokens(content);
  }
  return content.reduce((total, part) => {
    if (part.type === 'text') {
      return total + estimateSegmentTokens(part.text);
    }
    return total + IMAGE_TOKEN_ESTIMATE;
  }, 0);
};

const dataUrlByteLength = (dataUrl: string) => {
  const match = DATA_URL_PATTERN.exec(dataUrl);
  if (!match) return Number.POSITIVE_INFINITY;
  const base64 = match[2].replace(/\s+/g, '');
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
  return Math.floor(base64.length / 4) * 3 - padding;
};

const readFileAsDataUrl = (file: File) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      if (typeof result === 'string') {
        resolve(result);
      } else {
        reject(new Error('No se pudo leer el archivo.'));
      }
    };
    reader.onerror = () => reject(reader.error ?? new Error('No se pudo leer el archivo.'));
    reader.readAsDataURL(file);
  });

const maybeCompressImage = async (file: File): Promise<{ dataUrl: string; mimeType: string }> => {
  const originalDataUrl = await readFileAsDataUrl(file);
  if (file.size <= COMPRESSION_THRESHOLD) {
    return { dataUrl: originalDataUrl, mimeType: file.type || 'image/png' };
  }

  const image = document.createElement('img');
  const objectUrl = URL.createObjectURL(file);

  try {
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error('No se pudo cargar la imagen para comprimir.'));
      image.src = objectUrl;
    });
  } finally {
    URL.revokeObjectURL(objectUrl);
  }

  const longestSide = Math.max(image.width, image.height);
  const scale = longestSide > 0 ? Math.min(1, MAX_CANVAS_DIMENSION / longestSide) : 1;
  const targetWidth = Math.max(1, Math.round(image.width * scale));
  const targetHeight = Math.max(1, Math.round(image.height * scale));

  const canvas = document.createElement('canvas');
  canvas.width = targetWidth;
  canvas.height = targetHeight;
  const context = canvas.getContext('2d');
  if (!context) {
    return { dataUrl: originalDataUrl, mimeType: file.type || 'image/png' };
  }

  context.drawImage(image, 0, 0, targetWidth, targetHeight);

  const targetType = file.type === 'image/png' ? 'image/png' : 'image/jpeg';
  const quality = targetType === 'image/jpeg' ? 0.85 : undefined;
  const compressedDataUrl = canvas.toDataURL(targetType, quality);

  if (dataUrlByteLength(compressedDataUrl) < dataUrlByteLength(originalDataUrl)) {
    return { dataUrl: compressedDataUrl, mimeType: targetType };
  }

  return { dataUrl: originalDataUrl, mimeType: file.type || 'image/png' };
};

const dataUrlToBlob = (dataUrl: string) => {
  const match = DATA_URL_PATTERN.exec(dataUrl);
  if (!match) {
    throw new Error('Data URL inválida');
  }
  const [, mime, base64] = match;
  const normalizedBase64 = base64.replace(/\s+/g, '');
  const binary = atob(normalizedBase64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new Blob([bytes], { type: `image/${mime.toLowerCase()}` });
};

const inferExtension = (url: string) => {
  if (url.startsWith('data:image/png')) return 'png';
  if (url.startsWith('data:image/jpeg') || url.startsWith('data:image/jpg')) return 'jpg';
  if (url.includes('.png')) return 'png';
  if (url.includes('.jpg') || url.includes('.jpeg')) return 'jpg';
  return 'png';
};

const formatDownloadName = (role: 'user' | 'assistant', messageIndex: number, partIndex: number, url: string) => {
  const now = new Date();
  const timestamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(
    2,
    '0',
  )}-${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}${String(
    now.getSeconds(),
  ).padStart(2, '0')}`;
  const extension = inferExtension(url);
  return `quinzy-${role}-image-${messageIndex + 1}-${partIndex + 1}-${timestamp}.${extension}`;
};

type MessageImageProps = {
  url: string;
  role: 'user' | 'assistant';
  messageIndex: number;
  partIndex: number;
  detail: DetailLevel;
};

const MessageImage = ({ url, role, messageIndex, partIndex, detail }: MessageImageProps) => {
  const [downloadHref, setDownloadHref] = useState(url);
  const downloadName = useMemo(
    () => formatDownloadName(role, messageIndex, partIndex, url),
    [role, messageIndex, partIndex, url],
  );

  useEffect(() => {
    if (!url.startsWith('data:')) {
      setDownloadHref(url);
      return;
    }

    try {
      const blob = dataUrlToBlob(url);
      const objectUrl = URL.createObjectURL(blob);
      setDownloadHref(objectUrl);
      return () => {
        URL.revokeObjectURL(objectUrl);
      };
    } catch (error) {
      console.error('No se pudo preparar la descarga de la imagen:', error);
      setDownloadHref(url);
    }
    return undefined;
  }, [url]);

  const alt = role === 'user' ? 'Imagen enviada por el usuario' : 'Imagen enviada por el asistente';

  return (
    <figure className="group flex flex-col gap-2">
      <img
        src={url}
        alt={alt}
        className="max-h-72 w-full max-w-md rounded-lg border border-gray-800 object-contain bg-gray-900"
      />
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-gray-400">
        <span className="rounded-full border border-gray-700 px-2 py-1 capitalize">Detail: {detail}</span>
        <a
          href={downloadHref}
          download={downloadName}
          className="rounded border border-gray-700 px-3 py-1 font-medium text-gray-200 transition hover:bg-gray-800 hover:text-white"
        >
          Descargar
        </a>
      </div>
    </figure>
  );
};

export default function Home() {
  const [ageConfirmed, setAgeConfirmed] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [systemPrompt, setSystemPrompt] = useState(DEFAULT_SYSTEM_PROMPT);
  const [characterPrompt, setCharacterPrompt] = useState(DEFAULT_CHARACTER_PROMPT);
  const [model, setModel] = useState('grok-4-fast-reasoning');
  const [temperature, setTemperature] = useState(0.8);
  const [responseLevel, setResponseLevel] = useState(3);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [queuedImages, setQueuedImages] = useState<QueuedImage[]>([]);
  const [messageDetail, setMessageDetail] = useState<DetailLevel>('auto');
  const [globalImageDetail, setGlobalImageDetail] = useState<DetailLevel>('auto');
  const [isDrawerOpen, setIsDrawerOpen] = useState(false);
  const [showSystemPrompt, setShowSystemPrompt] = useState(true);
  const [showCharacterPrompt, setShowCharacterPrompt] = useState(false);
  const [isDragActive, setIsDragActive] = useState(false);
  const abortControllerRef = useRef<AbortController | null>(null);
  const chatRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const maxResponseTokens = useMemo(() => tokensForLevel(responseLevel), [responseLevel]);

  const approximateTokenCount = useMemo(() => {
    const historyTokens = messages.reduce((total, message) => total + estimateMessageTokens(message.content), 0);
    const queuedImageTokens = queuedImages.length * IMAGE_TOKEN_ESTIMATE;
    return (
      estimateSegmentTokens(systemPrompt) +
      estimateSegmentTokens(characterPrompt) +
      historyTokens +
      estimateSegmentTokens(input) +
      queuedImageTokens
    );
  }, [messages, systemPrompt, characterPrompt, input, queuedImages]);

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
    if (typeof window === 'undefined') return;
    try {
      const storedLevel = window.localStorage.getItem(RESPONSE_LEVEL_STORAGE_KEY);
      if (storedLevel) {
        const parsed = Number.parseInt(storedLevel, 10);
        if (Number.isFinite(parsed)) {
          const clamped = Math.max(1, Math.min(5, parsed));
          setResponseLevel(clamped);
        }
      }
    } catch (storageError) {
      console.error('No se pudo leer preferencia de longitud de respuesta:', storageError);
    }
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      const storedDrawer = window.localStorage.getItem(DRAWER_STORAGE_KEY);
      if (storedDrawer) {
        setIsDrawerOpen(storedDrawer === '1');
      }
    } catch (storageError) {
      console.error('No se pudo leer el estado del panel de configuración:', storageError);
    }
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      const storedDetail = window.localStorage.getItem(IMAGE_DETAIL_STORAGE_KEY) as DetailLevel | null;
      if (storedDetail && DETAIL_OPTIONS.includes(storedDetail)) {
        setGlobalImageDetail(storedDetail);
        setMessageDetail(storedDetail);
      }
    } catch (storageError) {
      console.error('No se pudo leer la preferencia de detalle de imagen:', storageError);
    }
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      window.localStorage.setItem(DRAWER_STORAGE_KEY, isDrawerOpen ? '1' : '0');
    } catch (storageError) {
      console.error('No se pudo persistir el estado del panel de configuración:', storageError);
    }
  }, [isDrawerOpen]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      window.localStorage.setItem(IMAGE_DETAIL_STORAGE_KEY, globalImageDetail);
    } catch (storageError) {
      console.error('No se pudo persistir la preferencia de detalle de imagen:', storageError);
    }
  }, [globalImageDetail]);

  useEffect(() => {
    setMessageDetail(globalImageDetail);
  }, [globalImageDetail]);

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

  const handleResponseLevelChange = (value: number) => {
    const coerced = Math.max(1, Math.min(5, Math.floor(Number.isFinite(value) ? value : 3)));
    setResponseLevel(coerced);
    if (typeof window === 'undefined') return;
    try {
      window.localStorage.setItem(RESPONSE_LEVEL_STORAGE_KEY, String(coerced));
    } catch (storageError) {
      console.error('No se pudo persistir la preferencia de longitud de respuesta:', storageError);
    }
  };

  const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  const streamWithRetries = async (
    payload: {
      model: string;
      temperature: number;
      systemPrompt: string;
      characterPrompt: string;
      messages: Message[];
      responseLevel: number;
      maxTokens: number;
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
                  if (prev.length === 0) return prev;
                  const updated = [...prev];
                  const lastIndex = updated.length - 1;
                  const lastMessage = updated[lastIndex];
                  if (typeof lastMessage.content === 'string') {
                    updated[lastIndex] = { ...lastMessage, content: `${lastMessage.content}${content}` };
                  } else {
                    updated[lastIndex] = {
                      ...lastMessage,
                      content: [...lastMessage.content, { type: 'text', text: content }],
                    };
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

  const handleFiles = async (files: FileList | File[]) => {
    const incoming = Array.from(files);
    if (incoming.length === 0) return;

    const results = await Promise.allSettled(
      incoming.map(async (file) => {
        if (!['image/png', 'image/jpeg', 'image/jpg'].includes(file.type)) {
          throw new Error(`Formato no soportado: ${file.type || file.name}`);
        }
        const { dataUrl, mimeType } = await maybeCompressImage(file);
        const size = dataUrlByteLength(dataUrl);
        if (size > MAX_IMAGE_BYTES) {
          throw new Error(`La imagen "${file.name}" supera los 20 MiB tras la compresión.`);
        }
        return {
          id: createId(),
          name: file.name,
          mimeType,
          size,
          dataUrl,
        } satisfies QueuedImage;
      }),
    );

    const accepted: QueuedImage[] = [];
    const errors: string[] = [];

    results.forEach((result) => {
      if (result.status === 'fulfilled') {
        accepted.push(result.value);
      } else if (result.reason instanceof Error) {
        errors.push(result.reason.message);
      }
    });

    if (accepted.length > 0) {
      setQueuedImages((prev) => [...prev, ...accepted]);
      setError(null);
    }

    if (errors.length > 0) {
      setError(errors.join('\n'));
    }
  };

  const handleFileInputChange = (event: ChangeEvent<HTMLInputElement>) => {
    const { files } = event.target;
    if (files) {
      void handleFiles(files);
      event.target.value = '';
    }
  };

  const handleDragOver = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
    setIsDragActive(true);
  };

  const handleDragLeave = (event: DragEvent<HTMLDivElement>) => {
    if (!event.currentTarget.contains(event.relatedTarget as Node)) {
      setIsDragActive(false);
    }
  };

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setIsDragActive(false);
    const { files } = event.dataTransfer ?? {};
    if (files && files.length > 0) {
      void handleFiles(files);
    }
  };

  const handlePaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const items = event.clipboardData?.items;
    if (!items) return;
    const files: File[] = [];
    for (const item of items) {
      if (item.kind === 'file') {
        const file = item.getAsFile();
        if (file) {
          files.push(file);
        }
      }
    }
    if (files.length > 0) {
      void handleFiles(files);
    }
  };

  const removeQueuedImage = (id: string) => {
    setQueuedImages((prev) => prev.filter((image) => image.id !== id));
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const sanitizedInput = input.trim();
    const hasText = sanitizedInput.length > 0;
    const hasImages = queuedImages.length > 0;

    if (!hasText && !hasImages) {
      setError('Agrega un mensaje o al menos una imagen antes de enviar.');
      return;
    }

    setError(null);

    if (hasText) {
      try {
        guardOrThrow(sanitizedInput);
      } catch (guardError) {
        setError('Lo siento, eso viola nuestras reglas de contenido seguro. ¿Quieres probar algo diferente?');
        return;
      }
    }

    const parts: MessagePart[] = [];
    if (hasText) {
      parts.push({ type: 'text', text: sanitizedInput });
    }
    queuedImages.forEach((image) => {
      parts.push({ type: 'image_url', image_url: { url: image.dataUrl, detail: messageDetail } });
    });

    const userMessage: Message = {
      role: 'user',
      content: parts.length === 1 && parts[0].type === 'text' ? parts[0].text : parts,
    };

    const nextMessages = [...messages, userMessage];
    setMessages([...nextMessages, { role: 'assistant', content: '' }]);
    setInput('');
    setQueuedImages([]);
    setMessageDetail(globalImageDetail);
    setIsLoading(true);

    try {
      await streamWithRetries(
        {
          model,
          temperature,
          systemPrompt,
          characterPrompt,
          messages: nextMessages,
          responseLevel,
          maxTokens: maxResponseTokens,
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
          if (last.role === 'assistant' && typeof last.content === 'string' && last.content.length === 0) {
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

  const renderMessageContent = (message: Message, messageIndex: number) => {
    if (typeof message.content === 'string') {
      return <p className="whitespace-pre-wrap text-sm leading-relaxed text-gray-100">{message.content}</p>;
    }

    return message.content.map((part, partIndex) => {
      if (part.type === 'text') {
        return (
          <p
            key={`text-${partIndex}`}
            className="whitespace-pre-wrap text-sm leading-relaxed text-gray-100"
          >
            {part.text}
          </p>
        );
      }
      return (
        <MessageImage
          key={`image-${partIndex}`}
          url={part.image_url.url}
          role={message.role}
          detail={part.image_url.detail}
          messageIndex={messageIndex}
          partIndex={partIndex}
        />
      );
    });
  };

  const drawerContent = (
    <div className="flex h-full flex-col gap-6 overflow-y-auto border-l border-gray-800 bg-gray-950/90 p-6 text-sm text-gray-100">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-white">Configuración</h2>
        <button
          type="button"
          onClick={() => setIsDrawerOpen(false)}
          className="rounded border border-gray-700 px-2 py-1 text-xs font-semibold text-gray-200 transition hover:bg-gray-800 hover:text-white lg:hidden"
        >
          Cerrar
        </button>
      </div>
      <div className="space-y-4">
        <section className="rounded border border-gray-800 bg-gray-900/60">
          <header className="flex items-center justify-between gap-4 border-b border-gray-800 px-4 py-3">
            <div>
              <p className="text-sm font-medium text-gray-100">System Prompt</p>
              <p className="text-xs text-gray-400">Configura el comportamiento base del asistente.</p>
            </div>
            <button
              type="button"
              onClick={() => setShowSystemPrompt((prev) => !prev)}
              className="rounded border border-gray-700 px-3 py-1 text-xs font-semibold text-gray-200 transition hover:border-blue-500 hover:text-white"
              aria-expanded={showSystemPrompt}
            >
              Mostrar / Ocultar
            </button>
          </header>
          {showSystemPrompt && (
            <textarea
              id="systemPrompt"
              value={systemPrompt}
              onChange={(event) => handleSystemPromptChange(event.target.value)}
              className="h-40 w-full rounded-b border-0 bg-transparent p-4 text-sm text-white focus:outline-none"
              maxLength={4000}
            />
          )}
        </section>
        <section className="rounded border border-gray-800 bg-gray-900/60">
          <header className="flex items-center justify-between gap-4 border-b border-gray-800 px-4 py-3">
            <div>
              <p className="text-sm font-medium text-gray-100">Prompt de personaje</p>
              <p className="text-xs text-gray-400">Define voz, estilo o reglas adicionales.</p>
            </div>
            <button
              type="button"
              onClick={() => setShowCharacterPrompt((prev) => !prev)}
              className="rounded border border-gray-700 px-3 py-1 text-xs font-semibold text-gray-200 transition hover:border-blue-500 hover:text-white"
              aria-expanded={showCharacterPrompt}
            >
              Mostrar / Ocultar
            </button>
          </header>
          {showCharacterPrompt && (
            <textarea
              id="characterPrompt"
              value={characterPrompt}
              onChange={(event) => handleCharacterPromptChange(event.target.value)}
              className="h-36 w-full rounded-b border-0 bg-transparent p-4 text-sm text-white focus:outline-none"
              maxLength={4000}
              placeholder="Ejemplo: Responde como un guía turístico amable con humor ligero."
            />
          )}
        </section>
        <section className="space-y-4 rounded border border-gray-800 bg-gray-900/60 p-4">
          <div className="space-y-2">
            <label htmlFor="model" className="text-sm font-medium text-gray-100">
              Modelo
            </label>
            <select
              id="model"
              value={model}
              onChange={(event) => setModel(event.target.value)}
              className="w-full rounded border border-gray-700 bg-gray-800 p-3 text-sm text-white focus:border-blue-500 focus:outline-none"
            >
              <option value="grok-4-fast-reasoning">grok-4-fast-reasoning</option>
              <option value="grok-4-fast-non-reasoning">grok-4-fast-non-reasoning</option>
            </select>
          </div>
          <div className="space-y-2">
            <label htmlFor="temperature" className="text-sm font-medium text-gray-100">
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
          <div className="space-y-2">
            <label htmlFor="responseLevel" className="text-sm font-medium text-gray-100">
              Longitud de respuesta (1–5)
            </label>
            <input
              id="responseLevel"
              type="range"
              min={1}
              max={5}
              step={1}
              value={responseLevel}
              onChange={(event) => handleResponseLevelChange(Number(event.target.value))}
              className="w-full"
            />
            <span className="text-xs text-gray-400">Salida máx: {maxResponseTokens} tokens</span>
          </div>
          <div className="space-y-2">
            <label htmlFor="globalDetail" className="text-sm font-medium text-gray-100">
              Preferencia de detalle para imágenes
            </label>
            <select
              id="globalDetail"
              value={globalImageDetail}
              onChange={(event) => setGlobalImageDetail(event.target.value as DetailLevel)}
              className="w-full rounded border border-gray-700 bg-gray-800 p-3 text-sm text-white focus:border-blue-500 focus:outline-none"
            >
              {DETAIL_OPTIONS.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
            <p className="text-xs text-gray-400">
              Esta preferencia se usa como valor inicial del selector por mensaje en el compositor.
            </p>
          </div>
        </section>
      </div>
    </div>
  );

  return (
    <div className="relative flex h-screen flex-col bg-gray-900 text-white">
      <div className="pointer-events-none fixed right-4 top-4 z-30 rounded-full bg-gray-800/80 px-5 py-2 text-sm font-medium text-gray-200 shadow">
        Tokens aprox: {approximateTokenCount}
      </div>
      <header className="border-b border-gray-800 bg-gray-950/70 p-4 lg:px-8">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-semibold">Quinzy</h1>
            <p className="text-sm text-gray-400">Chat seguro con Grok, streaming SSE y soporte multimodal.</p>
          </div>
          <button
            type="button"
            onClick={() => setIsDrawerOpen((prev) => !prev)}
            className="flex items-center gap-2 rounded border border-gray-700 px-3 py-2 text-sm font-semibold text-gray-200 transition hover:border-blue-500 hover:text-white"
            aria-expanded={isDrawerOpen}
            aria-controls="quinzy-settings-drawer"
          >
            ⚙️ Configurar
          </button>
        </div>
      </header>
      <div className="flex flex-1 overflow-hidden">
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
                className={`w-full max-w-4xl space-y-3 rounded-xl px-5 py-4 text-base shadow-md transition ${
                  message.role === 'user' ? 'bg-blue-600/80' : 'bg-gray-800/80'
                }`}
              >
                {renderMessageContent(message, index)}
              </div>
            </div>
          ))}
          {error && <p className="text-sm text-red-400 whitespace-pre-line">{error}</p>}
        </main>
        {isDrawerOpen && (
          <div
            className="fixed inset-0 z-30 bg-black/60 transition-opacity lg:hidden"
            aria-hidden="true"
            onClick={() => setIsDrawerOpen(false)}
          />
        )}
        <aside
          id="quinzy-settings-drawer"
          className={`fixed inset-y-0 right-0 z-40 w-full max-w-md transform transition-transform duration-300 ease-out lg:static lg:z-auto lg:h-full lg:w-96 lg:translate-x-0 ${
            isDrawerOpen ? 'translate-x-0' : 'translate-x-full'
          }`}
        >
          {drawerContent}
        </aside>
      </div>
      <form
        onSubmit={handleSubmit}
        className="space-y-4 border-t border-gray-800 bg-gray-950/70 p-4 lg:px-8"
      >
        <div
          onDragOver={handleDragOver}
          onDragEnter={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          className={`rounded-lg border border-dashed p-4 transition ${
            isDragActive ? 'border-blue-400 bg-blue-950/20' : 'border-gray-700 bg-gray-900/60'
          }`}
        >
          <label htmlFor="chatInput" className="mb-2 block text-sm font-medium text-gray-200">
            Mensaje
          </label>
          <textarea
            id="chatInput"
            value={input}
            onChange={(event) => setInput(event.target.value.slice(0, 8000))}
            onPaste={handlePaste}
            placeholder="Escribe tu mensaje o arrastra imágenes..."
            className="h-28 w-full resize-none rounded border border-gray-700 bg-gray-800 p-3 text-sm text-white focus:border-blue-500 focus:outline-none"
            aria-label="Mensaje de usuario"
            disabled={isLoading}
          />
          <p className="mt-2 text-xs text-gray-400">
            Puedes adjuntar imágenes JPG o PNG arrastrando, pegando desde el portapapeles o usando el botón.
          </p>
          {queuedImages.length > 0 && (
            <div className="mt-4 flex flex-wrap gap-4">
              {queuedImages.map((image) => (
                <div key={image.id} className="relative w-28">
                  <img
                    src={image.dataUrl}
                    alt={`Adjunto ${image.name}`}
                    className="h-28 w-28 rounded border border-gray-700 object-cover"
                  />
                  <button
                    type="button"
                    onClick={() => removeQueuedImage(image.id)}
                    className="absolute -right-2 -top-2 flex h-6 w-6 items-center justify-center rounded-full bg-red-600 text-xs font-bold text-white shadow"
                    aria-label={`Eliminar ${image.name}`}
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
        <div className="flex flex-col gap-3 md:flex-row md:items-end">
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="rounded border border-gray-700 px-4 py-2 text-sm font-semibold text-gray-200 transition hover:border-blue-500 hover:text-white"
            >
              Adjuntar imagen
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/png,image/jpeg"
              multiple
              className="hidden"
              onChange={handleFileInputChange}
              aria-label="Adjuntar imagen"
            />
            <div className="flex flex-col text-xs text-gray-400">
              <label htmlFor="messageDetail" className="font-medium text-gray-300">
                Detail por mensaje
              </label>
              <select
                id="messageDetail"
                value={messageDetail}
                onChange={(event) => setMessageDetail(event.target.value as DetailLevel)}
                className="mt-1 rounded border border-gray-700 bg-gray-800 p-2 text-xs text-white focus:border-blue-500 focus:outline-none"
              >
                {DETAIL_OPTIONS.map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div className="flex flex-1 justify-end gap-2">
            <button
              type="submit"
              className="rounded bg-blue-600 px-4 py-2 text-sm font-semibold transition hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-60"
              disabled={isLoading}
            >
              Enviar
            </button>
            {isLoading && (
              <button
                type="button"
                onClick={stopStreaming}
                className="rounded bg-red-600 px-4 py-2 text-sm font-semibold transition hover:bg-red-500"
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
