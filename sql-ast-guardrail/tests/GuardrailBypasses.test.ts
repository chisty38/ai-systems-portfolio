import { SqlSecurityGuardrail } from '../src/SecurityGuardrail';

/**
 * ===========================================================================
 *  ADVERSARIAL BYPASS REGRESSION SUITE
 * ===========================================================================
 *  Each test below feeds the guardrail a payload that USED TO DEFEAT it and
 *  perform exactly the action the guardrail was built to prohibit.
 *
 *  SecurityGuardrail.ts has since been hardened, so every payload must now be
 *  rejected. The `WHY` block on each test explains the original flaw and the
 *  `FIX` block explains what closed it. A failure here means a regression has
 *  reopened the bypass.
 * ===========================================================================
 */
describe('SqlSecurityGuardrail — Known Bypasses (regression guards)', () => {
  let readOnly: SqlSecurityGuardrail;    // allowMutations = false
  let mutations: SqlSecurityGuardrail;   // allowMutations = true, only Vehicles writable

  beforeEach(() => {
    readOnly = new SqlSecurityGuardrail({
      allowMutations: false,
      maxStatements: 1,
      blockedTables: ['sys', 'credentials', 'users']
    });
    mutations = new SqlSecurityGuardrail({
      allowMutations: true,
      maxStatements: 1,
      blockedTables: ['sys', 'credentials', 'users'],
      mutableTables: ['Vehicles']
    });
  });

  /**
   * BYPASS 1 — Schema-qualified system catalog read.
   *
   * WHY:
   *   The config denylists the 'sys' schema, but extractTableNames() only read
   *   fromItem.table (the bare name, e.g. "databases") and ignored fromItem.db
   *   ("sys"). The denylist entry 'sys' therefore only matched a table literally
   *   NAMED sys — never the sys.* schema.
   *
   * FIX:
   *   Table references now carry their db/schema qualifiers. A reference is
   *   blocked if its table, any qualifier, or its qualified name is denylisted,
   *   and the sys / INFORMATION_SCHEMA schemas are always blocked.
   */
  describe('Bypass 1: sys catalog read despite "sys" on the denylist', () => {
    const payloads = [
      'SELECT * FROM sys.databases;',
      'SELECT * FROM sys.objects;',
      'SELECT name, type_desc FROM sys.server_principals;',
      'SELECT * FROM master.sys.databases;',
      'SELECT v.Id FROM Vehicles v JOIN sys.objects o ON o.name = v.Model;'
    ];

    test.each(payloads)('blocks catalog read via: %s', (sql) => {
      const result = readOnly.validate(sql);
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("system schema 'sys'");
    });
  });

  /**
   * BYPASS 2 — Always-true predicate defeats the "naked mutation" guard.
   *
   * WHY:
   *   The guard only checked whether node.where EXISTED, not whether it filters.
   *   `WHERE 1=1` (or 'a'='a') is true for every row, so it satisfied the check
   *   while matching the entire table — a full wipe disguised as a scoped change.
   *
   * FIX:
   *   The WHERE clause of UPDATE/DELETE is analysed: constant predicates,
   *   self-comparisons (Id = Id), LIKE '%', and tautological OR branches are
   *   treated as "no filter" and rejected.
   */
  describe('Bypass 2: WHERE 1=1 mass-mutation', () => {
    test('DELETE with WHERE 1=1 is blocked', () => {
      const result = mutations.validate('DELETE FROM Vehicles WHERE 1=1;');
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('always-true WHERE clause');
    });

    test("UPDATE with WHERE 'a'='a' is blocked", () => {
      const result = mutations.validate("UPDATE Vehicles SET Price = 0 WHERE 'a' = 'a';");
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('always-true WHERE clause');
    });

    test.each([
      'DELETE FROM Vehicles WHERE Id = 5 OR 1 = 1;',
      'UPDATE Vehicles SET Price = 0 WHERE Id = Id;',
      "DELETE FROM Vehicles WHERE Model LIKE '%';"
    ])('blocks disguised tautology: %s', (sql) => {
      const result = mutations.validate(sql);
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('always-true WHERE clause');
    });

    test('still ALLOWS a genuinely scoped mutation', () => {
      const result = mutations.validate('UPDATE Vehicles SET Price = 0 WHERE Id = 42 AND 1 = 1;');
      expect(result.allowed).toBe(true);
    });
  });

  /**
   * BYPASS 3 — Sensitive table missing from the denylist (fail-open design).
   *
   * WHY:
   *   A denylist permits everything it does not explicitly name. AuditLogs was
   *   never listed, so a mutation against it was neither a naked DELETE nor a
   *   blocked-table hit. The evidence trail could be erased.
   *
   * FIX:
   *   Writes are now fail-closed: every table a non-SELECT statement targets must
   *   appear in the `mutableTables` allowlist. Anything not explicitly permitted —
   *   including tables nobody remembered to protect — is rejected.
   */
  describe('Bypass 3: AuditLogs wiped because the denylist is incomplete', () => {
    test('DELETE FROM AuditLogs WHERE 1=1 is blocked', () => {
      const result = mutations.validate('DELETE FROM AuditLogs WHERE 1=1;');
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("'AuditLogs' is not in the mutation allowlist");
    });

    // Non-tautological WHERE, so only the allowlist can stop these
    test.each([
      'DELETE FROM AuditLogs WHERE Id = 5;',
      "UPDATE AuditLogs SET Action = 'none' WHERE Id = 5;",
      "INSERT INTO AuditLogs (Action) VALUES ('forged');",
      'TRUNCATE TABLE AuditLogs;',
      'DROP TABLE dbo.AuditLogs;'
    ])('blocks write to non-allowlisted table: %s', (sql) => {
      const result = mutations.validate(sql);
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('not in the mutation allowlist');
    });

    test('rejects all writes when no mutableTables are configured', () => {
      const noAllowlist = new SqlSecurityGuardrail({ allowMutations: true });
      const result = noAllowlist.validate('DELETE FROM Vehicles WHERE Id = 5;');
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('not in the mutation allowlist');
    });
  });
});
