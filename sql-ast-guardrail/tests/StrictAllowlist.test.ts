import { SqlSecurityGuardrail, SecurityPolicyViolationError } from '../src/SqlSecurityGuardrail.js';
import { SqlSecurityGuardrail as ResultGuardrail } from '../src/SecurityGuardrail.js';

describe('Strict API integration regressions', () => {
  const guard = new SqlSecurityGuardrail(['vehicles', 'inventory']);
  test.each([
    'UPDATE vehicles SET price = 0 WHERE id = 1;',
    'SELECT * FROM users;',
    'SELECT * FROM vehicles; DROP TABLE inventory;',
    'SELECT * FROM vehicles UNION SELECT * FROM auditlogs;',
    'SELECT * FROM (SELECT * FROM auditlogs) x;',
    'SELECT * INTO inventory FROM vehicles;',
    'SELECT * FROM sys.objects;',
    'SELECT * FROM vehicles WHERE id IN (SELECT id FROM auditlogs);',
    'WITH x AS (SELECT * FROM auditlogs) SELECT * FROM x;',
    'WITH auditlogs AS (SELECT * FROM auditlogs) SELECT * FROM auditlogs;',
    'not valid sql', '', ';', '-- only a comment'
  ])('throws typed rejection for %s', sql => {
    expect(() => guard.validate(sql)).toThrow(SecurityPolicyViolationError);
  });
  test('permits allowed reads', () => {
    expect(guard.validate('SELECT id FROM vehicles;').allowed).toBe(true);
  });
  test('keeps query and structured rejection details', () => {
    try {
      guard.validate('UPDATE vehicles SET price = 0 WHERE id = 1;');
      throw new Error('Expected rejection');
    } catch (error) {
      expect(error).toBeInstanceOf(SecurityPolicyViolationError);
      const violation = error as SecurityPolicyViolationError;
      expect(violation.nodeType).toBe('UPDATE');
      expect(violation.query).toContain('UPDATE');
      expect(violation.result?.violationCode).toBe('STATEMENT_TYPE');
    }
  });
  test('accepts a safe chain of CTE aliases', () => {
    expect(guard.validate('WITH x AS (SELECT id FROM vehicles), y AS (SELECT id FROM x) SELECT * FROM y;').allowed).toBe(true);
  });
  test('a local alias does not authorize a qualified physical table', () => {
    expect(() => guard.validate('WITH x AS (SELECT id FROM vehicles) SELECT * FROM dbo.x;')).toThrow(SecurityPolicyViolationError);
  });
  test('nested aliases do not authorize siblings', () => {
    expect(() => guard.validate('SELECT * FROM (WITH x AS (SELECT id FROM vehicles) SELECT * FROM x) v UNION SELECT * FROM x;'))
      .toThrow(SecurityPolicyViolationError);
  });
  test('qualified configuration restricts schemas', () => {
    const qualified = new SqlSecurityGuardrail(['dbo.vehicles']);
    expect(qualified.validate('SELECT * FROM dbo.vehicles;').allowed).toBe(true);
    expect(() => qualified.validate('SELECT * FROM other.vehicles;')).toThrow(SecurityPolicyViolationError);
    expect(() => qualified.validate('SELECT * FROM vehicles;')).toThrow(SecurityPolicyViolationError);
  });
  test('deny rules override allow rules', () => {
    expect(() => new SqlSecurityGuardrail(['users']).validate('SELECT * FROM users;')).toThrow(SecurityPolicyViolationError);
  });
  test('empty allowlist only permits table-free reads', () => {
    const empty = new SqlSecurityGuardrail([]);
    expect(empty.validate('SELECT 1;').allowed).toBe(true);
    expect(() => empty.validate('SELECT * FROM vehicles;')).toThrow(SecurityPolicyViolationError);
  });
  test('normalizes configuration whitespace and case', () => {
    expect(new SqlSecurityGuardrail([' Vehicles ']).validate('SELECT * FROM VEHICLES;').allowed).toBe(true);
  });
  test('both APIs apply the same rejection policy', () => {
    const legacy = new ResultGuardrail({ allowedTables: ['vehicles'] });
    expect(legacy.validate('SELECT * FROM auditlogs;').allowed).toBe(false);
    expect(() => legacy.assertValid('SELECT * FROM auditlogs;')).toThrow(SecurityPolicyViolationError);
  });
  test('writes must satisfy access and mutation policies', () => {
    const legacy = new ResultGuardrail({ allowMutations: true, allowedTables: ['vehicles'], mutableTables: ['auditlogs'] });
    expect(legacy.validate('DELETE FROM auditlogs WHERE id = 1;').allowed).toBe(false);
  });
  test('rejects invalid table configuration', () => {
    expect(() => new ResultGuardrail({ allowedTables: [''] })).toThrow('allowedTables');
  });
});
