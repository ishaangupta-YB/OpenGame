/**
 * @license
 * Copyright 2025 OpenGame Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Cloudflare Workers AI / Moonshot Kimi K2.6 request adapter.
 *
 * Several call sites in OpenGame talk to OpenAI-compatible chat completions
 * via raw `fetch()` (the reasoning-side classifier, the GDD generator, and
 * the audio ABC-notation service). When those endpoints point at Cloudflare
 * Workers AI's Kimi K2.6 deployment, the standard OpenAI request shape needs
 * three small adjustments — otherwise the request 400s or returns empty
 * content:
 *
 *   1. Cloudflare's Kimi requires `max_completion_tokens`; vanilla OpenAI's
 *      `max_tokens` is rejected.
 *   2. Kimi K2.6 defaults to `chat_template_kwargs.thinking=true`, which
 *      consumes the entire token budget on `reasoning_content` and leaves
 *      `content` empty. Short, structured outputs (classification JSON,
 *      GDD, ABC notation) don't benefit from reasoning, so we force it off.
 *   3. The reasoning-side default budget (~500 tokens) is too tight even
 *      with thinking off if the user happens to send a long prompt. We
 *      enforce a sensible floor.
 *
 * The main agent loop applies the same adjustments via
 * `CloudflareOpenAICompatibleProvider` (which is wired in through the
 * OpenAI-compat content generator pipeline). This module is the
 * raw-fetch counterpart used by code paths that do not go through that
 * pipeline.
 *
 * The adapter is a no-op for any non-Cloudflare-Kimi configuration.
 */

const DEFAULT_KIMI_MIN_COMPLETION_TOKENS = 1024;

export interface CloudflareKimiAdapterOptions {
  /** Override the minimum `max_completion_tokens` floor enforced by the adapter. */
  minCompletionTokens?: number;
}

export function isCloudflareWorkersAiBaseUrl(
  baseUrl: string | undefined,
): boolean {
  if (!baseUrl) {
    return false;
  }
  const normalized = baseUrl.toLowerCase();
  return (
    normalized.includes('api.cloudflare.com') && normalized.includes('/ai/v1')
  );
}

export function isCloudflareKimiK26Model(model: string | undefined): boolean {
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

/**
 * Adapt an OpenAI-shaped chat-completions payload for Cloudflare Workers AI's
 * Kimi K2.6 deployment. Returns the payload unchanged if the baseUrl + model
 * pair don't point at Kimi-on-Cloudflare.
 *
 * Adapts in place AND returns the same reference, so callers can do either:
 *   const adapted = adaptCloudflareKimiChatRequest(payload, baseUrl, model);
 * or:
 *   adaptCloudflareKimiChatRequest(payload, baseUrl, model);
 */
export function adaptCloudflareKimiChatRequest<
  T extends Record<string, unknown>,
>(
  payload: T,
  baseUrl: string | undefined,
  model: string | undefined,
  options: CloudflareKimiAdapterOptions = {},
): T {
  if (
    !isCloudflareWorkersAiBaseUrl(baseUrl) ||
    !isCloudflareKimiK26Model(model)
  ) {
    return payload;
  }

  const minCompletionTokens =
    options.minCompletionTokens ?? DEFAULT_KIMI_MIN_COMPLETION_TOKENS;

  const adapted = payload as Record<string, unknown>;

  // 1. Rename max_tokens -> max_completion_tokens (only when the caller hasn't
  // already supplied max_completion_tokens directly).
  const maxTokens = adapted['max_tokens'];
  if (
    maxTokens !== undefined &&
    maxTokens !== null &&
    adapted['max_completion_tokens'] === undefined
  ) {
    adapted['max_completion_tokens'] = maxTokens;
  }
  delete adapted['max_tokens'];

  // 2. Enforce a minimum completion-token budget so Kimi has room to produce
  // both reasoning (when re-enabled) AND visible content/JSON.
  const currentBudget = adapted['max_completion_tokens'];
  if (
    typeof currentBudget !== 'number' ||
    currentBudget < minCompletionTokens
  ) {
    adapted['max_completion_tokens'] = minCompletionTokens;
  }

  // 3. Force `chat_template_kwargs.thinking=false` for short structured outputs
  // unless the caller has already opted in.
  const existing =
    typeof adapted['chat_template_kwargs'] === 'object' &&
    adapted['chat_template_kwargs'] !== null &&
    !Array.isArray(adapted['chat_template_kwargs'])
      ? { ...(adapted['chat_template_kwargs'] as Record<string, unknown>) }
      : {};
  if (existing['thinking'] === undefined) {
    existing['thinking'] = false;
  }
  adapted['chat_template_kwargs'] = existing;

  // 4. `reasoning_effort` would 400 alongside `chat_template_kwargs.thinking`.
  delete adapted['reasoning_effort'];

  return payload;
}
