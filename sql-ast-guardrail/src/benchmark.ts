import { SqlSecurityGuardrail } from './SecurityGuardrail.js';

function runBenchmark() {
  const guardrail = new SqlSecurityGuardrail({
    allowedTables: ['vehicles', 'inventory'],
    allowMutations: false,
    maxStatements: 1
  });

  const validQuery = 'SELECT id, vin, price, year FROM vehicles WHERE price < 50000 AND year >= 2022;';
  // Read-only mode rejects UPDATE before predicate analysis. This measures
  // statement-type rejection, not the cost of proving a predicate tautological.
  const blockedQuery = 'UPDATE vehicles SET price = 0 WHERE 1=1;';
  const iterations = 10000;

  console.log('\n==================================================');
  console.log('⚡ RUNNING AST SECURITY GUARDRAIL BENCHMARK');
  console.log('==================================================');
  console.log(`Target Iterations: ${iterations.toLocaleString()}`);
  console.log(`Sample Valid Query: "${validQuery}"\n`);

  // Warmup pass
  for (let i = 0; i < 500; i++) {
    guardrail.validate(validQuery);
  }

  // 1. Benchmark Valid Select Query Latency
  const startValid = performance.now();
  for (let i = 0; i < iterations; i++) {
    guardrail.validate(validQuery);
  }
  const totalValidMs = performance.now() - startValid;
  const avgValidLatencyMs = totalValidMs / iterations;
  const validOpsPerSec = Math.round((iterations / totalValidMs) * 1000);

  // 2. Benchmark Tautology & Policy Rejection Latency
  const startBlocked = performance.now();
  for (let i = 0; i < iterations; i++) {
    guardrail.validate(blockedQuery);
  }
  const totalBlockedMs = performance.now() - startBlocked;
  const avgBlockedLatencyMs = totalBlockedMs / iterations;

  console.log(`--- [VALID SELECT PERFORMANCE] ---`);
  console.log(`Total Time Elapsed:     ${totalValidMs.toFixed(2)} ms`);
  console.log(`Average Query Latency: ${avgValidLatencyMs.toFixed(4)} ms / query`);
  console.log(`Throughput Rate:       ${validOpsPerSec.toLocaleString()} ops/sec\n`);

  console.log(`--- [POLICY REJECTION PERFORMANCE] ---`);
  console.log(`Average Rejection Latency: ${avgBlockedLatencyMs.toFixed(4)} ms / query`);
  console.log('==================================================\n');
}

runBenchmark();
