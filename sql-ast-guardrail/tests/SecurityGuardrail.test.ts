import { SqlSecurityGuardrail } from '../src/SecurityGuardrail';

describe('SqlSecurityGuardrail Unit & Adversarial Tests', () => {
  let guardrail: SqlSecurityGuardrail;

  beforeAll(() => {
    // Warm up the parser JIT engine
    const warmup = new SqlSecurityGuardrail();
    warmup.validate('SELECT 1;');
  });

  beforeEach(() => {
    guardrail = new SqlSecurityGuardrail({
      allowMutations: false,
      maxStatements: 1,
      blockedTables: ['sys', 'credentials', 'users']
    });
  });

  test('ALLOWS: Standard SELECT query with WHERE clause', () => {
    const sql = "SELECT Id, VehicleMake, Model, Price FROM Vehicles WHERE Price > 15000;";
    const result = guardrail.validate(sql);

    expect(result.allowed).toBe(true);
    expect(result.reason).toBeUndefined();
    expect(result.executionTimeMs).toBeLessThan(5);
  });

  test('ALLOWS: Multi-table JOIN read query', () => {
    const sql = `
      SELECT v.VIN, v.VehicleMake, d.DealershipName 
      FROM Vehicles v 
      INNER JOIN Dealerships d ON v.DealershipId = d.Id 
      WHERE v.Status = 'Active';
    `;
    const result = guardrail.validate(sql);

    expect(result.allowed).toBe(true);
  });

  test('BLOCKS: Destructive DROP TABLE statement', () => {
    const sql = "DROP TABLE Vehicles;";
    const result = guardrail.validate(sql);

    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("Unpermitted statement type 'DROP'");
  });

  test('BLOCKS: Stacked Multi-Statement Injection Attempt', () => {
    const sql = "SELECT * FROM Vehicles; DROP TABLE Vehicles;";
    const result = guardrail.validate(sql);

    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("Multi-statement execution attempt detected");
  });

  test('BLOCKS: Destructive TRUNCATE statement', () => {
    const sql = "TRUNCATE TABLE AuditLogs;";
    const result = guardrail.validate(sql);

    expect(result.allowed).toBe(false);
  });

  test('BLOCKS: Access to restricted sensitive table (Users)', () => {
    const sql = "SELECT Id, PasswordHash FROM Users WHERE Id = 1;";
    const result = guardrail.validate(sql);

    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("Access to restricted table 'Users' is forbidden");
  });

  test('BLOCKS: T-SQL System Stored Procedure Execution (xp_cmdshell)', () => {
    const sql = "EXEC xp_cmdshell 'dir';";
    const result = guardrail.validate(sql);

    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("Blocked reference to restricted system pattern");
  });

  test('BLOCKS: Naked DELETE statement without WHERE clause (Mutations enabled mode)', () => {
    const permissiveGuardrail = new SqlSecurityGuardrail({ allowMutations: true, mutableTables: ['Vehicles'] });
    const sql = "DELETE FROM Vehicles;";
    const result = permissiveGuardrail.validate(sql);

    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("Naked DELETE statement without a WHERE clause is explicitly forbidden");
  });

  test('ALLOWS: Valid DELETE with explicit WHERE clause (Mutations enabled mode)', () => {
    const permissiveGuardrail = new SqlSecurityGuardrail({ allowMutations: true, blockedTables: [], mutableTables: ['Vehicles'] });
    const sql = "DELETE FROM Vehicles WHERE Id = 101;";
    const result = permissiveGuardrail.validate(sql);

    expect(result.allowed).toBe(true);
  });
});