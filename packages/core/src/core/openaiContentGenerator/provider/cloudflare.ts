/**
 * @license
 * Copyright 2025 OpenGame
 * SPDX-License-Identifier: Apache-2.0
 */

import type OpenAI from 'openai';
import { DefaultOpenAICompatibleProvider } from './default.js';
import type { ContentGeneratorConfig } from '../../contentGenerator.js';

const KIMI_TOOL_CALL_REMINDER =
  'When the next step requires a tool, emit an OpenAI tool call directly in this response. Do not describe, announce, or promise a tool call in text or reasoning instead of emitting it.';

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

  private static isKimiK26Model(model: string | undefined): boolean {
    if (!model) {
      return false;
    }
    const normalized = model.toLowerCase();
    return (
      normalized.includes('@cf/moonshotai/kimi-k2.6') ||
      normalized.includes('moonshotai/kimi-k2.6') ||
      normalized.includes('kimi-k2.6')
    );
  }

  private static hasTools(
    request: OpenAI.Chat.ChatCompletionCreateParams & Record<string, unknown>,
  ): boolean {
    return Array.isArray(request.tools) && request.tools.length > 0;
  }

  private static addKimiToolCallReminder(
    messages: OpenAI.Chat.ChatCompletionMessageParam[],
  ): OpenAI.Chat.ChatCompletionMessageParam[] {
    const alreadyHasReminder = messages.some(
      (message) =>
        message.role === 'system' &&
        typeof message.content === 'string' &&
        message.content.includes(KIMI_TOOL_CALL_REMINDER),
    );
    if (alreadyHasReminder) {
      return messages;
    }

    const [firstMessage, ...remainingMessages] = messages;

    if (firstMessage?.role === 'system') {
      if (typeof firstMessage.content === 'string') {
        return [
          {
            ...firstMessage,
            content: `${firstMessage.content}\n\n${KIMI_TOOL_CALL_REMINDER}`,
          },
          ...remainingMessages,
        ];
      }
    }

    return [
      {
        role: 'system',
        content: KIMI_TOOL_CALL_REMINDER,
      },
      ...messages,
    ];
  }

  private static applyKimiToolRequestDefaults(
    request: OpenAI.Chat.ChatCompletionCreateParams & Record<string, unknown>,
  ): void {
    if (request.tool_choice === undefined) {
      request.tool_choice = 'required';
    }

    if (request.parallel_tool_calls === undefined) {
      request.parallel_tool_calls = false;
    }

    const chatTemplateKwargs =
      typeof request.chat_template_kwargs === 'object' &&
      request.chat_template_kwargs !== null &&
      !Array.isArray(request.chat_template_kwargs)
        ? { ...(request.chat_template_kwargs as Record<string, unknown>) }
        : {};

    // Kimi K2.6 can stream long reasoning-only chunks before never emitting the
    // tool call. For agent turns with tools, prefer direct tool-call behavior.
    if (chatTemplateKwargs['thinking'] === undefined) {
      chatTemplateKwargs['thinking'] = false;
    }
    request.chat_template_kwargs = chatTemplateKwargs;
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

    if (
      CloudflareOpenAICompatibleProvider.isKimiK26Model(
        adapted.model as string | undefined,
      ) &&
      CloudflareOpenAICompatibleProvider.hasTools(adapted)
    ) {
      CloudflareOpenAICompatibleProvider.applyKimiToolRequestDefaults(adapted);
      adapted.messages =
        CloudflareOpenAICompatibleProvider.addKimiToolCallReminder(
          adapted.messages,
        );
    }

    return adapted;
  }
}
