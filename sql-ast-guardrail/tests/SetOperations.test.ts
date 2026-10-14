import { SqlSecurityGuardrail } from '../src/SecurityGuardrail';

describe('Set operations and SELECT INTO', () => {
  const guard = new SqlSecurityGuardrail();
  test.each([
    'SELECT Id FROM Vehicles UNION SELECT Id FROM Users;',
    'SELECT Id FROM Vehicles UNION ALL SELECT Id FROM Credentials;',
    'SELECT Id FROM Vehicles UNION SELECT Id FROM Dealerships UNION SELECT Id FROM Users;',
    'SELECT Id FROM Vehicles UNION SELECT object_id FROM sys.objects;',
    'SELECT * FROM (SELECT Id FROM Vehicles UNION SELECT Id FROM Users) x;'
  ])('rejects restricted access in every branch: %s', sql => {
    expect(guard.validate(sql).allowed).toBe(false);
  });
  test('allows a union of permitted tables', () => {
    expect(guard.validate('SELECT Id FROM Vehicles UNION ALL SELECT Id FROM Dealerships;').allowed).toBe(true);
  });
  test.each([false, true])('blocks SELECT INTO with allowMutations=%p', allowMutations => {
    const g = new SqlSecurityGuardrail({ allowMutations, mutableTables: ['Vehicles', 'NewTable'] });
    expect(g.validate('SELECT * INTO NewTable FROM Vehicles;').reason).toContain('SELECT INTO');
  });
  test('blocks SELECT INTO in a later union branch', () => {
    expect(guard.validate('SELECT Id FROM Vehicles UNION SELECT Id INTO NewTable FROM Vehicles;').allowed).toBe(false);
  });
  test.each([0, -1, NaN, Infinity, 1.5])('rejects invalid statement limit %p', maxStatements => {
    expect(() => new SqlSecurityGuardrail({ maxStatements })).toThrow('maxStatements');
  });
});
