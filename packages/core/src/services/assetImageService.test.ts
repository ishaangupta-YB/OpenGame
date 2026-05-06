/**
 * @license
 * Copyright 2025 OpenGame Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  CloudflareImageService,
  createImageService,
} from './assetImageService.js';
import type { ImageModelConfig } from '../tools/generate-assets-types.js';

const FLUX_PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function makeConfig(
  overrides: Partial<ImageModelConfig> = {},
): ImageModelConfig {
  return {
    apiKey: 'cf-token',
    baseUrl: 'https://api.cloudflare.com/client/v4/accounts/abc123/ai/run',
    modelType: 'cloudflare',
    modelNameGeneration: '@cf/black-forest-labs/flux-2-klein-9b',
    modelNameEditing: '@cf/black-forest-labs/flux-2-klein-9b',
    ...overrides,
  };
}

describe('CloudflareImageService', () => {
  const fetchMock = vi.fn();
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    fetchMock.mockReset();
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  describe('generateImage', () => {
    it('POSTs multipart/form-data to {baseUrl}/{model} with bearer auth', async () => {
      fetchMock.mockResolvedValue(
        new Response(FLUX_PNG, {
          status: 200,
          headers: { 'content-type': 'image/png' },
        }),
      );

      const svc = new CloudflareImageService(makeConfig());
      await svc.generateImage('a sunset at the alps', '1024*1024');

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe(
        'https://api.cloudflare.com/client/v4/accounts/abc123/ai/run/@cf/black-forest-labs/flux-2-klein-9b',
      );
      expect(init.method).toBe('POST');
      expect((init.headers as Record<string, string>).Authorization).toBe(
        'Bearer cf-token',
      );
      // We deliberately do NOT set Content-Type — fetch fills the multipart
      // boundary on its own when body is FormData.
      expect(
        (init.headers as Record<string, string>)['Content-Type'],
      ).toBeUndefined();
      expect(init.body).toBeInstanceOf(FormData);

      const form = init.body as FormData;
      expect(form.get('prompt')).toBe('a sunset at the alps');
      expect(form.get('width')).toBe('1024');
      expect(form.get('height')).toBe('1024');
      expect(form.get('steps')).toBe('25');
    });

    it('returns a base64 data URL when the response is binary PNG', async () => {
      fetchMock.mockResolvedValue(
        new Response(FLUX_PNG, {
          status: 200,
          headers: { 'content-type': 'image/png' },
        }),
      );

      const svc = new CloudflareImageService(makeConfig());
      const result = await svc.generateImage('hi');

      expect(result.startsWith('data:image/png;base64,')).toBe(true);
      const base64 = result.slice('data:image/png;base64,'.length);
      expect(Buffer.from(base64, 'base64').equals(FLUX_PNG)).toBe(true);
    });

    it('handles JSON-wrapped responses (result.image)', async () => {
      const base64 = FLUX_PNG.toString('base64');
      fetchMock.mockResolvedValue(
        new Response(JSON.stringify({ result: { image: base64 } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );

      const svc = new CloudflareImageService(makeConfig());
      const result = await svc.generateImage('hi');
      expect(result).toBe(`data:image/png;base64,${base64}`);
    });

    it('parses both 1024x1024 and 1024*1024 size formats', async () => {
      const makeResponse = () =>
        new Response(FLUX_PNG, {
          status: 200,
          headers: { 'content-type': 'image/png' },
        });
      fetchMock.mockImplementation(async () => makeResponse());

      const svc = new CloudflareImageService(makeConfig());

      await svc.generateImage('a', '512x768');
      let form = (fetchMock.mock.calls[0] as [string, RequestInit])[1]
        .body as FormData;
      expect(form.get('width')).toBe('512');
      expect(form.get('height')).toBe('768');

      await svc.generateImage('a', '2048*1024');
      form = (fetchMock.mock.calls[1] as [string, RequestInit])[1]
        .body as FormData;
      expect(form.get('width')).toBe('2048');
      expect(form.get('height')).toBe('1024');
    });

    it('throws an actionable error when the API returns non-2xx', async () => {
      fetchMock.mockResolvedValue(new Response('forbidden', { status: 403 }));

      const svc = new CloudflareImageService(makeConfig());
      // fetchWithRetry retries on non-2xx, so eventually the same 403 surfaces.
      await expect(svc.generateImage('hi')).rejects.toThrow(
        /Cloudflare Workers AI image API failed: 403/,
      );
    }, 15_000);

    it('throws on an invalid size string', async () => {
      const svc = new CloudflareImageService(makeConfig());
      await expect(svc.generateImage('hi', 'huge')).rejects.toThrow(
        /Invalid image size/,
      );
    });
  });

  describe('editImage', () => {
    it('falls back to generateImage with a style hint', async () => {
      fetchMock.mockResolvedValue(
        new Response(FLUX_PNG, {
          status: 200,
          headers: { 'content-type': 'image/png' },
        }),
      );

      const svc = new CloudflareImageService(makeConfig());
      await svc.editImage('https://example.com/ref.png', 'a fox');

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const init = (fetchMock.mock.calls[0] as [string, RequestInit])[1];
      const form = init.body as FormData;
      expect(form.get('prompt')).toBe('a fox (matching reference style)');
    });
  });
});

describe('createImageService factory', () => {
  it('returns a CloudflareImageService for modelType="cloudflare"', () => {
    const svc = createImageService(makeConfig());
    expect(svc).toBeInstanceOf(CloudflareImageService);
  });
});
