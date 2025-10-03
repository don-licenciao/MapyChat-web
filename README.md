# Quinzy

Una SPA para chatear con Grok de xAI mediante streaming SSE, con guardas estrictas de contenido.

## Características principales
- **Interfaz de chat** con soporte de streaming SSE, sección de historial ampliada y controles para `systemPrompt`, modelo y temperatura.
- **Prompts configurables** para sistema y personajes, con paneles colapsables "Mostrar/Ocultar" que permiten ajustar la voz sin ocupar espacio en pantalla.
- **Age Gate** persistente en `localStorage` que requiere confirmación 18+ antes de usar la app.
- **nsfwGuard** avanzado que bloquea referencias a menores, reglas duras (temas de i**cesto, z**filia, etc.), doxxing y likeness real en contexto sexual.
- **Proxy SSE** en `/api/grok` ejecutándose en runtime Edge que valida la petición y reenvía la respuesta de xAI sin modificar el stream.
- **AbortController** en el cliente para detener el streaming bajo demanda.
- **Estilos responsivos** con modo oscuro predeterminado.
- **Contador de tokens** aproximado en la esquina superior derecha para vigilar el tamaño de la conversación.

## Requisitos previos
- Node.js 20 o superior.
- Una clave de API válida para xAI Grok.

## Configuración local
1. Instala dependencias: `npm install`.
2. Copia `.env.example` a `.env.local` y completa `XAI_API_KEY` (opcionalmente ajusta `RATE_LIMIT_WINDOW_MS` y `RATE_LIMIT_MAX_REQUESTS`).
3. Ejecuta `npm run dev` y visita [http://localhost:3000](http://localhost:3000).
4. Opcional: corre `npm run test` para verificar las reglas del `nsfwGuard`.

### Variables de entorno
- `XAI_API_KEY`: clave obligatoria de xAI para consultar Grok.
- `RATE_LIMIT_WINDOW_MS` (opcional, por defecto `60000`): ventana en milisegundos para el rate limit local.
- `RATE_LIMIT_MAX_REQUESTS` (opcional, por defecto `10`): solicitudes permitidas dentro de la ventana configurada.

### Ejecución en Android (Termux)
1. Instala Node.js 20 con `pkg install nodejs-lts`.
2. Ejecuta `npm install` para descargar las dependencias.
3. Lanza las pruebas con `npm run test` o el entorno de desarrollo con `npm run dev`.
4. Abre `http://localhost:3000` desde el navegador del dispositivo para validar la interfaz.

## Scripts disponibles
- `npm run dev`: entorno de desarrollo.
- `npm run build`: build de producción.
- `npm run start`: servidor de producción.
- `npm run lint`: linting con ESLint.
- `npm run test`: pruebas unitarias con Vitest para `nsfwGuard`.

## Verificación recomendada
Antes de enviar cambios o tras un rebase, ejecuta:

1. `npm run test`
2. `npm run build`

## Deploy en Vercel
1. Importa el repositorio en un proyecto de Vercel.
2. Define la variable de entorno `XAI_API_KEY` en el dashboard del proyecto.
3. Despliega normalmente; la ruta `/api/grok` corre en Edge runtime.

### Límite de peticiones
El proxy aplica un rate limit sencillo de **10 solicitudes por minuto** por IP (configurable con `RATE_LIMIT_MAX_REQUESTS` y `RATE_LIMIT_WINDOW_MS`). Cada respuesta incluye los encabezados `RateLimit-*` para que el cliente sepa cuánto resta antes del reinicio. En caso de superarlo, responde con `429`, `Retry-After` y los mismos encabezados informativos.

### Control de longitud de respuesta
La interfaz incluye un slider "Longitud de respuesta (1–5)" que ajusta el máximo de tokens de salida que solicitará el chatbot. Cada nivel duplica la base de 128 tokens:

| Nivel | Tokens máximos |
| --- | --- |
| 1 | 128 |
| 2 | 256 |
| 3 (predeterminado) | 512 |
| 4 | 1024 |
| 5 | 2048 |

El cliente persiste la preferencia en `localStorage` y envía el valor resultante como `max_output_tokens` al proxy (`/api/grok`). El servidor acepta `responseLevel` o `maxTokens`, valida la escala y siempre clampéa el rango permitido (128–2048) antes de reenviar la solicitud a xAI.

> Nota: si el proveedor aplica límites distintos por modelo, esos topes prevalecen sobre la configuración local.

## Avisos importantes
- Respeta la Acceptable Use Policy de xAI y las leyes aplicables.
- La aplicación es estrictamente para mayores de 18 años.

## Solución de problemas

| Código | Causa probable | Acción sugerida |
| --- | --- | --- |
| 401 / 403 (xAI) | `XAI_API_KEY` inválida o sin permisos para el modelo. | Verifica la clave en Vercel, renueva permisos con xAI y redeploya. |
| 415 (proxy) | `Content-Type` distinto de `application/json`. | Envía JSON válido con `fetch` o `axios` y el encabezado correcto. |
| 429 (proxy) | Se superó el límite local (`RateLimit-Remaining = 0`). | Espera los segundos indicados en `Retry-After` o ajusta la cadencia. |
| 429 / 5xx (xAI) | Límite global o mantenimiento del proveedor. | Consulta [status.x.ai](https://status.x.ai/) y reintenta tras unos minutos. |
| 500 (proxy) | Falta `XAI_API_KEY` o error interno. | Define la variable en `.env.local`/Vercel y revisa logs de Edge. |

- **401 / 403 desde xAI**: revisa que `XAI_API_KEY` sea válida y esté activa en Vercel. Comprueba también que el proyecto tenga permisos para Grok.
- **429 desde `/api/grok`**: el rate limit local se activó. Espera el tiempo indicado en `Retry-After` o reduce la frecuencia de peticiones.
- **429 / 5xx desde xAI**: suelen indicar límites globales o mantenimiento. Reintenta más tarde y consulta el [status de xAI](https://status.x.ai/).
- **415 o 403 desde el proxy**: asegúrate de enviar `Content-Type: application/json` y llamar desde el mismo origen configurado (CORS same-origin estricto).
- **Error "Configuración del servidor incompleta"**: falta la variable `XAI_API_KEY` en el entorno. Agrégala y redeploya.
- **Stream se corta con AbortError**: ocurre si pulsas "Detener" o el navegador corta la conexión. Reintenta y verifica la estabilidad de red.

> **Tip:** Consulta los Edge Logs de Vercel para ver encabezados `RateLimit-*`, errores propagados de xAI y las entradas bloqueadas por el guard.
