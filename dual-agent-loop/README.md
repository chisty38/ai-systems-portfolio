#  Dual-Agent Minimax Loop

An agentic orchestration loop pairing a Generator Agent with a Discriminator Agent in a feedback backpropagation loop to eliminate single-pass hallucinations.

## Quick Start
```bash
npm install
echo "GEMINI_API_KEY=your_key_here" > .env
npm test                      # Run unit tests with mocked API calls
npx tsx src/index.ts          # Run live execution driver

### The Architecture
Single-prompt LLM generation suffers from confirmation bias and feature hallucinations. This architecture implements a **Minimax Generator-Discriminator Pipeline**:
1. **Generator Agent:** Converts input specifications into tailored Facebook ad copy.
2. **Discriminator Agent:** Functions as an unyielding compliance auditor evaluating the candidate copy against the source specs using a strict scoring rubric (0.00 to 1.00).
3. **Feedback Backpropagation:** If the audit score falls below `0.90`, the Discriminator's structured issues and suggestions are injected back into the Generator's context window to force an updated iteration for up to 3 attempts.

```
       ┌────────────────────────┐
       │   Input Specs Payload  │
       └───────────┬────────────┘
                   │
                   ▼
       ┌────────────────────────┐
       │     Generator Agent    │ ◄────────────────────────┐
       └───────────┬────────────┘                          │
                   │ Candidate Copy                        │ Structured
                   ▼                                       │ Feedback Loop
       ┌────────────────────────┐                          │ (Score < 0.90)
       │  Discriminator Agent   │                          │
       └───────────┬────────────┘                          │
                   │ Audit Score & Critique                │
                   ▼                                       │
         [ Score >= 0.90 ? ] ─── NO ───────────────────────┘
                   │
                  YES
                   │
                   ▼
       ┌────────────────────────┐
       │ Final Audited Output   │
       └────────────────────────┘
```

### Test & Execution Log
```bash
npm test

 PASS  tests/DualAgentPipeline.test.ts
  DualAgentPipeline Unit Tests (Mocked @google/genai)
    ✓ FAIL: Throws error if GEMINI_API_KEY environment variable is missing (1 ms)
    ✓ SUCCESS: Converges on Attempt #1 when Discriminator score meets threshold (2 ms)
    ✓ RETRY & RECOVER: Retries on rejected draft and converges on Attempt #2 (3 ms)
    ✓ MAX ATTEMPTS EXHAUSTION: Terminates at maxAttempts if score never passes (2 ms)

Test Suites: 1 passed, 1 total
Tests:       4 passed, 4 total
Time:        0.589 s
```