# Design decisions and operating boundaries

This document describes implemented decisions, their tradeoffs, and how they
are checked. Proposed quality experiments are in [EXPERIMENTS.md](EXPERIMENTS.md).

## 1. Separate policy decisions from execution authority

SQL validation returns an allow/reject verdict; the exception API wraps that same
verdict. A second policy implementation would invite disagreement and regression.
Recursive access checks inspect set-operation branches and CTE definitions, not
just root FROM clauses. Deny rules override optional allow rules.

The validator trusts the parser's AST representation, not a model's statement
that the query is safe. It cannot resolve view definitions or protect against
effects outside its policy model. Database permissions and execution controls
remain the authority. Unsupported syntax is rejected, which can reject safe
queries as well as dangerous ones.

**Check:** set-operation, CTE, SELECT INTO, mutation, and typed-exception tests.

## 2. Admit bounded work before performing expensive checks

SQL defaults limit input to 100,000 UTF-16 code units, then limit the parsed AST
to 10,000 objects and structural depth 128. An iterative preflight precedes
recursive inspection. CTE scopes are copied only when entering a definition
scope, rather than for every expression node.

These limits reduce accepted workload; they do not bound synchronous parser
runtime. A post-parse check cannot prevent the parser from allocating its AST.
A service handling hostile queries should isolate parsing in a worker/process
with an independently enforced deadline and memory budget.

Model prompts also have character admission limits. Character counts differ
from token counts, especially across languages. Large inputs are rejected rather
than silently truncated; truncation changes the evidence available to a judge.

**Check:** resource-limit tests and no-request assertions for oversized prompts.

## 3. Distinguish transient failures from permanent failures

Transport failures, retryable status codes, and invalid model response contracts
may recover on retry. Known permanent status errors and unknown programming
errors fail fast. Backoff is exponential with a 30-second ceiling; retry counts
remain bounded by configuration. Configuration failures are not output failures.

Retries address availability, not factual quality. Generating another answer can
incur another charge. This policy is appropriate for generation/judging calls;
replaying a state-changing tool would require idempotency guarantees. There is
no cross-process rate limiter, jitter, circuit breaker, or end-to-end deadline.
SDK-level retry and timeout behavior may add work beyond the wrapper's attempts.

**Check:** recovery, exhaustion, permanent-status, and SDK-configuration tests.

## 4. Keep selection and termination explicit

The ad-copy loop revises its latest draft but retains its highest-scoring audited
draft. Equal scores keep the earlier draft. Results distinguish threshold pass,
attempt exhaustion, and model failure. Unknown model fields are removed before
feeding a draft back into the next prompt.

Selecting the maximum can exploit judge noise. The reviewer and generator use
the same model by default, so errors may correlate. A reviewer score is neither
a calibrated probability nor independent evidence of correctness. Prompt text
and feedback remain untrusted data; these precautions do not prove injection
resistance. Test improvement using independent annotations and baselines.

**Check:** score thresholds, best-draft retention, interruption, and termination tests.

## 5. Preserve identity and distinguish ranking from coverage

Lexical retrieval caches document tokens once and uses a bounded top-k selection
instead of sorting every document. It still scans the corpus for each question.
Corpus-position IDs distinguish documents with identical text. These IDs are
stable only for an unchanged corpus ordering, so reports include a dataset hash.

Ranked precision is computed from relevance labels; recall measures missing
relevant documents separately. A precision score of 1 can coexist with missing
evidence. Stable tie-breaking provides reproducibility, not semantic relevance.
Use reviewed labels and a larger corpus before drawing retrieval conclusions.

**Check:** duplicate-text IDs, stable ties, ranking, and dataset-schema tests.

## 6. Report missing evidence rather than inventing a score

Failed evaluation rows retain available intermediate values and an explicit
error. Summaries average only complete rows and publish completed/failed counts.
Otherwise partial metrics could hide missing judge calls or introduce selective
failure bias. No successful rows means null means, not zero-quality estimates.

Live CLI reports checkpoint after each completed or failed row. Unique same-directory temporary files are flushed and fsynced before
replacement, avoiding partial JSON exposure. Handled Ctrl+C records `interrupted`; an abrupt kill can leave `running` status;
this is a checkpoint, not automatic resumability or power-loss durability.
One writer per report path is required. Checkpoints can contain sensitive source
text and generated answers; generated reports are excluded from version control.

**Check:** failure-aware summaries, per-row checkpoint, and valid-report replacement tests.

## Evidence standard

Offline mocks test contracts and control flow. They cannot establish model
accuracy, adversarial robustness, convergence rates, or production throughput.
Microbenchmarks measure local query-validation latency. Live comparisons and
deployment measurements should be reported separately with conditions and failures.
