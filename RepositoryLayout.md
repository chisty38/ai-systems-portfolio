.
├── project-1-ast-guardrail/       # TypeScript / Node.js
│   ├── src/
│   │   └── securityGuardrail.ts   # Core AST parser and policy engine
│   ├── tests/
│   │   └── securityGuardrail.test.ts
│   ├── scripts/
│   │   └── benchmark.ts           # Sub-ms latency benchmark script
│   └── tsconfig.json
│
├── project-2-dual-agent-loop/     # TypeScript / Node.js
│   ├── src/
│   │   ├── DualAgentPipeline.ts   # Minimax loop orchestrator
│   │   └── types.ts               # Domain interface boundaries
│   ├── tests/
│   │   └── DualAgentPipeline.test.ts
│   ├── scripts/
│   │   └── benchmark.ts           # Convergence audit script
│   └── tsconfig.json
│
└── project-3-rag-eval-engine/     # Python
    ├── eval_harness.py            # LLM-as-a-Judge evaluation engine
    ├── synth_generator.py         # Synthetic benchmark generator
    ├── requirements.txt           # Python dependencies
    └── reports/                   # Output evaluation reports