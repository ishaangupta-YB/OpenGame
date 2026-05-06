/**
 * @license
 * Copyright 2025 OpenGame
 * SPDX-License-Identifier: Apache-2.0
 */

import OpenAI from 'openai';
import { appendFileSync } from 'node:fs';
import { DefaultOpenAICompatibleProvider } from './default.js';
import type { ContentGeneratorConfig } from '../../contentGenerator.js';
import { DEFAULT_TIMEOUT, DEFAULT_MAX_RETRIES } from '../constants.js';

const KIMI_TOOL_CALL_REMINDER =
  '## CRITICAL OUTPUT CONTRACT\n' +
  'Your VERY FIRST output token in this response MUST be the start of an OpenAI tool call (function call). ' +
  'DO NOT emit any plain text. ' +
  'DO NOT think out loud first. ' +
  'DO NOT plan in prose, in markdown, or in reasoning_content. ' +
  'DO NOT say "Let me", "First, I will", "I\'ll", or any narration. ' +
  'If you are unsure which tool to call, call the most appropriate one anyway — never respond with text. ' +
  'Failing to emit a tool call as the first output is a hard contract violation.';

const KIMI_TOOL_CALL_USER_NUDGE =
  'Reminder: respond with a single OpenAI tool call. No text, no explanation, no narration — just the tool call.';

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
  override buildClient(): OpenAI {
    if (process.env['OPENGAME_CF_DEBUG'] !== '1') {
      return super.buildClient();
    }
    const {
      apiKey,
      baseUrl,
      timeout = DEFAULT_TIMEOUT,
      maxRetries = DEFAULT_MAX_RETRIES,
    } = this.contentGeneratorConfig;
    const defaultHeaders = this.buildHeaders();
    const dumpFile = process.env['OPENGAME_CF_DEBUG_FILE'];
    const debugFetch = async (
      input: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      const body =
        init?.body && typeof init.body === 'string'
          ? JSON.parse(init.body)
          : null;
      const summary = {
        url: typeof input === 'string' ? input : input.toString(),
        method: init?.method,
        tool_choice: body?.tool_choice,
        parallel_tool_calls: body?.parallel_tool_calls,
        chat_template_kwargs: body?.chat_template_kwargs,
        reasoning_effort: body?.reasoning_effort,
        max_completion_tokens: body?.max_completion_tokens,
        max_tokens: body?.max_tokens,
        stream: body?.stream,
        n_messages: body?.messages?.length,
        n_tools: body?.tools?.length,
      };
      const line = `[cf-debug WIRE] ${JSON.stringify(summary)}\n`;
      if (dumpFile) {
        appendFileSync(dumpFile, line);
      } else {
        process.stderr.write(line);
      }
      return globalThis.fetch(input, init);
    };
    return new OpenAI({
      apiKey,
      baseURL: baseUrl,
      timeout,
      maxRetries,
      defaultHeaders,
      fetch: debugFetch as typeof globalThis.fetch,
    });
  }

  static isCloudflareProvider(config: ContentGeneratorConfig): boolean {
    const baseUrl = config.baseUrl?.toLowerCase() ?? '';
    return baseUrl.includes('api.cloudflare.com') && baseUrl.includes('/ai/v1');
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

  /**
   * Flatten OpenAI multimodal `content: [{type:'text', text}, ...]` to a plain
   * string when every part is text. Cloudflare's Kimi K2.6 deployment is
   * sensitive to the array form on tool turns: with the array shape and many
   * tools, it ignores `tool_choice: 'required'` and just emits reasoning.
   * Strings always work.
   */
  private static flattenTextOnlyContent(
    messages: OpenAI.Chat.ChatCompletionMessageParam[],
  ): OpenAI.Chat.ChatCompletionMessageParam[] {
    return messages.map((message) => {
      if (
        Array.isArray(message.content) &&
        message.content.every(
          (part) =>
            part &&
            typeof part === 'object' &&
            'type' in part &&
            (part as { type?: string }).type === 'text' &&
            typeof (part as { text?: unknown }).text === 'string',
        )
      ) {
        return {
          ...message,
          content: message.content
            .map((part) => (part as { text: string }).text)
            .join(''),
        } as OpenAI.Chat.ChatCompletionMessageParam;
      }
      return message;
    });
  }

  private static addKimiToolCallReminder(
    messages: OpenAI.Chat.ChatCompletionMessageParam[],
  ): OpenAI.Chat.ChatCompletionMessageParam[] {
    let result = messages;
    const alreadyHasSystemReminder = result.some(
      (message) =>
        message.role === 'system' &&
        typeof message.content === 'string' &&
        message.content.includes('CRITICAL OUTPUT CONTRACT'),
    );

    if (!alreadyHasSystemReminder) {
      const [firstMessage, ...remainingMessages] = result;
      if (
        firstMessage?.role === 'system' &&
        typeof firstMessage.content === 'string'
      ) {
        result = [
          {
            ...firstMessage,
            content: `${firstMessage.content}\n\n${KIMI_TOOL_CALL_REMINDER}`,
          },
          ...remainingMessages,
        ];
      } else {
        result = [
          {
            role: 'system',
            content: KIMI_TOOL_CALL_REMINDER,
          },
          ...result,
        ];
      }
    }

    // Append a fresh "tool call only" nudge to the last user message so the
    // instruction is the most-recent thing in Kimi's attention. The existing
    // assistant context-bootstrap pair pushes the agent's task far back in the
    // window — restating the contract right before the assistant turn pulls
    // Kimi's behavior back to tool-call mode.
    const lastIndex = result.length - 1;
    if (lastIndex >= 0 && result[lastIndex].role === 'user') {
      const last = result[lastIndex];
      const lastContent = last.content;
      if (typeof lastContent === 'string') {
        result = [
          ...result.slice(0, lastIndex),
          {
            ...last,
            content: `${lastContent}\n\n${KIMI_TOOL_CALL_USER_NUDGE}`,
          } as OpenAI.Chat.ChatCompletionMessageParam,
        ];
      }
    }

    return result;
  }

  private static mergeChatTemplateKwargs(
    request: OpenAI.Chat.ChatCompletionCreateParams & Record<string, unknown>,
  ): Record<string, unknown> {
    return typeof request.chat_template_kwargs === 'object' &&
      request.chat_template_kwargs !== null &&
      !Array.isArray(request.chat_template_kwargs)
      ? { ...(request.chat_template_kwargs as Record<string, unknown>) }
      : {};
  }

  private static applyKimiToolRequestDefaults(
    request: OpenAI.Chat.ChatCompletionCreateParams & Record<string, unknown>,
  ): void {
    // Cloudflare's Kimi K2.6 deployment quirks observed empirically:
    //   - `tool_choice: 'required' + thinking: false` → HTTP 500.
    //   - `tool_choice: 'required' + thinking: true` → model ignores `required`
    //     under large prompts (>10k tokens) + many tools (16) and emits only
    //     reasoning text instead of a tool call.
    //   - `tool_choice: 'auto'    + thinking: false` → reliably emits a tool
    //     call when paired with a strong system contract + last-user nudge
    //     telling the model "first output must be a tool call".
    //
    // We use option 3 (`auto` + `thinking: false`) and rely on
    // `KIMI_TOOL_CALL_REMINDER` (system) + `KIMI_TOOL_CALL_USER_NUDGE` (last
    // user msg) to keep the model in tool-call mode.
    if (request.tool_choice === undefined) {
      request.tool_choice = 'auto';
    }

    if (request.parallel_tool_calls === undefined) {
      request.parallel_tool_calls = false;
    }

    const chatTemplateKwargs =
      CloudflareOpenAICompatibleProvider.mergeChatTemplateKwargs(request);

    if (chatTemplateKwargs['thinking'] === undefined) {
      chatTemplateKwargs['thinking'] = false;
    }
    request.chat_template_kwargs = chatTemplateKwargs;

    // Cloudflare's Kimi deployment doesn't recognize OpenAI's reasoning_effort
    // and may 400 when it's left alongside `chat_template_kwargs.thinking`.
    delete (request as { reasoning_effort?: unknown }).reasoning_effort;
  }

  /**
   * For non-tool turns, control Kimi K2.6's `chat_template_kwargs.thinking`
   * toggle. Why this is needed:
   *
   * Kimi K2.6 on Cloudflare defaults to thinking-on. In streaming mode the
   * model emits its chain-of-thought as `reasoning_content` chunks and the
   * final visible `content` only at the very end. With a typical agent-loop
   * token budget the model frequently exhausts the budget mid-thought and
   * the stream terminates with `finish_reason: "length"` and **no visible
   * content**. The downstream agent loop then has nothing to act on and the
   * turn fails (`Model stream ended with empty response text`).
   *
   * Mapping:
   *   `reasoning === undefined` → thinking=false (default for the agent loop).
   *   `reasoning === false`     → thinking=false.
   *   `reasoning` is an object  → thinking=true (user opted into reasoning).
   *
   * `reasoning_effort` is stripped because Cloudflare's Kimi deployment
   * doesn't recognize it and may 400 if it's left alongside
   * `chat_template_kwargs.thinking`.
   *
   * Only honored when the user hasn't already set
   * `chat_template_kwargs.thinking` themselves — explicit user settings always
   * win. The tool-turn branch `applyKimiToolRequestDefaults` runs separately
   * and remains the authoritative path during agent tool calls.
   */
  private static applyKimiReasoningRequestDefaults(
    request: OpenAI.Chat.ChatCompletionCreateParams & Record<string, unknown>,
    reasoning: ContentGeneratorConfig['reasoning'],
  ): void {
    const chatTemplateKwargs =
      CloudflareOpenAICompatibleProvider.mergeChatTemplateKwargs(request);

    if (chatTemplateKwargs['thinking'] === undefined) {
      const wantsReasoning = reasoning !== undefined && reasoning !== false;
      chatTemplateKwargs['thinking'] = wantsReasoning;
    }
    request.chat_template_kwargs = chatTemplateKwargs;

    delete (request as { reasoning_effort?: unknown }).reasoning_effort;
  }

  override buildRequest(
    request: OpenAI.Chat.ChatCompletionCreateParams,
    userPromptId: string,
  ): OpenAI.Chat.ChatCompletionCreateParams {
    const baseRequest = super.buildRequest(request, userPromptId);

    const adapted = {
      ...baseRequest,
    } as OpenAI.Chat.ChatCompletionCreateParams & Record<string, unknown>;

    if (
      adapted.max_tokens !== undefined &&
      adapted.max_tokens !== null &&
      adapted.max_completion_tokens === undefined
    ) {
      adapted.max_completion_tokens = adapted.max_tokens;
    }
    delete (adapted as { max_tokens?: number | null }).max_tokens;

    const isKimi = CloudflareOpenAICompatibleProvider.isKimiK26Model(
      adapted.model as string | undefined,
    );
    const hasTools = CloudflareOpenAICompatibleProvider.hasTools(adapted);

    if (isKimi) {
      adapted.messages =
        CloudflareOpenAICompatibleProvider.flattenTextOnlyContent(
          adapted.messages,
        );
    }

    if (isKimi && hasTools) {
      CloudflareOpenAICompatibleProvider.applyKimiToolRequestDefaults(adapted);
      adapted.messages =
        CloudflareOpenAICompatibleProvider.addKimiToolCallReminder(
          adapted.messages,
        );
    } else if (isKimi) {
      CloudflareOpenAICompatibleProvider.applyKimiReasoningRequestDefaults(
        adapted,
        this.contentGeneratorConfig.reasoning,
      );
    }

    if (process.env['OPENGAME_CF_DEBUG'] === '1') {
      const dump = {
        model: adapted.model,
        tool_choice: (adapted as Record<string, unknown>)['tool_choice'],
        parallel_tool_calls: (adapted as Record<string, unknown>)[
          'parallel_tool_calls'
        ],
        chat_template_kwargs: (adapted as Record<string, unknown>)[
          'chat_template_kwargs'
        ],
        reasoning_effort: (adapted as Record<string, unknown>)[
          'reasoning_effort'
        ],
        max_completion_tokens: (adapted as Record<string, unknown>)[
          'max_completion_tokens'
        ],
        stream: adapted.stream,
        n_messages: adapted.messages?.length,
        n_tools: adapted.tools?.length,
      };
      const dumpFile = process.env['OPENGAME_CF_DEBUG_FILE'];
      if (dumpFile) {
        appendFileSync(
          dumpFile,
          `[cf-debug provider] ${JSON.stringify(dump)}\n`,
        );
      } else {
        process.stderr.write(`[cf-debug provider] ${JSON.stringify(dump)}\n`);
      }
    }

    return adapted;
  }
}
