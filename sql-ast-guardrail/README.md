# Deterministic T-SQL Security Guardrail

Pre-execution Abstract Syntax Tree (AST) query analysis engine built in TypeScript to enforce read-only semantics and prevent SQL injection/tautology attacks before reaching the database driver.

## Quick Start
```bash
npm install
npm test                      # Run policy test suite
npx tsx scripts/benchmark.ts  # Run latency benchmark (<0.2ms/query)


### The Architecture
LLMs cannot be trusted to generate raw database queries safely; prompt injection can trick a model into outputting destructive SQL commands (`DROP TABLE`, `TRUNCATE`, or stacked calls like `; EXEC xp_cmdshell`). Rather than relying on non-deterministic LLM output filtering, this project parses raw T-SQL queries into an **Abstract Syntax Tree (AST)** and evaluates statement nodes against strict security rules before the query reaches the database driver.

### Key Capabilities
* **Sub-2ms Execution:** Inspects queries deterministically in under 2ms with zero model API overhead.
* **Mutative Query Isolation:** Enforces read-only mode, blocking `INSERT`, `UPDATE`, `DELETE`, `DROP`, and `ALTER` statements.
* **Naked Mutation Guard:** Blocks `UPDATE` or `DELETE` statements that lack an explicit `WHERE` clause.
* **Multi-Statement Defense:** Prevents stacked query injection attempts separated by semicolons.
* **Sensitive Table Blacklisting:** Recursively blocks queries attempting to touch sensitive tables (e.g., `Users`, `Credentials`, `sys`).

### Test
```bash
# Executing Jest Unit & Adversarial Test Suite
npm test
```