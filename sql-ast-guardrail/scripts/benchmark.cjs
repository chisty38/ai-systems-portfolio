const { SqlSecurityGuardrail } = require('../dist/SecurityGuardrail.js');
const os = require('node:os');
const guard = new SqlSecurityGuardrail();
const queries = [
  'SELECT Id, Price FROM Vehicles WHERE Price > 15000;',
  'SELECT v.Id FROM Vehicles v JOIN Dealerships d ON v.DealershipId = d.Id;',
  'SELECT Id FROM Vehicles UNION SELECT Id FROM Users;',
  'SELECT * INTO NewTable FROM Vehicles;',
  'SELECT * FROM Vehicles; DROP TABLE Vehicles;'
];
const percentile = (values, p) => values[Math.ceil(values.length * p) - 1];
for (let i = 0; i < 100; i++) for (const q of queries) guard.validate(q);
const results = queries.map(sql => {
  const samples = [];
  for (let i = 0; i < 1000; i++) {
    const start = performance.now();
    guard.validate(sql);
    samples.push(performance.now() - start);
  }
  samples.sort((a, b) => a - b);
  return { sql, allowed: guard.validate(sql).allowed,
    medianMs: +percentile(samples, .5).toFixed(3),
    p95Ms: +percentile(samples, .95).toFixed(3),
    maxMs: +samples.at(-1).toFixed(3) };
});
console.log(JSON.stringify({ node: process.version, platform: process.platform,
  cpu: os.cpus()[0].model, warmupPerQuery: 100, samplesPerQuery: 1000,
  note: 'Local warmed-parser microbenchmark; excludes database execution and model calls. Not a latency guarantee.', results }, null, 2));
