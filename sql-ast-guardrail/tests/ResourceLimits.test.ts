import { SqlSecurityGuardrail } from '../src/SecurityGuardrail';

describe('Resource admission limits', () => {
  test('rejects oversized input before reaching the parser', () => {
    const result = new SqlSecurityGuardrail({ maxSqlLength: 10 }).validate('not valid sql and very long');
    expect(result.violationCode).toBe('RESOURCE_LIMIT');
    expect(result.reason).toContain('maxSqlLength');
  });
  test('rejects excessive AST depth without throwing a recursion error', () => {
    const result = new SqlSecurityGuardrail({ maxAstDepth: 2 }).validate('SELECT Id FROM Vehicles WHERE Id = 42;');
    expect(result.violationCode).toBe('RESOURCE_LIMIT');
    expect(result.reason).toContain('maxAstDepth');
  });
  test('rejects excessive node count', () => {
    const result = new SqlSecurityGuardrail({ maxAstNodes: 2 }).validate('SELECT Id, Price FROM Vehicles;');
    expect(result.violationCode).toBe('RESOURCE_LIMIT');
    expect(result.reason).toContain('maxAstNodes');
  });
  test('accepts a normal query within the default budgets', () => {
    expect(new SqlSecurityGuardrail().validate('SELECT Id FROM Vehicles WHERE Id = 42;').allowed).toBe(true);
  });
  test.each([0, -1, 1.5, Infinity, NaN])('rejects invalid budget %p', maxSqlLength => {
    expect(() => new SqlSecurityGuardrail({ maxSqlLength })).toThrow('maxSqlLength');
  });
  test('rejects a truthy non-boolean mutation flag', () => {
    expect(() => new SqlSecurityGuardrail({ allowMutations: 'false' as unknown as boolean })).toThrow('allowMutations');
  });
});
