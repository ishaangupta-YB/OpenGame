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
 * Provider for OpenAI's first-party API (https://api.openai.com/v1).
 *
 * OpenAI's strict validator differs from most other OpenAI-compatible
 * endpoints in two ways the upstream pipeline doesn't handle:
 *
 *   - Non-reasoning models (gpt-4o, gpt-4o-mini, gpt-4-turbo, ...) reject
 *     `reasoning_effort` outright. We address that globally by making
 *     reasoning opt-in (see pipeline.buildReasoningConfig).
 *
 *   - Reasoning models (o1, o3, o4 families) accept ONLY `temperature` (and
 *     even that is restricted), `max_completion_tokens`, `tools`,
 *     `tool_choice`, `parallel_tool_calls`, `response_format`,
 *     `reasoning_effort`. They reject `top_p`, `top_k`, `frequency_penalty`,
 *     `presence_penalty`, `repetition_penalty`, and require
 *     `max_completion_tokens` instead of `max_tokens`.
 *
 * This provider activates for `api.openai.com` base URLs and strips the
 * incompatible fields when the configured model is in the o-series.
 */
export class OpenAIDirectProvider extends DefaultOpenAICompatibleProvider {
  static isOpenAIProvider(config: ContentGeneratorConfig): boolean {
    const baseUrl = config.baseUrl?.toLowerCase() ?? '';
    return baseUrl.includes('api.openai.com');
  }

  private static isOSeriesModel(model: string | undefined): boolean {
    if (!model) {
      return false;
    }
    return /^o[0-9]/i.test(model.trim());
  }

  override getDefaultGenerationConfig(): GenerateContentConfig {
    if (OpenAIDirectProvider.isOSeriesModel(this.contentGeneratorConfig.model)) {
      return {};
    }
    return super.getDefaultGenerationConfig();
  }

  override buildRequest(
    request: OpenAI.Chat.ChatCompletionCreateParams,
    userPromptId: string,
  ): OpenAI.Chat.ChatCompletionCreateParams {
    const baseRequest = super.buildRequest(request, userPromptId);

    if (!OpenAIDirectProvider.isOSeriesModel(baseRequest.model)) {
      return baseRequest;
    }

    const adapted = { ...baseRequest } as OpenAI.Chat.ChatCompletionCreateParams &
      Record<string, unknown>;

    // o-series reasoning models reject every sampling knob.
    delete adapted['top_p'];
    delete adapted['top_k'];
    delete adapted['frequency_penalty'];
    delete adapted['presence_penalty'];
    delete adapted['repetition_penalty'];
    delete adapted['temperature'];

    // Required rename: max_tokens is forbidden for o-series.
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
