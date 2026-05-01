/**
 * @license
 * Copyright 2025 OpenGame
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type OpenAI from 'openai';
import { OpenAIDirectProvider } from './openai.js';
import type { Config } from '../../../config/config.js';
import type { ContentGeneratorConfig } from '../../contentGenerator.js';

vi.mock('openai');

describe('OpenAIDirectProvider', () => {
  let mockCliConfig: Config;

  beforeEach(() => {
    mockCliConfig = {
      getCliVersion: vi.fn().mockReturnValue('1.0.0'),
    } as unknown as Config;
  });

  describe('isOpenAIProvider', () => {
    it('matches api.openai.com', () => {
      expect(
        OpenAIDirectProvider.isOpenAIProvider({
          baseUrl: 'https://api.openai.com/v1',
        } as ContentGeneratorConfig),
      ).toBe(true);
    });

    it('does not match other providers', () => {
      expect(
        OpenAIDirectProvider.isOpenAIProvider({
          baseUrl: 'https://api.deepseek.com/v1',
        } as ContentGeneratorConfig),
      ).toBe(false);
    });
  });

  describe('non-reasoning models (gpt-4o, gpt-4o-mini)', () => {
    it('keeps default topP', () => {
      const provider = new OpenAIDirectProvider(
        {
          apiKey: 'k',
          baseUrl: 'https://api.openai.com/v1',
          model: 'gpt-4o-mini',
        } as ContentGeneratorConfig,
        mockCliConfig,
      );
      expect(provider.getDefaultGenerationConfig()).toEqual({ topP: 0.95 });
    });

    it('does not strip top_p / temperature on plain GPT models', () => {
      const provider = new OpenAIDirectProvider(
        {
          apiKey: 'k',
          baseUrl: 'https://api.openai.com/v1',
          model: 'gpt-4o',
        } as ContentGeneratorConfig,
        mockCliConfig,
      );
      const original = {
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'hi' }],
        top_p: 0.9,
        temperature: 0.5,
      } as unknown as OpenAI.Chat.ChatCompletionCreateParams;

      const result = provider.buildRequest(original, 'prompt-id') as Record<
        string,
        unknown
      >;
      expect(result['top_p']).toBe(0.9);
      expect(result['temperature']).toBe(0.5);
    });
  });

  describe('o-series reasoning models (o1, o3, o4)', () => {
    const buildProvider = (model: string) =>
      new OpenAIDirectProvider(
        {
          apiKey: 'k',
          baseUrl: 'https://api.openai.com/v1',
          model,
        } as ContentGeneratorConfig,
        mockCliConfig,
      );

    it.each(['o1-mini', 'o3-mini', 'o4-mini', 'o1-preview'])(
      'returns empty default generation config for %s',
      (model) => {
        expect(buildProvider(model).getDefaultGenerationConfig()).toEqual({});
      },
    );

    it('strips every sampling param for o-series', () => {
      const provider = buildProvider('o4-mini');
      const original = {
        model: 'o4-mini',
        messages: [{ role: 'user', content: 'hi' }],
        top_p: 0.95,
        top_k: 20,
        frequency_penalty: 0.1,
        presence_penalty: 0.1,
        repetition_penalty: 1.1,
        temperature: 0.7,
      } as unknown as OpenAI.Chat.ChatCompletionCreateParams;

      const result = provider.buildRequest(original, 'prompt-id') as Record<
        string,
        unknown
      >;
      expect(result['top_p']).toBeUndefined();
      expect(result['top_k']).toBeUndefined();
      expect(result['frequency_penalty']).toBeUndefined();
      expect(result['presence_penalty']).toBeUndefined();
      expect(result['repetition_penalty']).toBeUndefined();
      expect(result['temperature']).toBeUndefined();
    });

    it('renames max_tokens to max_completion_tokens for o-series', () => {
      const provider = buildProvider('o4-mini');
      const original = {
        model: 'o4-mini',
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 8192,
      } as unknown as OpenAI.Chat.ChatCompletionCreateParams;

      const result = provider.buildRequest(original, 'prompt-id') as Record<
        string,
        unknown
      >;
      expect(result['max_tokens']).toBeUndefined();
      expect(result['max_completion_tokens']).toBe(8192);
    });

    it('preserves tools and reasoning_effort', () => {
      const provider = buildProvider('o4-mini');
      const original = {
        model: 'o4-mini',
        messages: [{ role: 'user', content: 'hi' }],
        reasoning_effort: 'medium',
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
      expect(result['reasoning_effort']).toBe('medium');
      expect((result['tools'] as unknown[]).length).toBe(1);
    });
  });
});
