import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('@/lib/nsfwGuard', () => ({
  guardOrThrow: vi.fn(),
}));

const encoder = new TextEncoder();
const buildStream = () =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"hola"}}]}\n\n'));
      controller.enqueue(encoder.encode('data: [DONE]\n\n'));
      controller.close();
    },
  });

describe('Home page composer', () => {
  const originalFileReader = global.FileReader;
  const originalCreateObjectURL = URL.createObjectURL;
  const originalRevokeObjectURL = URL.revokeObjectURL;
  const originalFetch = global.fetch;

  beforeEach(() => {
    const storageValue = JSON.stringify({ ok: true, ts: Date.now() });
    window.localStorage.setItem('mapychat.age.v1', storageValue);
    window.localStorage.setItem('mapychat.responseLevel.v1', '3');
    window.localStorage.setItem('mapychat.pref.image.detail.v1', 'auto');

    class MockFileReader {
      public result: string | ArrayBuffer | null = null;

      public onload: null | ((event: ProgressEvent<FileReader>) => void) = null;

      // eslint-disable-next-line class-methods-use-this
      public onerror: null | ((event: ProgressEvent<FileReader>) => void) = null;

      // eslint-disable-next-line class-methods-use-this
      public readAsDataURL(): void {
        this.result =
          'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Yl7iOsAAAAASUVORK5CYII=';
        this.onload?.({} as ProgressEvent<FileReader>);
      }
    }

    // @ts-expect-error - overriding for tests
    global.FileReader = MockFileReader;

    URL.createObjectURL = vi.fn().mockReturnValue('blob:quinzy-test');
    URL.revokeObjectURL = vi.fn();

    global.fetch = vi
      .fn()
      .mockResolvedValue(
        new Response(buildStream(), {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        }),
      );
  });

  afterEach(() => {
    vi.clearAllMocks();
    if (originalFileReader) {
      global.FileReader = originalFileReader;
    }
    URL.createObjectURL = originalCreateObjectURL;
    URL.revokeObjectURL = originalRevokeObjectURL;
    if (originalFetch) {
      global.fetch = originalFetch;
    }
    window.localStorage.clear();
  });

  it('muestra miniaturas, aplica detail por mensaje y expone descarga de imágenes', async () => {
    const { default: Home } = await import('../page');
    render(<Home />);

    const fileInput = await screen.findByLabelText('Adjuntar imagen');

    const fileOne = new File(['first'], 'primera.png', { type: 'image/png' });
    const fileTwo = new File(['second'], 'segunda.jpg', { type: 'image/jpeg' });

    const files = {
      0: fileOne,
      1: fileTwo,
      length: 2,
      item: (index: number) => (index === 0 ? fileOne : index === 1 ? fileTwo : null),
    } as unknown as FileList;

    fireEvent.change(fileInput, { target: { files } });

    await waitFor(() => {
      expect(screen.getAllByAltText(/Adjunto/)).toHaveLength(2);
    });

    const detailSelect = screen.getByLabelText(/Detail por mensaje/i) as HTMLSelectElement;
    await userEvent.selectOptions(detailSelect, 'high');

    const textarea = screen.getByLabelText('Mensaje de usuario') as HTMLTextAreaElement;
    await userEvent.clear(textarea);
    await userEvent.type(textarea, 'Hola con imágenes');

    const submitButton = screen.getByRole('button', { name: 'Enviar' });
    await userEvent.click(submitButton);

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledTimes(1);
    });

    const fetchArgs = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const payload = JSON.parse(fetchArgs[1]?.body as string);
    const userMessage = payload.messages[payload.messages.length - 1];
    expect(Array.isArray(userMessage.content)).toBe(true);
    const imageParts = userMessage.content.filter((part: any) => part.type === 'image_url');
    expect(imageParts).toHaveLength(2);
    imageParts.forEach((part: any) => {
      expect(part.image_url.detail).toBe('high');
    });

    const downloadButtons = await screen.findAllByText('Descargar');
    expect(downloadButtons.length).toBeGreaterThanOrEqual(2);
    downloadButtons.forEach((button) => {
      expect(button).toHaveAttribute('download');
      expect(button).toHaveAttribute('href');
      expect(button.getAttribute('href')).toMatch(/^blob:|^https?:/);
    });
  });
});
