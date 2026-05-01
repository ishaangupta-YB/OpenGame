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
    it('inherits default sampling config (no forced suppression)', () => {
      expect(provider.getDefaultGenerationConfig()).toEqual({ topP: 0.95 });
    });
  });

  describe('buildRequest', () => {
    it('preserves sampling/reasoning knobs and only normalizes token field names', () => {
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
      expect(result['reasoning_effort']).toBe('medium');
      expect(result['top_p']).toBe(0.95);
      expect(result['top_k']).toBe(20);
      expect(result['frequency_penalty']).toBe(0.1);
      expect(result['presence_penalty']).toBe(0.1);
      expect(result['repetition_penalty']).toBe(1.1);
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

    it('adds Kimi tool-call request defaults when tools are present', () => {
      const original = {
        model: '@cf/moonshotai/kimi-k2.6',
        messages: [
          { role: 'system', content: 'Base system prompt.' },
          { role: 'user', content: 'Build a Snake clone.' },
        ],
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
      const messages =
        result['messages'] as OpenAI.Chat.ChatCompletionMessageParam[];
      const firstMessage = messages[0] as {
        role?: string;
        content?: string;
      } | undefined;

      expect(result['tool_choice']).toBe('auto');
      expect(result['parallel_tool_calls']).toBe(false);
      expect(result['chat_template_kwargs']).toEqual({ thinking: false });
      expect(firstMessage?.role).toBe('system');
      expect(firstMessage?.content).toContain('Base system prompt.');
      expect(firstMessage?.content).toContain('emit an OpenAI tool call');
    });

    it('does not overwrite explicit Kimi tool request settings', () => {
      const original = {
        model: '@cf/moonshotai/kimi-k2.6',
        messages: [{ role: 'user', content: 'Build a Snake clone.' }],
        tool_choice: 'required',
        parallel_tool_calls: true,
        chat_template_kwargs: { thinking: true },
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

      expect(result['tool_choice']).toBe('required');
      expect(result['parallel_tool_calls']).toBe(true);
      expect(result['chat_template_kwargs']).toEqual({ thinking: true });
    });
  });
});
