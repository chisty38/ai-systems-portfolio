# Investigation plan and evidence boundaries

Status: proposed experiments. The repository's offline checks are implemented;
the live-model comparisons below have not been run. Do not present this plan as
experimental findings or a production reliability guarantee.

## Questions

1. Does generator–reviewer feedback reduce unsupported claims relative to a
   single generation, after accounting for extra calls and selection effects?
2. How does lexical retrieval compare with alternative retrievers on an
   independently reviewed dataset, including insufficient-context cases?
3. Which SQL policy violations does the parser-based validator detect, and
   which safe queries does its conservative policy incorrectly reject?

## Generator–reviewer comparison

Use a fixed set of vehicle specifications with reference feature lists. Include
cases with tempting but unlisted features, conflicting input, and sparse valid
specifications. Split development and held-out cases before adjusting prompts
or acceptance thresholds. Invalid input rejection is a separate software test.

Compare these conditions on the same cases:

| Condition | Purpose |
| --- | --- |
| Single generation | Baseline |
| Repeated generation without feedback | Separate extra sampling from critique benefit |
| Generate–review–revise | Current workflow |
| Independent review of outputs from each condition | Assess shared-model blind spots |

Keep the generation model/version and generation settings fixed where possible.
Record prompt versions, input hashes, timestamps, settings, all intermediate
drafts, raw critiques, token usage, request latency, retries, and termination
reason. Report both equal-call-budget and equal-cost-budget comparisons; a
review call consumes resources that could otherwise generate another candidate.

Blind human reviewers to the condition that produced each draft. Annotate
unsupported factual claims, omitted required facts, and CTA presence separately
from stylistic preference. Reviewer score is not the primary ground truth.
Have a second annotator check a subset and report disagreement and adjudication.

Repeat runs to measure variability. Report paired differences per specification,
confidence intervals with resampling by specification, failure rate, cost, and
latency. Cluster repeated runs under their specification instead of treating
them as independent examples. Choose dataset size and a practically useful
improvement target before examining held-out results.

Report first-draft accuracy, final selected accuracy, and unaccepted runs. A
passing internal score can coexist with a human-detected factual error.

## Retrieval and judge evaluation

The six-case fixture is a smoke test, not an accuracy benchmark. Build a larger
reviewed corpus with distractors, paraphrased questions, multi-document answers,
and unanswerable questions. Preserve document IDs and dataset versions. Reference
answers and relevant-document labels must be reviewed independently of candidate
answers; synthetic examples remain proposals until reviewed.

Compare lexical overlap with at least one richer retrieval baseline while holding
the corpus, chunking, questions, and top-k fixed. Report ranking precision,
corpus-normalized recall, and answer quality separately. Sweeping top-k explores
the tradeoff between evidence coverage, distractors, and context/token cost.

The current context-precision denominator counts relevant retrieved chunks.
Consequently, retrieving one relevant chunk can score 1 while missing another;
recall exposes that omission. For unanswerable cases, assess correct abstention
separately instead of interpreting the demo's zero-recall convention as failure.

Compare judge labels and scores against human annotations. Record false approvals,
false rejections, disagreement, and repeated-judgment variability. Faithfulness
measures support from sources, not truth of the sources. The current holistic
faithfulness score should not be described as a claim-by-claim entailment metric.

## SQL policy evaluation

Maintain both adversarial violations and expected-safe controls: set operations,
CTEs, nested queries, schema-qualified references, mutation targets, SELECT INTO,
and restricted words inside harmless literals/comments. Distinguish rejection
because of a policy match from rejection because the parser does not support
the syntax. Report false rejection rates alongside blocked adversarial cases.

Test parser upgrades against regression cases before changing dependency versions.
Use an isolated database with synthetic data only if validating execution
semantics; a parser verdict cannot prove behavior of views or stored functions.

Microbenchmarks should record cold-start and warmed results separately, query
complexity, runtime, hardware, sample counts, and median/p95/maximum latency.
The checked-in benchmark currently measures warmed validation only. It excludes
database execution, API latency, and production concurrency.

## What the present evidence supports

- Offline regression tests demonstrate specified software behavior under tested
  inputs and mocked model replies.
- The fixture demonstrates deterministic lexical ranking on six hand-authored
  cases, with explicit relevance labels.
- SQL microbenchmarks provide local measurements for five queries.
- No measured convergence percentage, hallucination-elimination claim, or
  general prompt-injection immunity follows from these results.

Publish negative and inconclusive results with the same metadata as improvements.
Document protocol deviations so readers can distinguish planned comparisons
from exploratory observations.
