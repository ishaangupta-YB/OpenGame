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
 * Cloudflare's compat layer accepts the OpenAI shape but the underlying
 * Workers AI models reject a couple of fields OpenGame's pipeline emits by
 * default:
 *
 *   - `reasoning_effort` is not in the parameter list for any current Workers
 *     AI model (including Kimi K2.5 / K2.6); leaving it in causes the model
 *     to either ignore tools entirely or burn its budget on chain-of-thought
 *     and finish with no real output.
 *   - `max_tokens` is documented as deprecated in favor of
 *     `max_completion_tokens` for Kimi K2.5+. With `max_tokens` ignored, the
 *     stream can end before a tool call is emitted, which surfaces upstream
 *     as `InvalidStreamError: Model stream ended with empty response text.`
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

    if ('reasoning_effort' in adapted) {
      delete adapted['reasoning_effort'];
    }

    if (
      adapted.max_tokens !== undefined &&
      adapted.max_tokens !== null &&
      adapted.max_completion_tokens === undefined
    ) {
      adapted.max_completion_tokens = adapted.max_tokens;
      delete (adapted as { max_tokens?: number | null }).max_tokens;
    }

    return adapted;
  }
}
