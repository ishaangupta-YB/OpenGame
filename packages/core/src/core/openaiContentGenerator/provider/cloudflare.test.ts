/**
 * @license
 * Copyright 2025 OpenGame
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type OpenAI from 'openai';
import { CloudflareOpenAICompatibleProvider } from './cloudflare.js';
import type { Config } from '../../../config/config.js';
import type { ContentGeneratorConfig } from '../../contentGenerator.js';

vi.mock('openai');

describe('CloudflareOpenAICompatibleProvider', () => {
  let provider: CloudflareOpenAICompatibleProvider;
  let mockContentGeneratorConfig: ContentGeneratorConfig;
  let mockCliConfig: Config;

  beforeEach(() => {
    mockContentGeneratorConfig = {
      apiKey: 'test-api-key',
      baseUrl:
        'https://api.cloudflare.com/client/v4/accounts/abc123/ai/v1',
      model: '@cf/moonshotai/kimi-k2.6',
    } as ContentGeneratorConfig;

    mockCliConfig = {
      getCliVersion: vi.fn().mockReturnValue('1.0.0'),
    } as unknown as Config;

    provider = new CloudflareOpenAICompatibleProvider(
      mockContentGeneratorConfig,
      mockCliConfig,
    );
  });

  describe('isCloudflareProvider', () => {
    it('matches the Workers AI OpenAI-compat base URL', () => {
      const config = {
        baseUrl:
          'https://api.cloudflare.com/client/v4/accounts/abc123/ai/v1',
      };
      expect(
        CloudflareOpenAICompatibleProvider.isCloudflareProvider(
          config as ContentGeneratorConfig,
        ),
      ).toBe(true);
    });

    it('is case-insensitive', () => {
      const config = {
        baseUrl:
          'https://API.cloudflare.com/client/v4/accounts/abc123/AI/V1',
      };
      expect(
        CloudflareOpenAICompatibleProvider.isCloudflareProvider(
          config as ContentGeneratorConfig,
        ),
      ).toBe(true);
    });

    it('does not match plain OpenAI', () => {
      const config = { baseUrl: 'https://api.openai.com/v1' };
      expect(
        CloudflareOpenAICompatibleProvider.isCloudflareProvider(
          config as ContentGeneratorConfig,
        ),
      ).toBe(false);
    });

    it('does not match a non-AI cloudflare endpoint', () => {
      const config = {
        baseUrl: 'https://api.cloudflare.com/client/v4/zones',
      };
      expect(
        CloudflareOpenAICompatibleProvider.isCloudflareProvider(
          config as ContentGeneratorConfig,
        ),
      ).toBe(false);
    });

    it('handles missing baseUrl', () => {
      expect(
        CloudflareOpenAICompatibleProvider.isCloudflareProvider(
          {} as ContentGeneratorConfig,
        ),
      ).toBe(false);
    });
  });

  describe('getDefaultGenerationConfig', () => {
    it('does not preset top_p (Workers AI rejects it)', () => {
      expect(provider.getDefaultGenerationConfig()).toEqual({});
    });
  });

  describe('buildRequest', () => {
    it('strips every sampling param Workers AI does not document', () => {
      const original = {
        model: '@cf/moonshotai/kimi-k2.6',
        messages: [{ role: 'user', content: 'hi' }],
        reasoning_effort: 'medium',
        top_p: 0.95,
        top_k: 20,
        frequency_penalty: 0.1,
        presence_penalty: 0.1,
        repetition_penalty: 1.1,
      } as unknown as OpenAI.Chat.ChatCompletionCreateParams;

      const result = provider.buildRequest(original, 'prompt-id') as Record<
        string,
        unknown
      >;
      expect(result['reasoning_effort']).toBeUndefined();
      expect(result['top_p']).toBeUndefined();
      expect(result['top_k']).toBeUndefined();
      expect(result['frequency_penalty']).toBeUndefined();
      expect(result['presence_penalty']).toBeUndefined();
      expect(result['repetition_penalty']).toBeUndefined();
    });

    it('renames max_tokens to max_completion_tokens', () => {
      const original = {
        model: '@cf/moonshotai/kimi-k2.6',
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 4096,
      } as unknown as OpenAI.Chat.ChatCompletionCreateParams;

      const result = provider.buildRequest(original, 'prompt-id') as Record<
        string,
        unknown
      >;
      expect(result['max_tokens']).toBeUndefined();
      expect(result['max_completion_tokens']).toBe(4096);
    });

    it('does not overwrite an explicit max_completion_tokens', () => {
      const original = {
        model: '@cf/moonshotai/kimi-k2.6',
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 4096,
        max_completion_tokens: 8192,
      } as unknown as OpenAI.Chat.ChatCompletionCreateParams;

      const result = provider.buildRequest(original, 'prompt-id') as Record<
        string,
        unknown
      >;
      expect(result['max_completion_tokens']).toBe(8192);
      expect(result['max_tokens']).toBeUndefined();
    });

    it('preserves model, messages, stream, tools, temperature', () => {
      const original = {
        model: '@cf/moonshotai/kimi-k2.6',
        messages: [{ role: 'user', content: 'hi' }],
        stream: true,
        temperature: 0.7,
        tools: [
          {
            type: 'function',
            function: { name: 'noop', parameters: { type: 'object' } },
          },
        ],
      } as unknown as OpenAI.Chat.ChatCompletionCreateParams;

      const result = provider.buildRequest(original, 'prompt-id') as Record<
        string,
        unknown
      >;
      expect(result['model']).toBe('@cf/moonshotai/kimi-k2.6');
      expect(result['stream']).toBe(true);
      expect(result['temperature']).toBe(0.7);
      expect((result['tools'] as unknown[]).length).toBe(1);
    });
  });
});
