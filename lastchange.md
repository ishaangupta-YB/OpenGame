# Last Change Handoff (Cloudflare Kimi K2.6 Empty Stream)

## Date
2026-05-01

## Context / Error
Runtime failure seen during agent run:
- `InvalidStreamError: Model stream ended with empty response text.`

Observed with:
- `OPENAI_BASE_URL=https://api.cloudflare.com/client/v4/accounts/<account>/ai/v1`
- `OPENAI_MODEL=@cf/moonshotai/kimi-k2.6`

## Root Cause
Cloudflare Kimi K2.6 can emit long `reasoning_content` streams, and some turns may finish without non-thought assistant text or tool calls. OpenGame's stream validation treated this as fatal (`NO_RESPONSE_TEXT`).

Also, Cloudflare reasoning field shape is drifting across deployments:
- legacy: `reasoning_content`
- newer docs/changelog references: `reasoning`

## What Was Changed

## Follow-up After EC2 Still Showed NO_RESPONSE_TEXT

The first Kimi thought-only allowance required both the Cloudflare base URL and
Kimi model to be visible through `Config.getContentGeneratorConfig()`. The EC2
run still hit `NO_RESPONSE_TEXT`, so the guard was widened to also inspect:

- runtime `model` passed into the stream processor
- configured model/base URL
- `OPENAI_MODEL`
- `OPENAI_BASE_URL`
- `OPENGAME_REASONING_MODEL`
- `OPENGAME_REASONING_BASE_URL`

This matters because the EC2 process may resolve provider details through env
vars or auth settings differently from the local unit-test mock.

The later EC2 output showed a deeper problem: Kimi was not just returning an
empty final assistant message; it was narrating intended tool use:

```text
Let me start by classifying.
[API Error: Model stream ended with empty response text.]
```

That means the model thought about calling `classify_game_type`, but never
emitted the actual OpenAI `tool_calls` delta. To address the actual failure
mode, Cloudflare Kimi requests with tools now get:

- explicit `tool_choice: "auto"` when no tool choice was already set
- a scoped system reminder telling Kimi to emit the tool call directly instead
  of describing or promising a tool call in text

This is deliberately limited to Cloudflare Kimi K2.6 requests with tools.
Plain OpenAI, non-Kimi Cloudflare models, and requests without tools are left
unchanged.

### 1) Cloudflare provider policy aligned to minimal normalization
File:
- `packages/core/src/core/openaiContentGenerator/provider/cloudflare.ts`

Changes:
- Removed aggressive stripping of:
  - `top_p`, `top_k`, `frequency_penalty`, `presence_penalty`, `repetition_penalty`, `reasoning_effort`
- Kept canonicalization:
  - `max_tokens -> max_completion_tokens`
- Removed Cloudflare-specific default override (`getDefaultGenerationConfig(): {}`), so default sampling config is no longer forcibly suppressed.
- For Kimi K2.6 tool requests, adds `tool_choice: "auto"` unless the caller set
  an explicit `tool_choice`.
- For Kimi K2.6 tool requests, appends a provider-scoped tool-call reminder to
  the system prompt so the model calls tools instead of narrating intended tool
  calls.

Why:
- Current Cloudflare K2.6 endpoint in this environment accepts those knobs and does not require blanket stripping.
- Live EC2 output showed Kimi was reasoning about the tool step but not emitting
  a tool call, so request shaping must nudge tool-call emission, not only parse
  reasoning fields.

### 2) Parser compatibility for both reasoning field names
File:
- `packages/core/src/core/openaiContentGenerator/converter.ts`

Changes:
- Added support for both response fields in non-stream and stream conversion:
  - `reasoning_content`
  - `reasoning`
- Added helper:
  - `extractReasoningText(...)`

Why:
- Prevent breakage when Cloudflare deployment returns either variant.

### 3) Thought-only tolerance gated to Cloudflare Kimi K2.6
File:
- `packages/core/src/core/geminiChat.ts`

Changes:
- Added Cloudflare+K2.6 detector helpers.
- Detector now accepts Kimi model spellings containing:
  - `@cf/moonshotai/kimi-k2.6`
  - `moonshotai/kimi-k2.6`
  - `kimi-k2.6`
- Detector now checks configured values and env fallbacks.
- In stream validation, if all are true:
  - finish reason exists,
  - no tool call,
  - no non-thought content,
  - thought text is non-empty,
  - provider/model matches Cloudflare Kimi K2.6,
  then do **not** throw `NO_RESPONSE_TEXT`.
- Added lightweight debug marker (`console.warn`) in debug mode when this compatibility path is used.

Why:
- Keeps strict behavior globally while allowing known Cloudflare K2.6 behavior.

## Tests Updated

### Provider tests
File:
- `packages/core/src/core/openaiContentGenerator/provider/cloudflare.test.ts`

Updated assertions:
- Default generation config now inherits default (`{ topP: 0.95 }`).
- Sampling/reasoning knobs are preserved.
- `max_tokens -> max_completion_tokens` normalization remains verified.

### Converter tests
File:
- `packages/core/src/core/openaiContentGenerator/converter.test.ts`

Added coverage:
- non-stream `reasoning` -> thought part
- stream `reasoning` -> thought part
- existing `reasoning_content` coverage remains.

### Stream validation tests
File:
- `packages/core/src/core/geminiChat.test.ts`

Added/updated:
- Existing empty-response test now uses explicit thought-text part.
- New test: thought-only stream is accepted for Cloudflare Kimi K2.6.

## Files Modified
- `packages/core/src/core/openaiContentGenerator/provider/cloudflare.ts`
- `packages/core/src/core/openaiContentGenerator/provider/cloudflare.test.ts`
- `packages/core/src/core/openaiContentGenerator/converter.ts`
- `packages/core/src/core/openaiContentGenerator/converter.test.ts`
- `packages/core/src/core/geminiChat.ts`
- `packages/core/src/core/geminiChat.test.ts`

## Local Validation Status
Attempted, but blocked by missing local deps and install permissions in this environment:
- `vitest` not present locally
- `npm install` with elevated permissions was rejected in this session

So tests were updated but **not executed here**.

## What To Run On EC2
From repo root:

```bash
npm install
npm run build
```

Recommended targeted tests first:

```bash
npm run test --workspace packages/core -- src/core/openaiContentGenerator/provider/cloudflare.test.ts src/core/openaiContentGenerator/converter.test.ts src/core/geminiChat.test.ts
```

Then smoke run:

```bash
export OPENAI_API_KEY="..."
export OPENAI_BASE_URL="https://api.cloudflare.com/client/v4/accounts/<account>/ai/v1"
export OPENAI_MODEL="@cf/moonshotai/kimi-k2.6"
export OPENGAME_REASONING_PROVIDER="openai-compat"
export OPENGAME_REASONING_API_KEY="$OPENAI_API_KEY"
export OPENGAME_REASONING_BASE_URL="$OPENAI_BASE_URL"
export OPENGAME_REASONING_MODEL="@cf/moonshotai/kimi-k2.6"

opengame -p "Build a Snake clone with WASD controls and a dark theme." --yolo
```

Expected after this change:
- No immediate `NO_RESPONSE_TEXT` abort for Cloudflare Kimi K2.6 thought-only turns.
- Normal turns with content/tool-calls continue as before.

## Notes for Next Agent
If issues persist on EC2, capture:
1. one raw non-stream completion payload
2. one raw stream SSE payload
3. the exact failing prompt + turn

This will confirm whether the model is returning:
- thought-only + stop,
- tool-call chunking anomalies,
- or a different schema drift.
