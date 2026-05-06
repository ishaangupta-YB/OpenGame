# CLAUDE.md

Operating notes for Claude Code working in this repository.

## What this is

**OpenGame** — an open-source agentic framework that generates fully playable web games end-to-end from a single text prompt. The agent runtime is forked from `qwen-code` (which itself is forked from Google `gemini-cli`); OpenGame layers **Game Skill** (Template Skill + Debug Skill) and **GameCoder-27B** integration on top, plus the **OpenGame-Bench** evaluator.

CLI binary: `opengame` (built to `dist/cli.js`). Run with `-p "<prompt>" --yolo` for headless one-shot generation.

## Repo layout

Monorepo, **npm workspaces**. Workspaces are `packages/*` and `agent-test`.

```
packages/
  cli/              # CLI entry: React+Ink interactive UI + headless mode
  core/             # Agent runtime, tools, services, LLM providers, MCP, IDE
  sdk-typescript/   # Programmatic TypeScript SDK
  test-utils/       # Shared test helpers
agent-test/         # Game Skill engines + game project templates (vendored)
  template-skill/   # Library evolution: collect → classify → extract → abstract → merge
  debug-skill/      # Debug loop: validate → build → diagnose → repair → record
  templates/        # Game project skeletons
integration-tests/  # E2E + SDK + terminal-bench tests
scripts/            # build.js, build_sandbox.js, lint.js, version.js, telemetry, ...
docs/               # users/, developers/
docs-site/          # Next.js docs website
.github/workflows/  # CI/CD
eslint-rules/       # Custom ESLint plugin
```

Inside `packages/core/src/`: `core/` (agent runtime), `tools/` (function-callable tools), `services/` (asset / fs / git / shell / session / chat compression), `skills/`, `mcp/`, `ide/`, `prompts/`, `telemetry/`, `subagents/`, `qwen/`, `fallback/`.

Inside `packages/cli/src/`: `gemini.tsx` (entry), `nonInteractiveCli.ts` (headless), `commands/`, `ui/`, `config/`, `services/`, `acp-integration/`, `i18n/`.

## Common commands

| Task                                  | Command                                                                           |
| ------------------------------------- | --------------------------------------------------------------------------------- |
| Install                               | `npm install`                                                                     |
| Build everything                      | `npm run build`                                                                   |
| Build + sandbox image                 | `npm run build:all`                                                               |
| Bundle CLI to `dist/cli.js`           | `npm run bundle`                                                                  |
| Run CLI locally                       | `npm run start`                                                                   |
| Debug CLI (Node inspector)            | `npm run debug`                                                                   |
| Unit tests (parallel, all workspaces) | `npm run test`                                                                    |
| Integration (no sandbox)              | `npm run test:integration:sandbox:none`                                           |
| Integration (Docker sandbox)          | `npm run test:integration:sandbox:docker`                                         |
| E2E with verbose output               | `npm run test:e2e`                                                                |
| Type check                            | `npm run typecheck`                                                               |
| Lint                                  | `npm run lint` (fix: `npm run lint:fix`, CI strict: `npm run lint:ci`)            |
| Format                                | `npm run format`                                                                  |
| **Full CI flow**                      | `npm run preflight` (clean → ci → format → lint:ci → build → typecheck → test:ci) |

Always run `npm run preflight` before declaring a non-trivial change done.

## Tech stack

- **Runtime:** Node ≥20, TypeScript 5.3, ESM. Optional Python 3 (for `symusic` audio).
- **CLI UI:** React 19 + Ink 6.
- **Test:** Vitest 3 (~380 test files). MSW for HTTP mocking. memfs / mock-fs for filesystem.
- **Build:** esbuild bundles `dist/cli.js`; per-workspace `tsc` for package builds. Native deps marked external (node-pty, tiktoken, @imgly/background-removal-node, sharp, onnxruntime).
- **Lint/format:** ESLint 9 flat config + custom plugin in `eslint-rules/`, Prettier 3, Husky + lint-staged.
- **Sandbox:** Docker / Podman (`ghcr.io/leigest519/opengame:0.6.0`).
- **LLM SDKs:** `@anthropic-ai/sdk`, `@google/genai`, `openai`, custom Qwen client. OpenAI-compatible providers: DashScope/Tongyi, Doubao, DeepSeek, Cloudflare Workers AI, OpenRouter.

## Conventions and gotchas

- **`.qwen/` is intentional.** User settings live at `~/.qwen/settings.json`, project settings at `.qwen/settings.json`. The directory is named `.qwen` for backward compatibility with the upstream agent runtime — migration to `.opengame` is planned but not done. Don't rename it.
- **Legacy class names from upstream.** The main agent orchestrator is still `GeminiClient` (`packages/core/src/core/client.ts`) and the chat module is `geminiChat.ts`. These names are historical — they are NOT Gemini-specific; they handle all providers via `contentGenerator.ts`.
- **Multi-modal env vars are independent.** `OPENGAME_IMAGE_*`, `OPENGAME_VIDEO_*`, `OPENGAME_AUDIO_*`, `OPENGAME_REASONING_*` configure each modality separately. Main agent LLM uses standard `OPENAI_API_KEY` / `OPENAI_BASE_URL` / `OPENAI_MODEL`. See `.env.example`.
- **Headless mode auto-elevates approval to `auto-edit`** but keeps shell off; pass `--yolo` (or `--approval-mode yolo`) to enable shell.
- **Provider-streaming quirks.** OpenAI-compat providers don't all behave the same. Cloudflare Workers AI sends `delta.content` as `Array<{type:'text', text}>` rather than `string`, and trailing chunks may be usage-only without candidates. The fixes live in `packages/core/src/core/geminiChat.ts` and `packages/core/src/core/openaiContentGenerator/converter.ts` — when adding a new provider, check both files for streaming-edge-case handling.
- **Cloudflare Workers AI / Kimi K2.6 quirks** (`packages/core/src/core/openaiContentGenerator/provider/cloudflare.ts`):
  - Detected by base-URL pattern (`api.cloudflare.com` + `/ai/v1`), NOT by AuthType.
  - **`max_tokens` → `max_completion_tokens` rename** is required.
  - **Reasoning toggle is `chat_template_kwargs.thinking`**, not `enable_thinking`. Reasoning content arrives as `reasoning_content` (sometimes `reasoning`) — both are read in `converter.ts` `extractReasoningText`.
  - **`reasoning_effort` 400s** the CF Kimi deployment — strip it on every request.
  - **Tool-turn 500-trap**: the combination `tool_choice: 'required' + chat_template_kwargs.thinking: false` returns HTTP 500 from Cloudflare with no body. Use `thinking: true` (or omit the toggle) on tool turns.
  - **Tool-turn empty-response trap**: with `tool_choice: 'auto' + thinking: false`, Kimi just chats and never emits a tool call (breaking the agent loop). Tool turns therefore use `tool_choice: 'required' + thinking: true`.
  - **Non-tool turns default to `thinking: false`** to keep first-turn budgets sane (Kimi defaults to thinking-on which routinely consumes the entire token budget producing only `reasoning_content`). Users opt back in via `reasoning: { effort }` in `ContentGeneratorConfig`.
  - **Image surface is different**: chat is `…/ai/v1/chat/completions` (OpenAI-compat JSON), image is `…/ai/run/<model>` (multipart/form-data, returns binary PNG). `CloudflareImageService` in `assetImageService.ts` handles the latter.
  - The agent thought-only allowance for Cloudflare Kimi K2.6 lives in `geminiChat.ts:isCloudflareKimiK26ThoughtOnlyAllowed` — when finish_reason is set, content is empty, but thoughtText is non-empty AND the base URL/model match Cloudflare Kimi, the turn is allowed to proceed instead of throwing `NO_RESPONSE_TEXT`.
  - There is also a raw-fetch adapter `services/cloudflareKimiAdapter.ts` used by call sites that talk to Workers AI directly (game-type-classifier, generate-gdd, audio service) — it applies the same `max_tokens` rename + `thinking: false` default + `reasoning_effort` strip.
- **`agent-test/` is vendored.** It is in workspaces and is excluded from ESLint (`eslint.config.js` ignores it). Don't reformat or refactor inside `agent-test/templates/` — those are deliberate game-project skeletons consumed at runtime.
- **Tool authoring pattern.** Tools extend `BaseDeclarativeTool` (schema) with a `BaseToolInvocation` (lazy execution). Register via `tool-registry.ts`; centralize names in `tool-names.ts`. See `packages/core/src/tools/tools.ts`.
- **License headers.** ESLint enforces license headers on TS/TSX files (`eslint-plugin-license-header`). New files need them.
- **Pre-commit.** Husky runs Prettier + ESLint via lint-staged on `*.{ts,tsx,js,jsx,json,md}`. Don't bypass with `--no-verify` unless explicitly asked.

## Game-generation pipeline (high-level)

```
prompt → classify-game-type   → GameArchetype + PhysicsProfile
       → generate-gdd          → Game Design Document
       → generate-assets       → image / video / audio / tilesets
       → copy-template         → scaffold from Template Skill library
       → code generation       → LLM edits, guided by GDD + template
       → debug loop            → validate → build → diagnose → repair → record
       → playable web game (index.html + source tree)
```

`GameArchetype` ∈ `platformer | top_down | grid_logic | tower_defense | ui_heavy`.

Key files:

- `packages/core/src/tools/game-type-classifier.ts`
- `packages/core/src/tools/generate-gdd.ts`
- `packages/core/src/tools/generate-assets.ts`
- `packages/core/src/tools/copy-template.ts`
- `agent-test/template-skill/src/evolve.ts`
- `agent-test/debug-skill/src/debug-loop.ts`

## Where to look first

| For…                        | Open                                                                                                                     |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| CLI entry / arg parsing     | `packages/cli/src/gemini.tsx`, `packages/cli/src/nonInteractiveCli.ts`                                                   |
| Agent main loop             | `packages/core/src/core/client.ts`, `core/turn.ts`                                                                       |
| Streaming / provider quirks | `packages/core/src/core/geminiChat.ts`, `core/openaiContentGenerator/converter.ts`                                       |
| Adding a tool               | `packages/core/src/tools/tools.ts`, `tool-registry.ts`                                                                   |
| Adding an LLM provider      | `packages/core/src/core/openaiContentGenerator/provider/`                                                                |
| Asset generation            | `packages/core/src/services/assetImageService.ts`, `assetVideoService.ts`, `assetAudioService.ts`, `assetModelRouter.ts` |
| Config / models             | `packages/core/src/config/config.ts`, `config/models.ts`                                                                 |
| User-facing docs            | `docs/users/`                                                                                                            |
| Developer docs              | `docs/developers/`                                                                                                       |
| CI definitions              | `.github/workflows/ci.yml`, `e2e.yml`                                                                                    |

## Things to avoid

- Renaming `GeminiClient` / `geminiChat` / `.qwen` — they are load-bearing legacy names.
- Editing inside `agent-test/templates/` for stylistic reasons.
- Adding non-test files without a license header.
- Using string literals like `'openai'` where an `AuthType` enum exists — prefer `AuthType.USE_OPENAI`.
- Skipping `npm run preflight` on non-trivial changes.
