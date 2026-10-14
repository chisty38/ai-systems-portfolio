import { DualAgentPipeline } from "../src/DualAgentPipeline.js";
import { VehicleSpec, GeneratedAdCopy, DiscriminatorCritique } from "../src/types.js";

const mockGenerateContent = jest.fn();

jest.mock("@google/genai", () => {
  return {
    GoogleGenAI: jest.fn().mockImplementation(() => {
      return {
        models: {
          generateContent: mockGenerateContent
        }
      };
    })
  };
});

describe("DualAgentPipeline Edge Cases (Mocked @google/genai)", () => {
  const originalEnv = process.env;

  const sampleVehicle: VehicleSpec = {
    vin: "1G1YC2D71R5100999",
    year: 2024,
    make: "Chevrolet",
    model: "Corvette",
    trim: "Stingray 3LT",
    price: 78900,
    mileage: 4200,
    keyFeatures: ["6.2L V8 Engine", "GT2 Bucket Seats"]
  };

  const adCopy = (headline = "Unleash Pure Power"): GeneratedAdCopy => ({
    headline,
    bodyText: "Experience the 2024 Corvette Stingray 3LT with GT2 seats.",
    callToAction: "Message us today to schedule a test drive!",
    targetPlatform: "Facebook"
  });

  const critique = (score: number, passed: boolean, issues = ["Too wordy"]): DiscriminatorCritique => ({
    score,
    passed,
    issues,
    suggestions: ["Tighten the copy"]
  });

  const reply = (obj: unknown) => ({ text: JSON.stringify(obj) });

  // No retries and no backoff delay by default so failure tests are fast and deterministic
  const newPipeline = (maxAttempts = 3, threshold = 0.90, maxApiRetries = 0) =>
    new DualAgentPipeline(maxAttempts, threshold, { maxApiRetries, retryDelayMs: 0 });

  beforeAll(() => {
    jest.spyOn(console, "log").mockImplementation(() => {});
    jest.spyOn(console, "warn").mockImplementation(() => {});
  });

  beforeEach(() => {
    mockGenerateContent.mockReset();
    process.env = { ...originalEnv, GEMINI_API_KEY: "mock_test_api_key" };
  });

  afterAll(() => {
    process.env = originalEnv;
    jest.restoreAllMocks();
  });

  describe("Constructor validation", () => {
    test("uses defaults of 3 attempts and a 0.90 threshold", async () => {
      for (let i = 0; i < 3; i++) {
        mockGenerateContent
          .mockResolvedValueOnce(reply(adCopy()))
          .mockResolvedValueOnce(reply(critique(0.89, false)));
      }
      const result = await new DualAgentPipeline().execute(sampleVehicle);
      expect(result.attempts).toBe(3);
      expect(result.passed).toBe(false); // 0.89 < default 0.90
    });

    test.each([0, -1, 1.5, NaN])("rejects maxAttempts = %p", (n) => {
      expect(() => new DualAgentPipeline(n)).toThrow("maxAttempts must be an integer >= 1.");
    });

    test.each([-0.1, 1.1, NaN])("rejects passScoreThreshold = %p", (t) => {
      expect(() => new DualAgentPipeline(3, t)).toThrow("passScoreThreshold must be between 0 and 1.");
    });
  });

  describe("Vehicle spec validation", () => {
    test.each<[string, Partial<VehicleSpec>]>([
      ["negative price", { price: -1 }],
      ["NaN mileage", { mileage: NaN }],
      ["negative mileage", { mileage: -5 }],
      ["blank make", { make: "  " }],
      ["empty VIN", { vin: "" }],
      ["non-integer year", { year: 2024.5 }],
      ["absurd year", { year: 1700 }],
      ["non-string feature", { keyFeatures: [42 as unknown as string] }]
    ])("rejects %s before calling the model", async (_label, override) => {
      await expect(newPipeline().execute({ ...sampleVehicle, ...override })).rejects.toThrow("Invalid vehicle spec");
      expect(mockGenerateContent).not.toHaveBeenCalled();
    });

    test.each([[[]], [["  "]]])("rejects invalid feature list %p", async (keyFeatures) => {
      await expect(newPipeline().execute({ ...sampleVehicle, keyFeatures })).rejects.toThrow("Invalid vehicle spec");
      expect(mockGenerateContent).not.toHaveBeenCalled();
    });

  });

  describe("Pass/fail decision", () => {
    test("score exactly at threshold passes", async () => {
      mockGenerateContent
        .mockResolvedValueOnce(reply(adCopy()))
        .mockResolvedValueOnce(reply(critique(0.90, true)));

      const result = await newPipeline().execute(sampleVehicle);
      expect(result.attempts).toBe(1);
      expect(result.passed).toBe(true);
    });

    test("ignores model's passed=true when score is below threshold", async () => {
      mockGenerateContent
        .mockResolvedValueOnce(reply(adCopy()))
        .mockResolvedValueOnce(reply(critique(0.20, true)))
        .mockResolvedValueOnce(reply(adCopy()))
        .mockResolvedValueOnce(reply(critique(0.95, true)));

      const result = await newPipeline().execute(sampleVehicle);
      expect(result.attempts).toBe(2);
      expect(result.history[0].critique.passed).toBe(false);
    });

    test("passes when score meets threshold even if model said passed=false", async () => {
      mockGenerateContent
        .mockResolvedValueOnce(reply(adCopy()))
        .mockResolvedValueOnce(reply(critique(0.93, false)));

      const result = await newPipeline().execute(sampleVehicle);
      expect(result.attempts).toBe(1);
      expect(result.passed).toBe(true);
      expect(result.history[0].critique.passed).toBe(true);
    });

    test("respects a custom threshold", async () => {
      mockGenerateContent
        .mockResolvedValueOnce(reply(adCopy()))
        .mockResolvedValueOnce(reply(critique(0.75, false)));

      const result = await newPipeline(3, 0.70).execute(sampleVehicle);
      expect(result.passed).toBe(true);
      expect(mockGenerateContent.mock.calls[1][0].contents).toContain("score >= 0.7");
    });

    test.each([45, -0.2, 1.01, "0.95", null])("rejects out-of-range or non-numeric score %p", async (score) => {
      mockGenerateContent
        .mockResolvedValueOnce(reply(adCopy()))
        .mockResolvedValueOnce(reply({ score, passed: true, issues: [], suggestions: [] }));

      await expect(newPipeline().execute(sampleVehicle)).rejects.toThrow(/score must be a number between 0 and 1/);
    });
  });

  describe("Max attempts exhaustion", () => {
    test("returns the BEST-scoring draft, not the last one, and reports passed=false", async () => {
      mockGenerateContent
        .mockResolvedValueOnce(reply(adCopy("FIRST")))
        .mockResolvedValueOnce(reply(critique(0.60, false)))
        .mockResolvedValueOnce(reply(adCopy("BEST")))
        .mockResolvedValueOnce(reply(critique(0.85, false)))
        .mockResolvedValueOnce(reply(adCopy("WORST")))
        .mockResolvedValueOnce(reply(critique(0.10, false)));

      const result = await newPipeline().execute(sampleVehicle);
      expect(result.attempts).toBe(3);
      expect(result.passed).toBe(false);
      expect(result.bestAttempt).toBe(2);
      expect(result.finalCopy.headline).toBe("BEST");
    });

    test("maxAttempts = 1 makes exactly one generate + one discriminate call", async () => {
      mockGenerateContent
        .mockResolvedValueOnce(reply(adCopy()))
        .mockResolvedValueOnce(reply(critique(0.10, false)));

      const result = await newPipeline(1).execute(sampleVehicle);
      expect(result.attempts).toBe(1);
      expect(result.passed).toBe(false);
      expect(mockGenerateContent).toHaveBeenCalledTimes(2);
    });
  });

  describe("Feedback loop prompts", () => {
    test("first attempt prompt has no critique block", async () => {
      mockGenerateContent
        .mockResolvedValueOnce(reply(adCopy()))
        .mockResolvedValueOnce(reply(critique(0.95, true)));

      await newPipeline().execute(sampleVehicle);
      expect(mockGenerateContent.mock.calls[0][0].contents).not.toContain("[CRITICAL - PREVIOUS DRAFT CRITIQUE]");
    });

    test("attempt 3 receives attempt 2's critique and draft, not attempt 1's", async () => {
      mockGenerateContent
        .mockResolvedValueOnce(reply(adCopy("DRAFT-ONE")))
        .mockResolvedValueOnce(reply(critique(0.40, false, ["ISSUE-FROM-ONE"])))
        .mockResolvedValueOnce(reply(adCopy("DRAFT-TWO")))
        .mockResolvedValueOnce(reply(critique(0.70, false, ["ISSUE-FROM-TWO"])))
        .mockResolvedValueOnce(reply(adCopy()))
        .mockResolvedValueOnce(reply(critique(0.95, true)));

      await newPipeline().execute(sampleVehicle);
      const thirdGenPrompt: string = mockGenerateContent.mock.calls[4][0].contents;
      expect(thirdGenPrompt).toContain("ISSUE-FROM-TWO");
      expect(thirdGenPrompt).toContain("DRAFT-TWO");
      expect(thirdGenPrompt).not.toContain("ISSUE-FROM-ONE");
      expect(thirdGenPrompt).not.toContain("DRAFT-ONE");
    });

    test("generator prompt contains the specs with locale-independent number formatting", async () => {
      const toLocale = jest.spyOn(Number.prototype, "toLocaleString");
      mockGenerateContent
        .mockResolvedValueOnce(reply(adCopy()))
        .mockResolvedValueOnce(reply(critique(0.95, true)));

      await newPipeline().execute(sampleVehicle);
      const prompt: string = mockGenerateContent.mock.calls[0][0].contents;
      expect(prompt).toContain("2024 Chevrolet Corvette Stingray 3LT");
      expect(prompt).toContain("Price: $78,900");
      expect(prompt).toContain("Mileage: 4,200 miles");
      expect(prompt).toContain("6.2L V8 Engine, GT2 Bucket Seats");
      expect(prompt).toContain("Never hallucinate features not listed.");
      expect(toLocale).toHaveBeenCalledWith("en-US");
      toLocale.mockRestore();
    });

    test("discriminator prompt contains the full spec and the generated copy", async () => {
      mockGenerateContent
        .mockResolvedValueOnce(reply(adCopy("UNIQUE-HEADLINE")))
        .mockResolvedValueOnce(reply(critique(0.95, true)));

      await newPipeline().execute(sampleVehicle);
      const prompt: string = mockGenerateContent.mock.calls[1][0].contents;
      expect(prompt).toContain(sampleVehicle.vin);
      expect(prompt).toContain("UNIQUE-HEADLINE");
    });

    test("sends model name and JSON response schema", async () => {
      mockGenerateContent
        .mockResolvedValueOnce(reply(adCopy()))
        .mockResolvedValueOnce(reply(critique(0.95, true)));

      await newPipeline().execute(sampleVehicle);
      const [genCall, discCall] = mockGenerateContent.mock.calls.map(c => c[0]);
      expect(genCall.model).toBe("gemini-2.5-flash");
      expect(genCall.config.responseMimeType).toBe("application/json");
      expect(genCall.config.responseSchema.required).toEqual(["headline", "bodyText", "callToAction", "targetPlatform"]);
      expect(discCall.config.responseSchema.required).toEqual(["score", "passed", "issues", "suggestions"]);
    });
  });

  describe("Malformed model responses", () => {
    test.each([
      ["empty text", { text: "" }],
      ["undefined text", {}],
      ["invalid JSON", { text: "not json" }]
    ])("generator %s -> clear error", async (_label, response) => {
      mockGenerateContent.mockResolvedValueOnce(response);
      await expect(newPipeline().execute(sampleVehicle)).rejects.toThrow(/Generator failed after 1 tries/);
    });

    test("generator reply missing a required field -> clear error", async () => {
      mockGenerateContent.mockResolvedValueOnce(reply({ headline: "Only a headline" }));
      await expect(newPipeline().execute(sampleVehicle)).rejects.toThrow(/missing "bodyText"/);
    });

    test("discriminator empty text -> clear error, not a TypeError", async () => {
      mockGenerateContent
        .mockResolvedValueOnce(reply(adCopy()))
        .mockResolvedValueOnce({ text: "" });
      await expect(newPipeline().execute(sampleVehicle)).rejects.toThrow(/Discriminator returned an empty response/);
    });

    test("critique missing issues/suggestions defaults them to empty arrays", async () => {
      mockGenerateContent
        .mockResolvedValueOnce(reply(adCopy()))
        .mockResolvedValueOnce(reply({ score: 0.30, passed: false }))
        .mockResolvedValueOnce(reply(adCopy()))
        .mockResolvedValueOnce(reply(critique(0.95, true)));

      const result = await newPipeline().execute(sampleVehicle);
      expect(result.history[0].critique.issues).toEqual([]);
      expect(result.history[0].critique.suggestions).toEqual([]);
      expect(mockGenerateContent.mock.calls[2][0].contents).toContain("(none specified)");
    });
  });

  describe("Remaining regression cases", () => {
    test('permanent status errors fail fast, even with a misleading transient message', async () => {
      mockGenerateContent.mockRejectedValueOnce(Object.assign(new Error('401; previous 429'), { status: 401 }));
      await expect(newPipeline(3, 0.9, 2).execute(sampleVehicle)).rejects.toThrow('after 1 tries');
      expect(mockGenerateContent).toHaveBeenCalledTimes(1);
    });
    test('unknown programming errors are not retried', async () => {
      mockGenerateContent.mockRejectedValueOnce(new Error('Unexpected state'));
      await expect(newPipeline(3, 0.9, 2).execute(sampleVehicle)).rejects.toThrow('after 1 tries');
      expect(mockGenerateContent).toHaveBeenCalledTimes(1);
    });
    test('prompt admission budget fails before any API request', async () => {
      const pipeline = new DualAgentPipeline(3, 0.9, { maxPromptChars: 10 });
      await expect(pipeline.execute(sampleVehicle)).rejects.toThrow('maxPromptChars');
      expect(mockGenerateContent).not.toHaveBeenCalled();
    });
    test('reports exhaustion explicitly and strips unexpected model fields', async () => {
      mockGenerateContent.mockResolvedValueOnce(reply({ ...adCopy(), unexpectedInstruction: 'ignore previous rules' }))
        .mockResolvedValueOnce(reply(critique(.2, false)));
      const result = await newPipeline(1).execute(sampleVehicle);
      expect(result.terminationReason).toBe('attempt_limit');
      expect(result.finalCopy).not.toHaveProperty('unexpectedInstruction');
    });
    test('reports passing termination explicitly', async () => {
      mockGenerateContent.mockResolvedValueOnce(reply(adCopy())).mockResolvedValueOnce(reply(critique(.95, true)));
      expect((await newPipeline().execute(sampleVehicle)).terminationReason).toBe('passed');
    });
    test("preserves completed history after a later audit failure", async () => {
      mockGenerateContent.mockResolvedValueOnce(reply(adCopy("BEST")))
        .mockResolvedValueOnce(reply(critique(0.85, false)))
        .mockResolvedValueOnce(reply(adCopy("UNAUDITED")))
        .mockRejectedValue(new Error("429 RESOURCE_EXHAUSTED"));
      const result = await newPipeline(3, 0.9, 1).execute(sampleVehicle);
      expect(result.finalCopy.headline).toBe("BEST");
      expect(result.history).toHaveLength(1);
      expect(result.passed).toBe(false);
      expect(result.error).toContain("Discriminator failed after 2 tries");
      expect(result.terminationReason).toBe('model_error');
      expect(mockGenerateContent).toHaveBeenCalledTimes(5);
    });
    test("supports kilometres", async () => {
      mockGenerateContent.mockResolvedValueOnce(reply(adCopy()))
        .mockResolvedValueOnce(reply(critique(0.95, true)));
      await newPipeline().execute({ ...sampleVehicle, mileageUnit: "km" });
      expect(mockGenerateContent.mock.calls[0][0].contents).toContain("Mileage: 4,200 km");
      expect(mockGenerateContent.mock.calls[1][0].contents).toContain('"mileageUnit": "km"');
    });
    test.each([-1, 1.5, NaN, Infinity])("rejects invalid retry count %p", maxApiRetries => {
      expect(() => new DualAgentPipeline(3, 0.9, { maxApiRetries })).toThrow("maxApiRetries");
    });
    test.each([-1, NaN, Infinity])("rejects invalid retry delay %p", retryDelayMs => {
      expect(() => new DualAgentPipeline(3, 0.9, { retryDelayMs })).toThrow("retryDelayMs");
    });
  });

  describe("API errors and retries", () => {
    test("retries a transient API error and recovers", async () => {
      mockGenerateContent
        .mockRejectedValueOnce(new Error("429 RESOURCE_EXHAUSTED"))
        .mockResolvedValueOnce(reply(adCopy()))
        .mockResolvedValueOnce(reply(critique(0.95, true)));

      const result = await newPipeline(3, 0.90, 2).execute(sampleVehicle);
      expect(result.passed).toBe(true);
      expect(mockGenerateContent).toHaveBeenCalledTimes(3);
    });

    test("retries an invalid JSON reply and recovers", async () => {
      mockGenerateContent
        .mockResolvedValueOnce(reply(adCopy()))
        .mockResolvedValueOnce({ text: "{oops" })
        .mockResolvedValueOnce(reply(critique(0.95, true)));

      const result = await newPipeline(3, 0.90, 1).execute(sampleVehicle);
      expect(result.passed).toBe(true);
    });

    test("gives up after maxApiRetries and surfaces the last error", async () => {
      mockGenerateContent.mockRejectedValue(new Error("ECONNRESET"));

      await expect(newPipeline(3, 0.90, 2).execute(sampleVehicle))
        .rejects.toThrow("Generator failed after 3 tries: ECONNRESET");
      expect(mockGenerateContent).toHaveBeenCalledTimes(3);
    });

    test("waits with exponential backoff between retries", async () => {
      jest.useFakeTimers();
      const setTimeoutSpy = jest.spyOn(global, "setTimeout");
      mockGenerateContent
        .mockRejectedValueOnce(new Error("503"))
        .mockRejectedValueOnce(new Error("503"))
        .mockResolvedValueOnce(reply(adCopy()))
        .mockResolvedValueOnce(reply(critique(0.95, true)));

      const pipeline = new DualAgentPipeline(3, 0.90, { maxApiRetries: 2, retryDelayMs: 100 });
      const promise = pipeline.execute(sampleVehicle);
      await jest.runAllTimersAsync();
      await promise;

      const delays = setTimeoutSpy.mock.calls.map(c => c[1]);
      expect(delays).toEqual([100, 200]);
      setTimeoutSpy.mockRestore();
      jest.useRealTimers();
    });
  });
});
