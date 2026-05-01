/**
 * @license
 * Copyright 2025 OpenGame
 * SPDX-License-Identifier: Apache-2.0
 */

import type OpenAI from 'openai';
import { DefaultOpenAICompatibleProvider } from './default.js';
import type { ContentGeneratorConfig } from '../../contentGenerator.js';

/**
 * Provider for Cloudflare Workers AI's OpenAI-compatible endpoint.
 *
 * Base URL pattern: https://api.cloudflare.com/client/v4/accounts/<id>/ai/v1
 *
 * Workers AI's compat layer evolves quickly and currently accepts standard
 * sampling/reasoning knobs for Kimi K2.6 in many deployments. To avoid
 * dropping potentially useful controls, this provider keeps all request fields
 * except for one canonicalization that remains broadly required:
 * `max_tokens` -> `max_completion_tokens`.
 */
export class CloudflareOpenAICompatibleProvider extends DefaultOpenAICompatibleProvider {
  static isCloudflareProvider(config: ContentGeneratorConfig): boolean {
    const baseUrl = config.baseUrl?.toLowerCase() ?? '';
    return (
      baseUrl.includes('api.cloudflare.com') && baseUrl.includes('/ai/v1')
    );
  }

  override buildRequest(
    request: OpenAI.Chat.ChatCompletionCreateParams,
    userPromptId: string,
  ): OpenAI.Chat.ChatCompletionCreateParams {
    const baseRequest = super.buildRequest(request, userPromptId);

    const adapted = { ...baseRequest } as OpenAI.Chat.ChatCompletionCreateParams &
      Record<string, unknown>;

    if (
      adapted.max_tokens !== undefined &&
      adapted.max_tokens !== null &&
      adapted.max_completion_tokens === undefined
    ) {
      adapted.max_completion_tokens = adapted.max_tokens;
    }
    delete (adapted as { max_tokens?: number | null }).max_tokens;

    return adapted;
  }
}
