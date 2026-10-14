# AI Systems Engineering

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-blue?logo=typescript)](https://www.typescriptlang.org/)
[![Python](https://img.shields.io/badge/Python-3.14-green?logo=python)](https://www.python.org/)
[![Jest](https://img.shields.io/badge/Jest-Offline_tests-red?logo=jest)](https://jestjs.io/)
[![Gemini](https://img.shields.io/badge/Model-Gemini_2.5_Flash-orange?logo=google)](https://ai.google.dev/)

I built this repository to get a better understanding of what happens around a model call: how to check generated SQL, decide whether a draft is worth keeping, and measure whether an answer is supported by its context.

I used three small projects to work through those questions in TypeScript and Python. The examples use vehicle inventory and dealership advertising, which give the checks concrete facts to work against: tables, prices, mileage, and listed features.

The most useful part of the work has been finding where a reasonable-looking implementation breaks. A UNION query can hide a restricted table from an incomplete AST walk. A reviewer can mark a low-scoring draft as passed. A malformed evaluation score can become a perfect score if it is clamped instead of rejected. Those cases shaped the implementation and the regression tests.

This is a learning project I am continuing to develop. The current repository has **181 offline tests**, local SQL microbenchmarks, and a six-case retrieval fixture. I have kept the proposed model-quality experiments separate from the results I can currently support.

## What I built

| Project | Engineering question | Implementation | Offline checks |
| --- | --- | --- | --- |
| [SQL AST guardrail](sql-ast-guardrail/README.md) | What can we enforce before model-generated SQL reaches a database? | T-SQL parsing, recursive access policies, typed rejections, resource admission limits | 81 Jest tests |
| [Generator–reviewer loop](dual-agent-loop/src/DualAgentPipeline.ts) | How do we revise drafts while handling unreliable model responses? | Structured feedback, validated scores, selective retries, best-draft retention | 62 Jest tests |
| [RAG evaluation engine](rag-eval-engine/README.md) | How do we distinguish retrieval coverage, context support, and evaluation failures? | Lexical retrieval, model judges, ranked metrics, checkpointed reports | 38 Python tests |

I kept the three examples independent so each one can be run and inspected on its own. The model-response tests use mocks to exercise failure paths consistently. They tell me whether the software handles those cases; measuring whether a model actually gives better answers needs a different experiment.

## Architecture

```text
SQL policy enforcement
  Raw T-SQL -> input limit -> AST parser -> traversal limits -> policy checks
                                                               |
                                                     verdict / typed rejection

Generator–reviewer feedback
  Vehicle specification -> generator -> reviewer -> validated score
                               ^                         |
                               +---- draft + critique ---+  below threshold
                                                         |
                                      accepted / attempt limit / model error
                                      retain best completed audited draft

Retrieval and evaluation
  Question + corpus -> lexical top-k -> context-grounded answer
                                             |
                                    model-based evaluation
                                             |
                              per-row results -> checkpointed JSON
```

I separated SQL validation from execution so the caller remains responsible for database access. In the Python project, synthetic question/reference generation is also a separate step: generated reference answers need review before I would rely on them in a benchmark.

## Project #1 — AST-based T-SQL security guardrail

**Stack:** TypeScript, Node.js, `node-sql-parser`, Jest.

I wanted the SQL policy to be inspectable without asking another model whether a query was safe. I used `node-sql-parser` to inspect T-SQL structure before execution. Read-only mode rejects non-SELECT statements, with a separate check for SELECT INTO because a SELECT node can still write a table.

- Recursively inspects joins, nested queries, set-operation branches, and CTE definitions.
- Supports an optional table-access allowlist; system-schema and deny rules override allow rules.
- Requires an explicit `mutableTables` allowlist when mutations are enabled.
- Rejects unscoped UPDATE/DELETE statements and common unsafe predicate shapes, including `WHERE 1=1` and `WHERE col=col`.
- Rejects unsupported syntax and enforces input/AST admission limits.
- Exposes both a result-returning API and typed `SecurityPolicyViolationError` exceptions through the same engine.

The UNION regression was a useful lesson in reading the actual parser output. Its branches are SELECT nodes linked through `_next`; looking for a node called UNION missed the second query. I kept that failure as a regression test and used the same recursive engine for both public APIs.

What I took from this: the security boundary depends on the structures the code actually visits. A convincing policy description does not help if one branch of the AST is skipped.

**What this check can cover:** CTE handling follows local alias scopes for the supported syntax; it does not resolve database catalogs or arbitrary recursive CTE semantics. Predicate checks are conservative, not a theorem prover. Parser validation cannot establish view behavior, tenant isolation, or database permissions.

Default admission limits are 100,000 UTF-16 SQL code units, 10,000 parsed AST objects, and structural depth 128. AST limits apply after parsing and cannot bound parser CPU or memory. Hostile workloads need isolation and independently enforced execution limits.

[API, configuration, and benchmark guide](sql-ast-guardrail/README.md)

## Project #2 — Generator–reviewer orchestration loop

**Stack:** TypeScript, Google GenAI SDK, structured response schemas, Jest.

For the second project, I chose a task where unsupported details are easy to describe: writing vehicle ads from a supplied specification. The generator writes the draft, and a reviewer checks it against the original facts. The next attempt receives the previous draft and structured feedback.

- Uses `responseSchema` plus runtime validation of generated copy and critique scores.
- Rejects invalid or out-of-range scores; the model's `passed` flag cannot override the configured threshold.
- Retains the highest-scoring completed draft even when later iterations score worse or fail.
- Retries transient network/status failures and malformed replies; known permanent failures and unknown programming errors fail fast.
- Caps backoff at 30 seconds and enforces a prompt admission budget.
- Returns history, `bestAttempt`, `passed`, and `terminationReason`: `passed`, `attempt_limit`, or `model_error`.

Defaults are three attempts and a 0.90 score threshold; both are configurable. A failure before any completed audit throws. Later failures return the best completed audited draft with the interruption error.

The main lesson here was to make the stopping rule explicit. A model saying `passed: true` should not override a score below the configured threshold, and the last attempt should not automatically replace a better earlier draft.

I also had to separate what the loop does from what I can claim about it. This is inference-time feedback; it does not train the model. Both roles use the same model, so they may share blind spots. Keeping the highest score can also select for reviewer noise. I still need an independent comparison with single-pass generation to know whether the extra calls improve factual accuracy.

[Implementation](dual-agent-loop/src/DualAgentPipeline.ts) · [Types and result contract](dual-agent-loop/src/types.ts) · [Proposed comparisons](EXPERIMENTS.md)

## Project #3 — Context-grounded RAG evaluation engine

**Stack:** Python, Google GenAI SDK, pandas, standard-library unittest.

I built the third project to make evaluation more concrete than reading a few answers and deciding they look good. It starts with a lexical retrieval baseline, generates an answer from the selected context, and records separate judgments about the answer and its evidence.

I kept the retriever simple so its behavior is easy to inspect. It caches corpus tokens, uses stable top-k selection, and keeps document IDs separate from document text. That last detail matters when two documents contain the same text but have different relevance labels.

| Metric | Meaning | Important limit |
| --- | --- | --- |
| Faithfulness | Custom holistic model judgment of whether answer claims are supported by the combined context | Not an implemented supported-claims/total-claims calculation; faithful repetition can still repeat a false source |
| Context sufficiency | Model judgment of whether the combined context contains the reference answer's needed facts | Depends on reference quality and judge calibration |
| Context precision | Per-query AP-style ranking score computed from chunk relevance labels | Normalized by relevant retrieved chunks; missing evidence requires a separate recall metric |
| Offline retrieval recall | Fraction of fixture-labelled relevant documents retrieved | The demo reports 0 when no relevant documents exist; evaluate correct abstention separately |

For ranked boolean labels, context precision averages precision at each relevant rank and divides by the number of relevant retrieved chunks. No relevant chunks gives 0. Thus `[True, False]` scores 1 and `[False, True]` scores 0.5. This is not corpus-normalized AP or, by itself, Mean Average Precision (MAP). Arithmetic is deterministic given labels; live model-generated labels remain stochastic. The project implements its own metrics and does not depend on Ragas.

I also treated the report as part of the experiment. If a request fails halfway through a batch, I want to retain what finished and see what is missing:

- Strict dataset and finite 0–1 score validation; malformed scores are rejected rather than clamped.
- Bounded transient retries and monotonic start-to-start request pacing, including retries.
- Per-row error isolation, with failed counts separate from complete-row averages.
- Atomic report replacement with unique sibling temp files, file flush/fsync, and cleanup on failure.
- A typed model interface, typed result records, and isolated checkpoint callback snapshots.
- Versioned reports with dataset hash, document IDs, settings, timestamps, and run status.
- Optional progress on stderr, keeping completed-run stdout machine-readable JSON.

One practical limit: `--rpm` spaces requests within one client. It is not a shared quota manager and cannot guarantee that the API will never return 429. Checkpoints preserve finished rows but do not automatically resume a run or guarantee power-loss durability on every platform. Reports can contain sensitive input and output text.

[Evaluator guide](rag-eval-engine/README.md) · [Hand-authored fixture](rag-eval-engine/examples/benchmark.json) · [Offline results](rag-eval-engine/examples/offline-results.json)

## What I learned, and what I want to test next

Three distinctions became important as the projects developed:

- **A valid response is not necessarily a correct answer.** Runtime schemas and score validation protect the software boundary. They do not establish that the reviewer understood the facts.
- **Ranking and coverage answer different questions.** A retrieval result can have a high precision score while missing another document needed for the answer. I report recall separately in the offline fixture.
- **A failed evaluation is missing evidence.** Turning it into zero, omitting it without a count, or silently switching datasets changes the meaning of a result. Failures are recorded alongside completed rows.

There are two places where I want human review in the evaluation process: checking synthetic reference answers before using them as labels, and assessing candidate answers independently of the model that generated or reviewed them. Those review experiments are still planned; the checked-in fixture and mocked tests do not substitute for them.

My next step is a controlled comparison of single-pass generation, repeated generation without feedback, and the reviewer loop on the same specifications. I want to measure factual errors, failed runs, token cost, and latency together. For retrieval, I want a larger reviewed dataset and a comparison between this lexical baseline and a richer retriever. The protocol is in [EXPERIMENTS.md](EXPERIMENTS.md).

## Run the projects

Run each section from the repository root. There is no root-level dependency install; each project owns its dependencies.

### Prerequisites

- **Node.js 22 and npm:** the TypeScript CI target. Recorded local benchmarks used Node.js 24.13.1.
- **Python 3.14:** the CI target and local environment used for the pinned Python dependencies. Earlier versions have not been verified here.
- **Gemini API key:** required only for live generation/evaluation. Offline tests and the retrieval fixture require no credentials.

### 1. SQL policy tests and benchmarks

The following commands work in PowerShell and a Unix shell:

```text
npm --prefix sql-ast-guardrail ci
npm --prefix sql-ast-guardrail test -- --runInBand
npm --prefix sql-ast-guardrail run build
npm --prefix sql-ast-guardrail run check:benchmark
npm --prefix sql-ast-guardrail run benchmark
node sql-ast-guardrail/scripts/benchmark.cjs
```

### 2. Generator–reviewer tests

```text
npm --prefix dual-agent-loop ci
npm --prefix dual-agent-loop test -- --runInBand
npm --prefix dual-agent-loop run build
```

For a live example, copy `dual-agent-loop/.env.example` to `dual-agent-loop/.env`, set `GEMINI_API_KEY`, and run:

```text
npm --prefix dual-agent-loop start
```

The driver exits nonzero for rejected or interrupted output. Live calls can incur costs.

### 3. Python setup on Windows PowerShell

```powershell
cd rag-eval-engine
py -3.14 -m venv venv
.\venv\Scripts\Activate.ps1
python -m pip install -r requirements.txt
python -m unittest discover -s tests -v
python eval_harness.py --offline --progress --output reports/offline.json
```

If script execution blocks activation, use the interpreter directly, for example `venv\Scripts\python.exe -m pip install -r requirements.txt`. Alternatively, `Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass` applies only to the current PowerShell session.

### Python setup on Linux/macOS

```bash
cd rag-eval-engine
python3.14 -m venv venv
source venv/bin/activate
python -m pip install -r requirements.txt
python -m unittest discover -s tests -v
python eval_harness.py --offline --progress --output reports/offline.json
```

### Live evaluation

Inside `rag-eval-engine`, copy `.env.example` to `.env` and set `GEMINI_API_KEY`. Then run:

```text
python eval_harness.py --model gemini-2.5-flash --rpm 5 --top-k 3 --progress --output reports/live.json
```

Use `--dataset` for another dataset matching the checked-in fixture schema. Missing files fail explicitly. `--max-context-chars` defaults to 50,000; oversized combined contexts are reported as failures rather than silently truncated. The model transport also enforces its own prompt admission limit. Character limits are not token limits.

The six-case fixture with three retrieved chunks requires up to 36 initial model calls, plus retries, and can take several minutes. The API model name and availability must match your provider access. Local pacing does not establish your account's quota.

| Live CLI outcome | Report state | Exit code |
| --- | --- | --- |
| Batch completes with every row successful | `complete` | 0 |
| Batch completes with failed rows | `complete`, with failure counts | 1 |
| Handled Ctrl+C during evaluation | `interrupted`, with finished rows retained | 130 |
| Invalid CLI arguments | No successful evaluation implied | 2 |

An abrupt process kill can leave a valid checkpoint marked `running`. Other configuration/storage failures propagate. The output path cannot resolve to the input dataset path.

## What I have checked so far

| Project | Available evidence | What it does not establish |
| --- | --- | --- |
| SQL guardrail | 81 policy/regression tests and local validation microbenchmarks | Universal injection resistance or fixed latency |
| Generator–reviewer loop | 62 mocked control-flow and response-contract tests | 100% convergence or improved real-model factual accuracy |
| RAG evaluator | 38 offline tests and six hand-authored retrieval cases | General retrieval accuracy or calibrated live-judge quality |

TypeScript checks were verified locally on October 13, 2026; Python checks were reverified on October 14, 2026. The [GitHub Actions workflow](.github/workflows/ci.yml) installs dependencies, runs offline checks, builds TypeScript, and checks/runs the SQL benchmark. Its remote status must be verified after publication.

### Recorded SQL latency

I measured the [strict API](sql-ast-guardrail/benchmark-typed-results.json) locally using one permitted query. I included the first-call and tail measurements because the warmed average alone leaves out useful information:

| Measurement | Recorded value |
| --- | ---: |
| First validation, excluding imports/construction | 9.5136 ms |
| Warmed batch mean | 0.1552 ms/query |
| Separately sampled median | 0.1271 ms/query |
| Separately sampled p95 | 0.2225 ms/query |

Conditions: Windows, Node.js 24.13.1, Intel Core i7-11700, 100 warmup iterations, 5,000 batch iterations, and a separate 5,000-call sample. Per-call timing adds instrumentation overhead. I measured query validation only; model calls, database execution, concurrency, and network latency are outside this benchmark. The mean is below 0.2 ms, while the first call and p95 show why I would not advertise that number as a guarantee.

The [multi-query benchmark](sql-ast-guardrail/benchmark-results.json) additionally covers allowed and rejected queries. Re-run both benchmarks on your own workload and hardware before setting a service target.

## Repository layout

```text
.
├── .github/workflows/ci.yml
├── sql-ast-guardrail/
│   ├── src/SecurityGuardrail.ts       # Result API and shared policy engine
│   ├── src/SqlSecurityGuardrail.ts    # Strict throwing entry point
│   ├── scripts/benchmark.ts           # Strict API microbenchmark
│   ├── scripts/benchmark.cjs          # Multi-query result API benchmark
│   └── tests/
├── dual-agent-loop/
│   ├── src/DualAgentPipeline.ts
│   ├── src/types.ts
│   ├── src/index.ts
│   └── tests/
├── rag-eval-engine/
│   ├── model_client.py
│   ├── retrieval.py
│   ├── synth_generator.py
│   ├── eval_harness.py
│   ├── requirements.txt
│   ├── examples/
│   └── tests/
├── DESIGN.md
├── EXPERIMENTS.md
├── PUBLISHING.md
└── LICENSE
```

## Further notes

- [Design decisions](DESIGN.md): implemented tradeoffs, failure modes, resource boundaries, and supporting checks.
- [Experiment plan](EXPERIMENTS.md): single-pass baselines, independent annotations, judge calibration, repeated runs, and cost/latency comparisons. Proposed experiments are not reported findings.
- [Architecture notes](production_grade_ai_systems_architecture_showcase.md): a concise account of the three patterns.
- [GitHub publishing guide](PUBLISHING.md): steps for publishing the repository.

Commit source, tests, npm lockfiles, Python requirements, and curated examples. `.gitignore` excludes local `.env` files, dependencies, virtual environments, build output, caches, and generated reports. Keep credentials out of commits; `.env.example` files contain placeholders only.

## License

[MIT](LICENSE). Third-party dependencies retain their respective licenses.
