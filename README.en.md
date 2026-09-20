# Jev × 2048

|[简体中文](README.md) | **English**|
|:-:|:-:|

<!-- 📝Badge layout reference: https://daily.dev/blog/readme-badges-github-best-practices#organizing-badges-in-your-readme -->

![License](https://img.shields.io/badge/license-MIT-78dce8?style=for-the-badge)
![Code Size](https://img.shields.io/github/languages/code-size/ARCJ137442/jev-2048?style=for-the-badge&color=78dce8)
![Language](https://img.shields.io/badge/language-TypeScript-78dce8?style=for-the-badge)
![Node](https://img.shields.io/badge/node-%E2%89%A520-78dce8?style=for-the-badge)

<!-- For users -->

Try it:

[![Online Demo](https://img.shields.io/badge/Online%20Demo-Vercel-78dce8?style=for-the-badge)](https://jev-2048-ultra.vercel.app)

<!-- For developers -->

Development status:

[![CI](https://img.shields.io/github/actions/workflow/status/ARCJ137442/jev-2048/ci.yml?style=for-the-badge&label=CI)](https://github.com/ARCJ137442/jev-2048/actions)
[![Conventional Commits](https://img.shields.io/badge/Conventional%20Commits-1.0.0-78dce8?style=for-the-badge)](https://conventionalcommits.org)
![Last Commit](https://img.shields.io/github/last-commit/ARCJ137442/jev-2048?style=for-the-badge&color=78dce8)

---

## Introduction

A browser-based lab bench that uses [TypeSafe AI's "Jev"](https://www.typesafe.ai/) decision model as the decision engine for "2048". Written entirely in [TypeScript](https://www.typescriptlang.org/).

Jev does not generate text. It takes a piece of **state** plus a set of **typed questions**, and returns **structured decisions with calibrated probabilities**.

This project hands every move to Jev and lays its probability distribution, confidence, latency and token cost out on screen. The point is not to build a fun 2048 — it is to make "how context design shapes a decision model" **visible, tunable, and measurable**.

---

## Online Demo

<https://jev-2048-ultra.vercel.app>

A "Free Trial" backend is built in — no API key required. Quota is limited; when it runs out the app prompts you to switch to your own key. See "Getting Started" below to run it locally instead.

---

## Getting Started

### Prerequisites

1. Install [**Node.js**](https://nodejs.org/) (≥ 20)
2. A Jev API key (optional — only needed if you use your own backend)

### Quick run

```bash
git clone https://github.com/ARCJ137442/jev-2048.git
cd jev-2048
npm install
./start.sh
```

`start.sh` runs four steps and aborts on the first failure:

```plaintext
▸ Check DOM id consistency…   tools/check-dom.ts
▸ Run unit tests…             76 tests
▸ Compile client / server…
▸ Start server…
```

Once started, the terminal prints the addresses:

```plaintext
Local      http://localhost:8787/
LAN        http://<你的局域网IP>:8787/
```

### Providing a key

Keys are read in this order (any one is enough):

1. Environment variable `VERCEL_AI_GATEWAY_KEY`
2. `../local/vercel-secret-api-key.sealed` (sealed ciphertext)
3. `../local/vercel-secret-api-key` (plaintext, legacy)

To seal a plaintext key:

```bash
node tools/seal-key.ts ../local/vercel-secret-api-key
# → produces *.sealed, which the server prefers automatically
# once verified, remove the plaintext:
rm ../local/vercel-secret-api-key
```

> ⚠️ **This is not cryptographic protection.** The default passphrase lives in `src/server/seal.ts`; anyone with the repository can decrypt it. It guards against *accidental* exposure — a key showing up in `cat` output, a screenshot, a stray commit — not targeted attacks. Real key protection comes from "never sending it to the client" and "server-side environment variables". For a stricter setup, set `JEV_SEAL_PASSPHRASE` so the source only contains a useless default.

### Manual build

```bash
# Type check
node node_modules/typescript/bin/tsc -p tsconfig.client.json --noEmit
node node_modules/typescript/bin/tsc -p tsconfig.server.json --noEmit
node node_modules/typescript/bin/tsc -p tsconfig.api.json

# Unit tests
node node_modules/typescript/bin/tsc -p tsconfig.test.json
node --test dist-test/test/*.test.js

# Build
node node_modules/typescript/bin/tsc -p tsconfig.client.json   # → public/js/
node node_modules/typescript/bin/tsc -p tsconfig.server.json   # → dist/
```

> 📝 **No bundler.** The client uses native browser ES Modules; tsc emits import paths with explicit `.js` extensions, which browsers load directly. On Termux, `npm`/`npx` have a shebang pointing at a nonexistent `/usr/bin/env`, so `start.sh` invokes tsc's JS entry point through `node` instead.

---

## Project Overview

### Disclaimer

This is a **third-party lab bench** for Jev. It is not affiliated with TypeSafe AI. The rules of "2048" are in the public domain; this project merely borrows them as a decision scenario with a well-defined objective.

### Module architecture

```plaintext
jev-2048
├── src
│   ├── shared
│   │   └── types.ts:       Shared types + board dimensions + spawn distribution
│   ├── client
│   │   ├── engine.ts:      2048 engine, **pure functions**, tile-list model
│   │   ├── metrics.ts:     Board "feature" computation + "trajectory cells"
│   │   ├── decision.ts:    Decision strategy — turns probabilities into a move ★
│   │   ├── api.ts:         Multi-backend adapter + exponential backoff retry
│   │   ├── render.ts:      Canvas board rendering (orange ramp + direction particles)
│   │   ├── chart.ts:       "Confidence trace" chart (area band + median line)
│   │   ├── config.ts:      Long-term settings persistence (no keys)
│   │   ├── session.ts:     Game session persistence (resume after refresh)
│   │   ├── archive.ts:     Save import / export
│   │   └── main.ts:        Wiring layer
│   ├── server
│   │   ├── server.ts:      Local server + key proxy
│   │   └── seal.ts:        Key sealing (AES-256-GCM)
│   └── test
│       ├── engine.test.ts:  49 tests — rules / purity / axis alignment / rect boards
│       ├── archive.test.ts: 20 tests — archive validation, extraction, pace bounds
│       └── seal.test.ts:     7 tests — seal round-trip and safe failure
├── api:                    Vercel Serverless Functions (free-trial backends)
├── tools
│   ├── check-dom.ts:       Build-time DOM id consistency check
│   ├── scan-secrets.ts:    Secret scan (byte-wise + zlib-inflate rescan)
│   └── seal-key.ts:        Plaintext key → ciphertext
├── public:                 Single-page UI + build output
├── DESIGN.md:              Design decision record (handoff; the "why")
└── ...
```

### Technical highlights

- 📌 **Pure TypeScript, unified front and back**, no bundler
- 📌 **Canvas-rendered board**: geometry is constructive — `2·pad + n·cell + (n-1)·gap` always equals the edge length, so margins stay exactly equal at any board size, no tuning required
- 📌 **Engine purity as a hard constraint**: `moveTiles()` never mutates its input. "Legal moves" are determined by *trying each direction* — any side effect would mean every such query actually scrambles the board
- 📌 **No heuristics anywhere**: when the model is unsure we do not silently swap in an algorithm; we surface the uncertainty to the user
- 📌 **Zero credential exposure**: the API key only ever lives in the server process; the browser never sees it

### Configurable parameters

The UI has five drawers, ordered as a user journey:
**Game → Strategy → API → Log → Archive**.

Sections are split by **"whose input does this affect"**, not by feature:

| Section | Affects Jev's input | Affects move execution | Contents |
|---|:-:|:-:|---|
| "Game" | ✗ | ✗ | Board width/height, spawn value range, spawn distribution, initial tile count, animations |
| "Strategy › Context" | **✓** | ✗ | Rule description, strategy hint, consequence prediction, memory depth |
| "Strategy › Rules" | ✗ | **✓** | Decision strategy, confidence threshold |
| "API" | ✗ | ✗ | Backend, key, auto-retry |
| "Log" | — | — | Full round-trips, read-only |
| "Archive" | — | — | Import / export |

> This criterion doubles as a regression test: **change a "Game" setting; if the probability distribution moves, something is wrong.**

The three context knobs are the heart of the bench:

| Parameter | Injected into | What to watch |
|---|---|---|
| "Rule description" | `state.rule_description` | Whether a more precise description improves early-game decisions |
| "Strategy hint" | `state.strategy_hint` | Whether the distribution tightens (`confidence` rises) |
| "Consequence prediction" | `questions.best_move.criteria` | **The most influential switch.** When on, each direction carries a simulated outcome (merge score / remaining empty cells / whether the max tile is in a corner); when off, only the direction name |

### On "no heuristics"

If the model's uncertainty were silently handed to a rule-based algorithm, the measurement would be contaminated — you could no longer tell whether a move came from Jev or from the rules.

So this project **flags** uncertainty instead and leaves the judgement to you. The confidence threshold defaults to **0**, i.e. every move uses the model's output.

### Gateway naming differences ⚠️

Same Jev, same "SystemOne" protocol — each gateway made **different naming choices**:

| | TypeSafe Official | OpenRouter | AI/ML API | Vercel Gateway |
|---|---|---|---|---|
| Endpoint | `/v1/systemone` | `/api/v1/systemone` | `/v1/decisions` | `/v1/evaluate` |
| Model ID | `jev-latest` | `typesafe/jev-1.13` | `typesafe/jev` | `typesafe-ai/jev` |
| **Boolean discriminator** | `noul` | `noul` | `noul` | **`boolean`** |
| Usage field | `input_tokens` | `input_tokens` | `input_tokens` | `inputTokens` |

**Vercel is the sole outlier** — its wrapper renamed `noul` to `boolean`. This was once inverted in our docs: "the docs say noul, the API actually wants boolean" holds *only* for Vercel. The official public `openapi.json` (v0.2.0) confirms `noul`.

`choice` and `score` are identical across all four, so the main path is unaffected.

### Running a local model?

**A plain OpenAI-compatible endpoint cannot reach Jev.**

Jev is a decision model: it takes `state` + `questions` and returns structured answers with probabilities. It has **no `/v1/chat/completions`**. The OpenAI-compatible layers of LM Studio / vLLM / Ollama are text completion — a different job, and forcing them together does not work.

The right approach is to **implement the SystemOne protocol on the local side**, leaving OpenAI compatibility where it belongs: with text models.

- **LiteLLM proxy**: pass-through `/typesafe/v1/systemone` to the official API, with billing and logging
- **LangChain**: `TypeSafeClassifier` reads `TYPESAFE_BASE_URL` and can point at any compatible gateway
- **Roll your own**: implement `POST /v1/systemone` yourself

Fully offline Jev is not possible — the official weights are not open.

### Offline alternative: Laya

[Laya](https://github.com/NandhaKishorM/laya) (Apache-2.0) is an **open-source alternative** to Jev —
also a non-autoregressive decision model that answers every question in a single forward pass and
generates no text. It ships as a Python package with no HTTP server, so you need a thin sidecar
that implements SystemOne.

```plaintext
POST /v1/systemone   request  { state, model, questions }
                     optional per-request head_max_len / max_len
                     response { model, answers, usage, routing }
GET  /v1/models      checkpoints this server can route to
GET  /healthz        health check
```

- Defaults to `http://127.0.0.1:8137`; `--host` / `--port` are configurable
- **No auth by default**; `--api-key <k>` enables `Authorization: Bearer <k>`
- `model` values: `router` (default, language routing) / `english` / `multilingual` / `typed-decisions`
- The response `model` looks like `laya-typed-decisions` and carries an extra `routing` field

#### Differences from Jev ⚠️

| | |
|---|---|
| **Much smaller context** | english=512, multilingual and typed-decisions=1024 tokens; overflow is truncated from the tail |
| **Choice options share a budget** | Option labels share `head_max_len` (512 by default); too many options returns 400 naming the offending question |
| **Confidence is on a different scale** | Thresholds calibrated for Jev **do not transfer**; recalibrate |
| **Type discriminator is `noul`** | Not Vercel's `boolean` |
| **Zero cost** | No key, no per-token billing, no network |

> 📌 The "Local Laya server" backend in this project is reserved for it (default `127.0.0.1:8137`).
> Marked experimental: the adapter is not open-sourced with this repository yet; treat the table above as the spec.

### Potential applications

The value here is not "a model plays 2048" but a **reproducible context bench**:

- Studying how prompts and context shape a classifier's decision quality
- Comparing gateways (official / Vercel / OpenRouter / self-hosted) against the same model
- A reference implementation of how to integrate a structured decision model (full SystemOne call wrapper)

---

## Contributing

### Branches

- `main`: stable, long-term support
- `dev`: active development (ℹ️ **PRs are merged here**)

### How to contribute

- [GitHub Issues](https://github.com/ARCJ137442/jev-2048/issues): report problems, suggestions, bugs
- [GitHub Pull Request](https://github.com/ARCJ137442/jev-2048/pulls): contribute code directly

### Before submitting

```bash
node tools/check-dom.ts && npm test
```

`./start.sh` and CI run the same set of checks — if it passes locally, it passes in CI, and vice versa.

---

<!-- 📝Full rationale for every design decision lives in DESIGN.md — the "why", not the "what" -->
