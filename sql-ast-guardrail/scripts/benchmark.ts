import { cpus } from 'node:os';
import { performance } from 'node:perf_hooks';
import { SqlSecurityGuardrail } from '../src/SqlSecurityGuardrail.js';

/**
 * Single-query warmed microbenchmark of the throwing allowlist entry point.
 * mean = elapsed / iterations; throughput = iterations * 1000 / elapsedMs.
 * These are local observations, not SLA bounds or concurrent DB throughput.
 * The existing benchmark.cjs covers multiple allowed and rejected queries.
 */
function runBenchmark(): void {
  const guardrail = new SqlSecurityGuardrail(['vehicles', 'inventory']);
  const sampleQuery = 'SELECT id, vin, price, year FROM vehicles WHERE price < 50000 AND year >= 2022;';
  const iterations = 5000;
  const coldStart = performance.now();
  guardrail.validate(sampleQuery);
  const firstValidationMs = performance.now() - coldStart;
  for (let i = 0; i < 100; i++) guardrail.validate(sampleQuery);

  const start = performance.now();
  for (let i = 0; i < iterations; i++) guardrail.validate(sampleQuery);
  const totalMs = performance.now() - start;

  // Separately timed calls describe the tail, but include per-call timer cost.
  const samples: number[] = [];
  for (let i = 0; i < iterations; i++) {
    const before = performance.now();
    guardrail.validate(sampleQuery);
    samples.push(performance.now() - before);
  }
  samples.sort((a, b) => a - b);
  const round = (value: number) => +value.toFixed(4);
  console.log(JSON.stringify({
    node: process.version, platform: process.platform, cpu: cpus()[0]?.model,
    policy: 'read-only access allowlist', sampleQuery, iterations,
    warmupIterations: 100, firstValidationMs: round(firstValidationMs),
    batchTotalMs: round(totalMs), averageLatencyMs: round(totalMs / iterations),
    operationsPerSecond: Math.round(iterations * 1000 / totalMs),
    sampledMedianMs: round(samples[Math.ceil(iterations * .5) - 1]),
    sampledP95Ms: round(samples[Math.ceil(iterations * .95) - 1]),
    sampledMaxMs: round(samples[iterations - 1]),
    note: 'First validation excludes imports/construction. Warmed serial measurements exclude DB/API execution. No latency guarantee.'
  }, null, 2));
}

runBenchmark();
