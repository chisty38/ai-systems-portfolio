import { SqlSecurityGuardrail as ResultGuardrail, GuardrailResult } from './SecurityGuardrail.js';

export { SecurityPolicyViolationError } from './SecurityGuardrail.js';
export type { GuardrailOptions, GuardrailResult } from './SecurityGuardrail.js';

/**
 * Throwing entry point for the strict access-allowlist API.
 * Delegates to the same recursive engine as the existing result-returning API.
 * Omitted options default to read-only vehicles/inventory/dealerships access.
 */
export class SqlSecurityGuardrail {
  private readonly engine: ResultGuardrail;

  constructor(allowedTables: string[] = ['vehicles', 'inventory', 'dealerships']) {
    this.engine = new ResultGuardrail({ allowedTables });
  }

  /** Returns the accepted verdict; every rejected verdict throws a typed error. */
  public validate(sql: string): GuardrailResult {
    return this.engine.assertValid(sql);
  }
}
