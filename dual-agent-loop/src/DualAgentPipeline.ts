import { GoogleGenAI } from "@google/genai";
import {
  VehicleSpec,
  GeneratedAdCopy,
  DiscriminatorCritique,
  PipelineOptions,
  PipelineResult
} from "./types.js";

const MODEL = "gemini-2.5-flash";

class InvalidModelResponseError extends Error {}

function isRetryable(error: unknown): boolean {
  if (error instanceof InvalidModelResponseError) return true;
  if (!error || typeof error !== 'object') return false;
  const details = error as { status?: number; statusCode?: number; code?: number | string; message?: string; cause?: unknown };
  const status = details.status ?? details.statusCode ?? (typeof details.code === 'number' ? details.code : undefined);
  if (status !== undefined) return status === 408 || status === 429 || (status >= 500 && status <= 599);
  // Support common Node transport codes and plain-text errors used by adapters.
  // Unknown errors fail fast; retrying programming errors hides their cause.
  const message = `${details.code ?? ''} ${details.message ?? ''}`;
  return /\b(ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|408|429|5\d\d)\b/.test(message)
    || (error instanceof TypeError && /fetch failed|network/i.test(message));
}

/**
 * Inference-time generate/review/revise workflow; no model weights are updated.
 * The same model fills both roles, so reviewer errors can correlate with
 * generator errors. Acceptance is a rubric decision, not proof of correctness.
 */
export class DualAgentPipeline {
  private ai: GoogleGenAI;
  private maxAttempts: number;
  private passScoreThreshold: number;
  private maxApiRetries: number;
  private retryDelayMs: number;
  private maxPromptChars: number;

  constructor(maxAttempts = 3, passScoreThreshold = 0.90, options: PipelineOptions = {}) {
    if (!process.env.GEMINI_API_KEY) {
      throw new Error("GEMINI_API_KEY environment variable is required.");
    }
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
      throw new Error("maxAttempts must be an integer >= 1.");
    }
    if (!Number.isFinite(passScoreThreshold) || passScoreThreshold < 0 || passScoreThreshold > 1) {
      throw new Error("passScoreThreshold must be between 0 and 1.");
    }
    if (!Number.isInteger(options.maxApiRetries ?? 2) || (options.maxApiRetries ?? 2) < 0) throw new Error("maxApiRetries must be an integer >= 0.");
    if (!Number.isFinite(options.retryDelayMs ?? 1000) || (options.retryDelayMs ?? 1000) < 0) throw new Error("retryDelayMs must be a finite number >= 0.");
    if (!Number.isSafeInteger(options.maxPromptChars ?? 50_000) || (options.maxPromptChars ?? 50_000) < 1) {
      throw new Error('maxPromptChars must be a positive safe integer.');
    }
    this.ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
    this.maxAttempts = maxAttempts;
    this.passScoreThreshold = passScoreThreshold;
    this.maxApiRetries = options.maxApiRetries ?? 2;
    this.retryDelayMs = options.retryDelayMs ?? 1000;
    this.maxPromptChars = options.maxPromptChars ?? 50_000;
  }

  /**
   * Rejects specs that would put nonsense (negative prices, NaN mileage, blank names) into the prompts.
   */
  private validateSpec(spec: VehicleSpec): void {
    if (!spec || typeof spec !== "object") throw new Error("Invalid vehicle spec: expected an object");
    const errors: string[] = [];
    for (const field of ["vin", "make", "model"] as const) {
      if (typeof spec[field] !== "string" || !spec[field].trim()) errors.push(`${field} must be a non-empty string`);
    }
    if (typeof spec.trim !== "string") errors.push("trim must be a string");
    if (!Number.isInteger(spec.year) || spec.year < 1886 || spec.year > new Date().getFullYear() + 2) {
      errors.push("year is invalid");
    }
    if (!Number.isFinite(spec.price) || spec.price < 0) errors.push("price must be a non-negative number");
    if (!Number.isFinite(spec.mileage) || spec.mileage < 0) errors.push("mileage must be a non-negative number");
    if (!Array.isArray(spec.keyFeatures) || spec.keyFeatures.length === 0 || spec.keyFeatures.some(f => typeof f !== "string" || !f.trim())) {
      errors.push("keyFeatures must be a non-empty array of non-empty strings");
    }
    if (spec.mileageUnit !== undefined && spec.mileageUnit !== "miles" && spec.mileageUnit !== "km") errors.push("mileageUnit must be miles or km");
    if (errors.length) throw new Error(`Invalid vehicle spec: ${errors.join("; ")}`);
  }

  /**
   * Calls the model and parses/validates its JSON reply, retrying with exponential backoff
   * on API errors (429, network) and on empty or malformed responses.
   */
  private async callModel<T>(prompt: string, responseSchema: object, parse: (raw: unknown) => T, label: string): Promise<T> {
    if (prompt.length > this.maxPromptChars) throw new Error(`${label} prompt exceeds maxPromptChars`);
    let lastError: unknown;
    let tries = 0;
    for (let tryNum = 0; tryNum <= this.maxApiRetries; tryNum++) {
      if (tryNum > 0) {
        // Cap the delay so a large retry count cannot overflow the timer.
        const delay = this.retryDelayMs === 0 ? 0 : Math.min(30_000, this.retryDelayMs * 2 ** (tryNum - 1));
        console.warn(`↻ ${label} call failed (${(lastError as Error)?.message}). Retrying in ${delay}ms...`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
      try {
        tries++;
        const response = await this.ai.models.generateContent({
          model: MODEL,
          contents: prompt,
          config: { responseMimeType: "application/json", responseSchema }
        });
        if (!response.text?.trim()) throw new InvalidModelResponseError(`${label} returned an empty response`);
        let raw: unknown;
        try {
          raw = JSON.parse(response.text);
        } catch {
          throw new InvalidModelResponseError(`${label} returned invalid JSON`);
        }
        try {
          return parse(raw);
        } catch (error) {
          throw new InvalidModelResponseError(error instanceof Error ? error.message : String(error), { cause: error });
        }
      } catch (error) {
        lastError = error;
        if (!isRetryable(error)) break;
      }
    }
    throw new Error(`${label} failed after ${tries} tries: ${lastError instanceof Error ? lastError.message : String(lastError)}`, { cause: lastError });
  }

  private parseCopy(raw: unknown): GeneratedAdCopy {
    const obj = (raw ?? {}) as Record<string, unknown>;
    for (const field of ["headline", "bodyText", "callToAction", "targetPlatform"]) {
      if (typeof obj[field] !== "string" || !(obj[field] as string).trim()) {
        throw new Error(`Generator response is missing "${field}"`);
      }
    }
    // Do not forward unknown model fields into the next prompt's feedback.
    return { headline: obj.headline as string, bodyText: obj.bodyText as string,
      callToAction: obj.callToAction as string, targetPlatform: obj.targetPlatform as string };
  }

  private parseCritique(raw: unknown): DiscriminatorCritique {
    // A response schema constrains generation but does not replace validation
    // at the API boundary. In particular, never coerce 0–100 scores into a pass.
    const obj = (raw ?? {}) as Record<string, unknown>;
    const score = obj.score;
    if (typeof score !== "number" || !Number.isFinite(score) || score < 0 || score > 1) {
      throw new Error(`Discriminator score must be a number between 0 and 1, got ${JSON.stringify(score)}`);
    }
    const toStrings = (v: unknown) => (Array.isArray(v) ? v.filter((s): s is string => typeof s === "string") : []);
    return {
      score,
      // The threshold is the single source of truth; the model's own "passed" flag is not trusted.
      passed: score >= this.passScoreThreshold,
      issues: toStrings(obj.issues),
      suggestions: toStrings(obj.suggestions)
    };
  }

  /**
   * Generator Agent: Produces ad copy based on vehicle specs and optional previous draft + critique.
   */
  private async generate(
    spec: VehicleSpec,
    previous?: { copy: GeneratedAdCopy; critique: DiscriminatorCritique }
  ): Promise<GeneratedAdCopy> {
    const features = spec.keyFeatures.length ? spec.keyFeatures.join(", ") : "None listed";
    let prompt = `
You are a high-converting automotive marketing copywriter.
Write compelling ad copy for Facebook based ONLY on these verified specs:
- ${spec.year} ${spec.make} ${spec.model} ${spec.trim}
- Price: $${spec.price.toLocaleString("en-US")}
- Mileage: ${spec.mileage.toLocaleString("en-US")} ${spec.mileageUnit ?? "miles"}
- Key Features: ${features}

Requirements:
- Never hallucinate features not listed.
- Keep body text punchy (80-120 words).
- Include a clear call to action.
`;

    if (previous) {
      prompt += `
\n[CRITICAL - PREVIOUS DRAFT CRITIQUE]
Your previous attempt received a score of ${previous.critique.score} and was REJECTED.

Previous draft:
${JSON.stringify(previous.copy, null, 2)}

Fix the following issues in this iteration:
${previous.critique.issues.map(i => `- ${i}`).join("\n") || "- (none specified)"}

Suggestions to improve:
${previous.critique.suggestions.map(s => `- ${s}`).join("\n") || "- (none specified)"}
`;
    }

    return this.callModel(prompt, {
      type: "OBJECT",
      properties: {
        headline: { type: "STRING" },
        bodyText: { type: "STRING" },
        callToAction: { type: "STRING" },
        targetPlatform: { type: "STRING" }
      },
      required: ["headline", "bodyText", "callToAction", "targetPlatform"]
    }, raw => this.parseCopy(raw), "Generator");
  }

  /**
   * Discriminator Agent: Evaluates generated ad copy against the original vehicle specification.
   */
  private async discriminate(spec: VehicleSpec, copy: GeneratedAdCopy): Promise<DiscriminatorCritique> {
    const prompt = `
You are an unyielding compliance auditor for dealership advertising.
Evaluate the following generated ad copy against the original vehicle specifications.

[ORIGINAL SPECS]
${JSON.stringify(spec, null, 2)}

[GENERATED AD COPY]
${JSON.stringify(copy, null, 2)}

Evaluation Rubric:
1. Factual Accuracy: Did the copy invent features, prices, or specs not present in the input? (-0.3 per hallucination)
2. Tone & Conciseness: Is the body text clean, punchy, and appropriate for Facebook? (-0.1 if wordy or vague)
3. Call To Action: Is there an explicit CTA inviting the customer to visit or message the dealership? (-0.2 if missing)

Assign a final float score between 0.00 and 1.00. Set 'passed' to true ONLY if score >= ${this.passScoreThreshold}.
`;

    return this.callModel(prompt, {
      type: "OBJECT",
      properties: {
        score: { type: "NUMBER" },
        passed: { type: "BOOLEAN" },
        issues: { type: "ARRAY", items: { type: "STRING" } },
        suggestions: { type: "ARRAY", items: { type: "STRING" } }
      },
      required: ["score", "passed", "issues", "suggestions"]
    }, raw => this.parseCritique(raw), "Discriminator");
  }

  /**
   * Orchestrates the iterative Generator-Discriminator loop.
   */
  public async execute(spec: VehicleSpec): Promise<PipelineResult> {
    this.validateSpec(spec);

    const history: PipelineResult["history"] = [];
    let failure: string | undefined;
    let best: PipelineResult["history"][number] | undefined;

    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      const previous = history[history.length - 1];
      // Revise the latest draft for continuity, but retain the best separately.
      // Reviewer scores need not improve monotonically across iterations.

      console.log(`\n--- [Pass ${attempt}/${this.maxAttempts}] Generating Draft... ---`);
      let copy: GeneratedAdCopy;
      let critique: DiscriminatorCritique;
      try {
        copy = await this.generate(spec, previous);

        console.log(`--- [Pass ${attempt}/${this.maxAttempts}] Auditing Output... ---`);
        critique = await this.discriminate(spec, copy);
      } catch (error) {
        if (!best) throw error;
        failure = error instanceof Error ? error.message : String(error);
        break;
      }

      const entry = { attempt, copy, critique };
      history.push(entry);
      if (!best || critique.score > best.critique.score) best = entry;
      // Equal scores keep the earlier draft. Selecting the maximum can favor
      // judge noise; assess this policy with an independent held-out evaluator.

      console.log(`[Discriminator Verdict] Score: ${critique.score} | Passed: ${critique.passed}`);

      if (critique.passed) {
        console.log(`\n✅ High-quality output achieved on attempt ${attempt}.`);
        break;
      }

      console.warn(`⚠️ Draft rejected. Issues found:\n${critique.issues.map(i => `  - ${i}`).join("\n")}`);
    }

    return {
      ...(failure === undefined ? {} : { error: failure }),
      finalCopy: best!.copy,
      passed: best!.critique.passed,
      attempts: history.length,
      bestAttempt: best!.attempt,
      terminationReason: failure !== undefined ? 'model_error' : best!.critique.passed ? 'passed' : 'attempt_limit',
      history
    };
  }
}
