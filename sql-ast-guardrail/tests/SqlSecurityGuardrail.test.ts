import { SqlSecurityGuardrail, SecurityPolicyViolationError } from '../src/securityGuardrail.js';

describe('SqlSecurityGuardrail Comprehensive Policy Verification', () => {
  let guardrail: SqlSecurityGuardrail;

  beforeEach(() => {
    guardrail = new SqlSecurityGuardrail({
      allowedTables: ['vehicles', 'inventory'],
      mutableTables: ['inventory'],
      allowMutations: false,
      maxStatements: 1
    });
  });

  test('PASS: Valid read query on allowed table', () => {
    const result = guardrail.validate('SELECT id, vin FROM vehicles WHERE price > 10000;');
    expect(result.allowed).toBe(true);
    expect(result.statementTypes).toContain('SELECT');
  });

  test('BLOCK: Rejects tautology UPDATE (WHERE 1=1)', () => {
    const guardrailMutations = new SqlSecurityGuardrail({
      allowedTables: ['inventory'],
      mutableTables: ['inventory'],
      allowMutations: true
    });

    const result = guardrailMutations.validate('UPDATE inventory SET quantity = 0 WHERE 1=1;');
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('always-true WHERE clause');
  });

  test('BLOCK: SELECT INTO statement creates table and is forbidden', () => {
    const result = guardrail.validate('SELECT * INTO new_table FROM vehicles;');
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('SELECT INTO is forbidden');
  });

  test('ASSERT: assertValid throws typed SecurityPolicyViolationError', () => {
    expect(() => {
      guardrail.assertValid('DROP TABLE vehicles;');
    }).toThrow(SecurityPolicyViolationError);
  });
});