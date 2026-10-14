# Architecture notes

This repository explores three separate AI engineering patterns. The [README](README.md) is the authoritative setup guide and describes verified behavior, test counts, and limitations.

## SQL policy validation

`SqlSecurityGuardrail.validate` applies a restricted-pattern prefilter, parses T-SQL, enforces batch/type rules, and recursively checks table references and mutation predicates. The UNION regression was caused by treating `_next.type` as UNION, while the parser represents it as SELECT. Traversing `_next` alongside other child nodes closes that gap. SELECT INTO is explicitly rejected despite its SELECT node type.

Typed policy errors and an optional recursive access allowlist are exposed through the same engine. The result-returning API is retained, and a separate strict entry point supports throwing validation. Both benchmark runners report observed latency rather than an upper bound.

No database calls are made. A passing verdict is a policy decision over supported syntax, not a guarantee of safe execution in every schema or permission context.

## Iterative generation and review

A vehicle specification produces a draft, a reviewer assigns a validated 0–1 score, and structured feedback informs the next attempt. The score threshold is authoritative. The final result identifies the highest-scoring completed draft, its attempt, pass status, history, and any interruption error.

This is an inference-time feedback loop using the same model in two roles. No model weights are updated. Human review and domain-specific validation remain appropriate for consequential output.

## Retrieval and evaluation

The Python engine separates model transport, lexical retrieval, dataset generation, and evaluation. Model transport handles pacing, bounded retries, empty text, JSON validation, and normalized scores. Benchmark failures are recorded per row, preserving completed rows. The CLI persists a JSON report with model and mode metadata.

The fixture-based offline mode tests ranking independently of API availability. The live mode uses model judgments for faithfulness, context sufficiency, and chunk relevance. Ranking precision is computed from per-chunk relevance labels, not obtained by asking the model for a single arbitrary precision number.

## Evidence and next steps

The repository contains offline regression tests and reproducible SQL microbenchmark measurements. It does not contain production load tests or independently calibrated live-model quality measurements. Future work includes a larger reviewed dataset, comparison with an embedding retriever, judge calibration, per-call cost/latency instrumentation, and database execution controls.
