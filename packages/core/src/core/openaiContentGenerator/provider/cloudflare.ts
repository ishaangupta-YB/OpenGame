/**
 * @license
 * Copyright 2025 OpenGame
 * SPDX-License-Identifier: Apache-2.0
 */

import type OpenAI from 'openai';
import type { GenerateContentConfig } from '@google/genai';
import { DefaultOpenAICompatibleProvider } from './default.js';
import type { ContentGeneratorConfig } from '../../contentGenerator.js';

/**
 * Provider for Cloudflare Workers AI's OpenAI-compatible endpoint.
 *
 * Base URL pattern: https://api.cloudflare.com/client/v4/accounts/<id>/ai/v1
 *
 * Workers AI's OpenAI compat layer is stricter than most. The Kimi K2.5/K2.6
 * model pages list these accepted parameters and only these:
 *   temperature, max_completion_tokens, tools[], tool_choice,
 *   parallel_tool_calls, response_format, stream
 *
 * Everything OpenGame's pipeline emits beyond that — `top_p`, `top_k`,
 * `frequency_penalty`, `presence_penalty`, `repetition_penalty`, and
 * `reasoning_effort` — is either silently dropped or causes the model to
 * burn its budget on chain-of-thought without producing tool calls or
 * content, surfacing as `InvalidStreamError: Model stream ended with empty
 * response text.`. We strip them. We also rename the deprecated `max_tokens`
 * to `max_completion_tokens` so the model has a real output budget.
 */
export class CloudflareOpenAICompatibleProvider extends DefaultOpenAICompatibleProvider {
  static isCloudflareProvider(config: ContentGeneratorConfig): boolean {
    const baseUrl = config.baseUrl?.toLowerCase() ?? '';
    return (
      baseUrl.includes('api.cloudflare.com') && baseUrl.includes('/ai/v1')
    );
  }

  override getDefaultGenerationConfig(): GenerateContentConfig {
    // Don't preset top_p — Workers AI doesn't list it as a supported param.
    return {};
  }

  override buildRequest(
    request: OpenAI.Chat.ChatCompletionCreateParams,
    userPromptId: string,
  ): OpenAI.Chat.ChatCompletionCreateParams {
    const baseRequest = super.buildRequest(request, userPromptId);

    const adapted = { ...baseRequest } as OpenAI.Chat.ChatCompletionCreateParams &
      Record<string, unknown>;

    delete adapted['top_p'];
    delete adapted['top_k'];
    delete adapted['frequency_penalty'];
    delete adapted['presence_penalty'];
    delete adapted['repetition_penalty'];
    delete adapted['reasoning_effort'];

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
