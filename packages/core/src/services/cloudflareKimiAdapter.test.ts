/**
 * @license
 * Copyright 2025 OpenGame Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  adaptCloudflareKimiChatRequest,
  isCloudflareKimiK26Model,
  isCloudflareWorkersAiBaseUrl,
} from './cloudflareKimiAdapter.js';

const CF_BASE = 'https://api.cloudflare.com/client/v4/accounts/abc/ai/v1';
const KIMI_MODEL = '@cf/moonshotai/kimi-k2.6';

describe('isCloudflareWorkersAiBaseUrl', () => {
  it('matches the OpenAI-compat surface', () => {
    expect(isCloudflareWorkersAiBaseUrl(CF_BASE)).toBe(true);
  });
  it('is case-insensitive', () => {
    expect(
      isCloudflareWorkersAiBaseUrl(
        'https://API.CLOUDFLARE.COM/client/v4/accounts/abc/AI/V1',
      ),
    ).toBe(true);
  });
  it('does not match the native /ai/run image surface', () => {
    expect(
      isCloudflareWorkersAiBaseUrl(
        'https://api.cloudflare.com/client/v4/accounts/abc/ai/run',
      ),
    ).toBe(false);
  });
  it('does not match plain OpenAI', () => {
    expect(isCloudflareWorkersAiBaseUrl('https://api.openai.com/v1')).toBe(
      false,
    );
  });
  it('handles undefined', () => {
    expect(isCloudflareWorkersAiBaseUrl(undefined)).toBe(false);
  });
});

describe('isCloudflareKimiK26Model', () => {
  it('matches the full @cf/ identifier', () => {
    expect(isCloudflareKimiK26Model('@cf/moonshotai/kimi-k2.6')).toBe(true);
  });
  it('matches case-insensitively', () => {
    expect(isCloudflareKimiK26Model('@CF/MoonshotAI/Kimi-K2.6')).toBe(true);
  });
  it('matches a bare alias', () => {
    expect(isCloudflareKimiK26Model('kimi-k2.6')).toBe(true);
  });
  it('does not match older Kimi versions', () => {
    expect(isCloudflareKimiK26Model('kimi-k1.5')).toBe(false);
  });
});

describe('adaptCloudflareKimiChatRequest', () => {
  it('is a no-op when baseUrl is not Cloudflare Workers AI', () => {
    const payload: Record<string, unknown> = {
      model: KIMI_MODEL,
      max_tokens: 500,
    };
    const result = adaptCloudflareKimiChatRequest(
      payload,
      'https://api.openai.com/v1',
      KIMI_MODEL,
    );
    expect(result).toBe(payload);
    expect(result['max_tokens']).toBe(500);
    expect(result['max_completion_tokens']).toBeUndefined();
    expect(result['chat_template_kwargs']).toBeUndefined();
  });

  it('is a no-op when the model is not Kimi K2.6', () => {
    const payload: Record<string, unknown> = {
      model: 'gpt-4o',
      max_tokens: 500,
    };
    const result = adaptCloudflareKimiChatRequest(payload, CF_BASE, 'gpt-4o');
    expect(result['max_tokens']).toBe(500);
    expect(result['chat_template_kwargs']).toBeUndefined();
  });

  it('renames max_tokens to max_completion_tokens', () => {
    const payload: Record<string, unknown> = {
      model: KIMI_MODEL,
      max_tokens: 4096,
    };
    adaptCloudflareKimiChatRequest(payload, CF_BASE, KIMI_MODEL);
    expect(payload['max_tokens']).toBeUndefined();
    expect(payload['max_completion_tokens']).toBe(4096);
  });

  it('forces a minimum completion-token budget when too low', () => {
    const payload: Record<string, unknown> = {
      model: KIMI_MODEL,
      max_tokens: 500,
    };
    adaptCloudflareKimiChatRequest(payload, CF_BASE, KIMI_MODEL);
    expect(payload['max_completion_tokens']).toBe(1024);
  });

  it('respects an explicit higher max_completion_tokens', () => {
    const payload: Record<string, unknown> = {
      model: KIMI_MODEL,
      max_completion_tokens: 8192,
    };
    adaptCloudflareKimiChatRequest(payload, CF_BASE, KIMI_MODEL);
    expect(payload['max_completion_tokens']).toBe(8192);
  });

  it('respects an explicit higher max_tokens after rename', () => {
    const payload: Record<string, unknown> = {
      model: KIMI_MODEL,
      max_tokens: 8192,
    };
    adaptCloudflareKimiChatRequest(payload, CF_BASE, KIMI_MODEL);
    expect(payload['max_completion_tokens']).toBe(8192);
    expect(payload['max_tokens']).toBeUndefined();
  });

  it('applies a custom min budget when provided', () => {
    const payload: Record<string, unknown> = {
      model: KIMI_MODEL,
      max_tokens: 100,
    };
    adaptCloudflareKimiChatRequest(payload, CF_BASE, KIMI_MODEL, {
      minCompletionTokens: 2048,
    });
    expect(payload['max_completion_tokens']).toBe(2048);
  });

  it('forces chat_template_kwargs.thinking=false', () => {
    const payload: Record<string, unknown> = { model: KIMI_MODEL };
    adaptCloudflareKimiChatRequest(payload, CF_BASE, KIMI_MODEL);
    expect(payload['chat_template_kwargs']).toEqual({ thinking: false });
  });

  it('does not overwrite an explicit thinking=true', () => {
    const payload: Record<string, unknown> = {
      model: KIMI_MODEL,
      chat_template_kwargs: { thinking: true, custom: 'keep' },
    };
    adaptCloudflareKimiChatRequest(payload, CF_BASE, KIMI_MODEL);
    expect(payload['chat_template_kwargs']).toEqual({
      thinking: true,
      custom: 'keep',
    });
  });

  it('strips reasoning_effort to avoid 400 on CF Kimi', () => {
    const payload: Record<string, unknown> = {
      model: KIMI_MODEL,
      reasoning_effort: 'medium',
    };
    adaptCloudflareKimiChatRequest(payload, CF_BASE, KIMI_MODEL);
    expect(payload['reasoning_effort']).toBeUndefined();
  });
});
