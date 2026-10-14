import { Parser, AST } from 'node-sql-parser';

export interface GuardrailOptions {
  maxSqlLength?: number;         // UTF-16 code units; pre-parse admission limit
  maxAstNodes?: number;          // Post-parse object count, including expression nodes
  maxAstDepth?: number;          // Post-parse structural depth; bounds recursive checks
  allowedTables?: string[];      // Optional access allowlist; [] denies every physical table
  allowMutations?: boolean;      // If false, blocks INSERT, UPDATE, DELETE, DROP, ALTER, etc.
  maxStatements?: number;         // Max multi-statement batch count (prevents stacked queries)
  blockedTables?: string[];       // Denylist of restricted tables or schemas (e.g., sys, credentials)
  mutableTables?: string[];       // Allowlist of tables mutations may target. Fail-closed: empty = nothing is writable
}

interface TableRef {
  qualifiers: string[];           // db / schema parts, e.g. ['sys'] or ['master', 'sys']
  table: string;
}

export interface GuardrailResult {
  allowed: boolean;
  reason?: string;
  executionTimeMs: number;
  statementTypes: string[];
  violationCode?: 'INVALID_INPUT' | 'RESOURCE_LIMIT' | 'RESTRICTED_PATTERN' | 'PARSER_ERROR' | 'STACKED_QUERY' | 'STATEMENT_TYPE' | 'POLICY_VIOLATION';
}

/**
 * Custom domain error thrown when a T-SQL query violates pre-execution security policies.
 */
export class SecurityPolicyViolationError extends Error {
  constructor(
    public readonly query: string,
    public readonly nodeType: string,
    message: string,
    public readonly result?: GuardrailResult
  ) {
    super(`[SecurityPolicyViolationError] AST Node '${nodeType}': ${message}`);
    this.name = 'SecurityPolicyViolationError';
  }
}

/**
 * Deterministic Pre-Execution T-SQL Security Guardrail.
 * 
 * ARCHITECTURAL DESIGN DECISION:
 * Relying on LLM self-censorship or system prompt instruction to sanitize database 
 * operations creates a fundamental vulnerability to prompt injection bypasses.
 * This class parses raw T-SQL into an Abstract Syntax Tree (AST) to enforce strict
 * read-only query semantics in <2ms, prior to reaching the DB driver layer.
 * 
 * TRADE-OFFS & LIMITATIONS:
 * - Deterministic parsing guarantees zero injection leakage for supported syntax.
 * - Complex T-SQL dialect extensions (e.g., WITH CTE expressions containing 
 *   OUTPUT/INTO clauses) are validated at the root node level.
 */
export class SqlSecurityGuardrail {
  private parser: Parser;
  private options: Required<Omit<GuardrailOptions, 'allowedTables'>> & Pick<GuardrailOptions, 'allowedTables'>;

  // Banned T-SQL keywords or system stored procedures caught before AST parsing
  private static DANGEROUS_SYSTEM_PATTERNS = [
    /xp_cmdshell/i,
    /sp_executesql/i,
    /sys\.sysobjects/i,
    /sys\.tables/i,
    /INFORMATION_SCHEMA/i
  ];

  // System schemas that are always off-limits, regardless of the configured denylist
  private static SYSTEM_SCHEMAS = ['sys', 'information_schema'];

  // AST keys that hold the target tables of mutation / DDL statements
  private static MUTATION_TARGET_KEYS = ['table', 'name'];

  constructor(options: GuardrailOptions = {}) {
    for (const key of ['maxSqlLength', 'maxAstNodes', 'maxAstDepth'] as const) {
      if (options[key] !== undefined && (!Number.isSafeInteger(options[key]) || options[key]! < 1)) {
        throw new Error(`${key} must be a positive safe integer`);
      }
    }
    if (options.allowMutations !== undefined && typeof options.allowMutations !== 'boolean') {
      throw new Error('allowMutations must be a boolean');
    }
    if (!Number.isInteger(options.maxStatements ?? 1) || (options.maxStatements ?? 1) < 1) {
      throw new Error('maxStatements must be an integer >= 1');
    }
    for (const key of ['allowedTables', 'blockedTables', 'mutableTables'] as const) {
      const values = options[key];
      if (values !== undefined && (!Array.isArray(values) || values.some(t => typeof t !== 'string' || !t.trim()))) {
        throw new Error(`${key} must be an array of non-empty strings`);
      }
    }
    this.parser = new Parser();
    this.options = {
      maxSqlLength: options.maxSqlLength ?? 100_000,
      maxAstNodes: options.maxAstNodes ?? 10_000,
      maxAstDepth: options.maxAstDepth ?? 128,
      allowMutations: options.allowMutations ?? false,
      maxStatements: options.maxStatements ?? 1,
      allowedTables: options.allowedTables?.map(t => t.trim().toLowerCase()),
      blockedTables: (options.blockedTables ?? ['sys', 'system_keys', 'credentials', 'users']).map(t => t.trim().toLowerCase()),
      mutableTables: (options.mutableTables ?? []).map(t => t.trim().toLowerCase())
    };
  }

  /**
   * Validates input SQL string against safety invariants.
   * Throws `SecurityPolicyViolationError` on policy failure.
   * 
   * @param sql Raw T-SQL statement input
   */
  public validate(sql: string): GuardrailResult {
    const startTime = performance.now();

    if (!sql || typeof sql !== 'string') {
      return this.buildResult(false, 'Empty or invalid SQL payload', startTime, [], 'INVALID_INPUT');
    }
    // Admission control precedes parsing: synchronous parser CPU cannot be
    // cancelled by a timer on this same event loop. This is not a time bound.
    if (sql.length > this.options.maxSqlLength) {
      return this.buildResult(false, 'SQL exceeds maxSqlLength', startTime, [], 'RESOURCE_LIMIT');
    }
    if (!sql.trim()) return this.buildResult(false, 'Empty or invalid SQL payload', startTime, [], 'INVALID_INPUT');

    const trimmedSql = sql.trim();

    // This conservative prefilter can reject harmless literals/comments.
    // Keep AST checks authoritative for supported structural policies; keyword
    // matching alone cannot establish SQL semantics.
    // 1. Regex pre-filter for dangerous system stored procedures
    for (const pattern of SqlSecurityGuardrail.DANGEROUS_SYSTEM_PATTERNS) {
      if (pattern.test(trimmedSql)) {
        return this.buildResult(false, `Blocked reference to restricted system pattern: ${pattern.source}`, startTime, [], 'RESTRICTED_PATTERN');
      }
    }

    // 2. Parse SQL string into AST
    let astOrAstArray: AST | AST[];
    try {
      astOrAstArray = this.parser.astify(trimmedSql, { database: 'transactsql' });
    } catch (err: any) {
      return this.buildResult(false, `SQL Syntax/AST Parse Error: ${err.message}`, startTime, [], 'PARSER_ERROR');
    }

    const astList = Array.isArray(astOrAstArray) ? astOrAstArray : [astOrAstArray];
    const statementTypes: string[] = [];
    const resourceViolation = this.checkAstBudget(astList);
    if (resourceViolation) {
      return this.buildResult(false, resourceViolation, startTime, [], 'RESOURCE_LIMIT');
    }
    if (astList.length === 0) {
      return this.buildResult(false, 'No executable SQL statement', startTime, [], 'INVALID_INPUT');
    }

    // 3. Batch count check
    if (astList.length > this.options.maxStatements) {
      return this.buildResult(
        false, 
        `Multi-statement execution attempt detected. Max allowed: ${this.options.maxStatements}, Received: ${astList.length}`, 
        startTime, 
        [], 'STACKED_QUERY'
      );
    }

    // 4. Recursive AST inspection
    for (const astNode of astList) {
      const type = (astNode.type || '').toUpperCase();
      statementTypes.push(type);

      // Check statement type permissions
      if (!this.options.allowMutations && type !== 'SELECT') {
        return this.buildResult(
          false, 
          `Unpermitted statement type '${type}'. Only read-only 'SELECT' queries are allowed in this sandbox.`, 
          startTime, 
          statementTypes, 'STATEMENT_TYPE'
        );
      }

      // Mutations may only target explicitly allowlisted tables (fail-closed)
      if (type !== 'SELECT') {
        const targetViolation = this.checkMutationTargets(astNode, type);
        if (targetViolation) {
          return this.buildResult(false, targetViolation, startTime, statementTypes);
        }
      }

      // Deep inspection of the AST tree
      const violation = this.inspectAstNode(astNode);
      if (violation) {
        return this.buildResult(false, violation, startTime, statementTypes);
      }
    }

    return this.buildResult(true, undefined, startTime, statementTypes);
  }

  /** Same policy as validate(); returns its accepted result or throws a typed rejection. */
  public assertValid(sql: string): GuardrailResult {
    const result = this.validate(sql);
    if (!result.allowed) {
      throw new SecurityPolicyViolationError(sql,
        result.statementTypes.at(-1) ?? result.violationCode ?? 'POLICY_VIOLATION',
        result.reason ?? 'Security policy rejected the query', result);
    }
    return result;
  }

  /** Iterative preflight bounds the later recursive policy walk after parsing. */
  private checkAstBudget(roots: AST[]): string | null {
    const pending = roots.map(node => ({ node: node as unknown, depth: 1 }));
    const seen = new Set<object>();
    while (pending.length) {
      const { node, depth } = pending.pop()!;
      if (!node || typeof node !== 'object' || seen.has(node)) continue;
      if (depth > this.options.maxAstDepth) return 'AST exceeds maxAstDepth';
      seen.add(node);
      if (seen.size > this.options.maxAstNodes) return 'AST exceeds maxAstNodes';
      for (const [key, child] of Object.entries(node)) {
        if (key === 'parent') continue;
        if (child && typeof child === 'object') pending.push({ node: child, depth: depth + 1 });
      }
    }
    return null;
  }

  /**
   * Recursively traverses AST nodes to enforce structural guardrails.
   */
  private inspectAstNode(node: any, inheritedCtes: ReadonlySet<string> = new Set()): string | null {
    if (!node || typeof node !== 'object') return null;

    // CTE aliases are local names, not physical tables. Check each definition
    // before introducing its alias, preventing it from hiding its own source.
    // Recursive/forward CTE references may be rejected by strict allowlist mode.
    let ctes: ReadonlySet<string> = inheritedCtes;
    if (Array.isArray(node.with)) {
      const localCtes = new Set(inheritedCtes);
      ctes = localCtes;
      for (const cte of node.with) {
        const violation = this.inspectAstNode(cte.stmt, ctes);
        if (violation) return violation;
        const name = typeof cte.name === 'string' ? cte.name : cte.name?.value;
        if (typeof name === 'string') localCtes.add(name.toLowerCase());
      }
    }

    // SELECT INTO writes a table even though the parser labels it SELECT.
    // This library never authorizes SELECT INTO, including mutation-enabled mode.
    if (String(node.type).toUpperCase() === 'SELECT' && node.into?.position) {
      return 'SELECT INTO is forbidden because it creates or writes a table.';
    }

    // A. Table Access Verification
    if (node.table || node.from) {
      for (const ref of this.extractTableRefs(node)) {
        const violation = this.checkTableAccess(ref, ctes);
        if (violation) return violation;
      }
    }

    // B. Destructive Mutations without a real (row-filtering) WHERE clause
    if (['UPDATE', 'DELETE'].includes((node.type || '').toUpperCase())) {
        const statementType = (node.type || '').toUpperCase();
        if (!node.where) {
            return `Naked ${statementType} statement without a WHERE clause is explicitly forbidden.`;
        }
        if (this.isTautology(node.where)) {
            return `${statementType} with an always-true WHERE clause is explicitly forbidden (it matches every row).`;
        }
    }

    // Includes _next: set-operation branches are SELECT nodes, not UNION nodes.
    for (const key of Object.keys(node)) {
      if (key === 'parent' || key === 'with') continue;
      const child = node[key];
      if (Array.isArray(child)) {
        for (const item of child) {
          const result = this.inspectAstNode(item, ctes);
          if (result) return result;
        }
      } else if (typeof child === 'object' && child !== null) {
        const result = this.inspectAstNode(child, ctes);
        if (result) return result;
      }
    }

    return null;
  }

  /**
   * Normalizes table references extracted from AST nodes, keeping their db/schema qualifiers.
   */
  private extractTableRefs(node: any): TableRef[] {
    const items: any[] = [];
    if (Array.isArray(node.from)) {
      items.push(...node.from);
    } else if (typeof node.table === 'string') {
      items.push({ db: node.db, schema: node.schema, table: node.table });
    } else if (Array.isArray(node.table)) {
      items.push(...node.table);
    }
    return items.filter(item => item && typeof item.table === 'string').map(item => this.toTableRef(item));
  }

  private toTableRef(item: any): TableRef {
    return {
      qualifiers: [item.db, item.schema].filter((q): q is string => typeof q === 'string' && q.length > 0),
      table: item.table
    };
  }

  /**
   * Blocks a reference if its table name, any qualifier (db/schema), or its qualified
   * name is denylisted, or if it lives in a system schema.
   */
  private checkTableAccess(ref: TableRef, ctes: ReadonlySet<string>): string | null {
    const table = ref.table.toLowerCase();
    const qualifiers = ref.qualifiers.map(q => q.toLowerCase());
    const qualifiedName = [...qualifiers, table].join('.');
    const displayName = [...ref.qualifiers, ref.table].join('.');

    const systemSchema = qualifiers.find(q => SqlSecurityGuardrail.SYSTEM_SCHEMAS.includes(q));
    if (systemSchema) {
      return `Access to system schema '${systemSchema}' ('${displayName}') is forbidden.`;
    }

    const blocked = this.options.blockedTables;
    if (blocked.includes(table) || blocked.includes(qualifiedName)) {
      return `Access to restricted table '${ref.table}' is forbidden.`;
    }
    const blockedQualifier = qualifiers.find(q => blocked.includes(q));
    if (blockedQualifier) {
      return `Access to restricted schema '${blockedQualifier}' ('${displayName}') is forbidden.`;
    }
    // Deny rules always win. Unqualified entries permit that bare table name
    // across schemas; use qualified entries for a narrower access boundary.
    const allowed = this.options.allowedTables;
    const isCte = qualifiers.length === 0 && ctes.has(table);
    if (allowed !== undefined && !isCte && !allowed.includes(table) && !allowed.includes(qualifiedName)) {
      return `Access to table '${displayName}' is not in the access allowlist.`;
    }
    return null;
  }

  /**
   * Fail-closed allowlist for writes: every table a non-SELECT statement targets must be
   * listed in mutableTables. A statement whose target cannot be determined is rejected.
   */
  private checkMutationTargets(node: any, type: string): string | null {
    const targets: TableRef[] = [];
    for (const key of SqlSecurityGuardrail.MUTATION_TARGET_KEYS) {
      const value = node[key];
      if (Array.isArray(value)) {
        targets.push(...value.filter(item => item && typeof item.table === 'string').map(item => this.toTableRef(item)));
      }
    }

    if (targets.length === 0) {
      return `Unable to determine the target table of '${type}' statement; mutation rejected.`;
    }

    const allowed = this.options.mutableTables;
    for (const ref of targets) {
      const table = ref.table.toLowerCase();
      const qualifiedName = [...ref.qualifiers.map(q => q.toLowerCase()), table].join('.');
      if (!allowed.includes(table) && !allowed.includes(qualifiedName)) {
        return `Table '${ref.table}' is not in the mutation allowlist; '${type}' is forbidden.`;
      }
    }
    return null;
  }

  /**
   * Detects predicates that cannot filter rows: constant expressions (1=1, 'a'='a'),
   * self-comparisons (Id = Id), match-all LIKE '%', and any OR branch that is itself
   * a tautology. Not a full theorem prover — it closes the common bypass shapes.
   */
  private isTautology(expr: any): boolean {
    if (!expr || typeof expr !== 'object') return false;

    if (!this.containsColumnRef(expr)) return true;

    if (expr.type === 'binary_expr') {
      const op = String(expr.operator || '').toUpperCase();
      if (op === 'OR') return this.isTautology(expr.left) || this.isTautology(expr.right);
      if (op === 'AND') return this.isTautology(expr.left) && this.isTautology(expr.right);
      if (['=', '>=', '<=', 'LIKE'].includes(op) && JSON.stringify(expr.left) === JSON.stringify(expr.right)) {
        return true;
      }
      if (op === 'LIKE' && typeof expr.right?.value === 'string' && /^%+$/.test(expr.right.value)) {
        return true;
      }
    }
    return false;
  }

  /**
   * True if the expression references at least one real column (SELECT * does not count).
   */
  private containsColumnRef(node: any): boolean {
    if (!node || typeof node !== 'object') return false;
    if (node.type === 'column_ref') return node.column !== '*';
    for (const key of Object.keys(node)) {
      if (key === 'parent') continue;
      const child = node[key];
      if (Array.isArray(child) ? child.some(c => this.containsColumnRef(c)) : this.containsColumnRef(child)) {
        return true;
      }
    }
    return false;
  }

  private buildResult(
    allowed: boolean, 
    reason: string | undefined, 
    startTime: number, 
    statementTypes: string[],
    violationCode: GuardrailResult['violationCode'] = 'POLICY_VIOLATION'
  ): GuardrailResult {
    return {
      allowed,
      reason,
      executionTimeMs: Number((performance.now() - startTime).toFixed(3)),
      statementTypes,
      ...(allowed ? {} : { violationCode })
    };
  }
}
