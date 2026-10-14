export interface VehicleSpec {
  vin: string;
  year: number;
  make: string;
  model: string;
  trim: string;
  price: number;
  mileage: number;
  mileageUnit?: "miles" | "km"; // defaults to miles for existing callers
  keyFeatures: string[];
}

export interface GeneratedAdCopy {
  headline: string;
  bodyText: string;
  callToAction: string;
  targetPlatform: string;
}

export interface DiscriminatorCritique {
  score: number; // 0.00 to 1.00
  passed: boolean;
  issues: string[];
  suggestions: string[];
}

export interface PipelineOptions {
  maxApiRetries?: number; // extra tries per model call on API errors or invalid responses
  retryDelayMs?: number;  // base delay, doubled on each retry
  maxPromptChars?: number; // admission budget; character count is not a token limit
}

export interface PipelineResult {
  finalCopy: GeneratedAdCopy; // highest-scoring draft across all attempts
  passed: boolean;            // true only if finalCopy met the pass threshold
  error?: string; // model call failed after retries; completed history is retained
  attempts: number;
  bestAttempt: number;
  terminationReason: 'passed' | 'attempt_limit' | 'model_error';
  history: Array<{
    attempt: number;
    copy: GeneratedAdCopy;
    critique: DiscriminatorCritique;
  }>;
}
