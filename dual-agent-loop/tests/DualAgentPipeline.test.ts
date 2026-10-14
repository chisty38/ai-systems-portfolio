import { DualAgentPipeline } from "../src/DualAgentPipeline.js";
import { VehicleSpec, GeneratedAdCopy, DiscriminatorCritique } from "../src/types.js";

// 1. Mock the @google/genai SDK
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

describe("DualAgentPipeline Unit Tests (Mocked @google/genai)", () => {
  const originalEnv = process.env;

  const sampleVehicle: VehicleSpec = {
    vin: "1G1YC2D71R5100999",
    year: 2024,
    make: "Chevrolet",
    model: "Corvette",
    trim: "Stingray 3LT",
    price: 78900,
    mileage: 4200,
    keyFeatures: [
      "6.2L V8 Engine",
      "8-Speed Dual-Clutch Transmission",
      "GT2 Bucket Seats",
      "Bose Performance Series Sound"
    ]
  };

  const validAdCopy: GeneratedAdCopy = {
    headline: "Unleash Pure Power: 2024 Corvette Stingray 3LT",
    bodyText: "Experience pristine performance with this 2024 Corvette Stingray 3LT featuring GT2 seats.",
    callToAction: "Message us today to schedule a test drive!",
    targetPlatform: "Facebook"
  };

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...originalEnv, GEMINI_API_KEY: "mock_test_api_key" };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  test("FAIL: Throws error if GEMINI_API_KEY environment variable is missing", () => {
    delete process.env.GEMINI_API_KEY;
    expect(() => new DualAgentPipeline()).toThrow(
      "GEMINI_API_KEY environment variable is required."
    );
  });

  test("SUCCESS: Converges on Attempt #1 when Discriminator score meets threshold", async () => {
    const passingCritique: DiscriminatorCritique = {
      score: 0.95,
      passed: true,
      issues: [],
      suggestions: []
    };

    // Attempt 1: Generator call -> Discriminator call
    mockGenerateContent
      .mockResolvedValueOnce({ text: JSON.stringify(validAdCopy) })
      .mockResolvedValueOnce({ text: JSON.stringify(passingCritique) });

    const pipeline = new DualAgentPipeline(3, 0.90);
    const result = await pipeline.execute(sampleVehicle);

    expect(result.attempts).toBe(1);
    expect(result.finalCopy).toEqual(validAdCopy);
    expect(result.history).toHaveLength(1);
    expect(result.history[0].critique.passed).toBe(true);
    expect(mockGenerateContent).toHaveBeenCalledTimes(2);
  });

  test("RETRY & RECOVER: Retries on rejected draft and converges on Attempt #2", async () => {
    const rejectedCritique: DiscriminatorCritique = {
      score: 0.60,
      passed: false,
      issues: ["Hallucinated 'Heated Steering Wheel' which is not in specs"],
      suggestions: ["Remove features not listed in source vehicle specs"]
    };

    const passingCritique: DiscriminatorCritique = {
      score: 0.92,
      passed: true,
      issues: [],
      suggestions: []
    };

    // Attempt 1: Generator -> Discriminator (Rejected)
    // Attempt 2: Generator -> Discriminator (Passed)
    mockGenerateContent
      .mockResolvedValueOnce({ text: JSON.stringify(validAdCopy) })
      .mockResolvedValueOnce({ text: JSON.stringify(rejectedCritique) })
      .mockResolvedValueOnce({ text: JSON.stringify(validAdCopy) })
      .mockResolvedValueOnce({ text: JSON.stringify(passingCritique) });

    const pipeline = new DualAgentPipeline(3, 0.90);
    const result = await pipeline.execute(sampleVehicle);

    expect(result.attempts).toBe(2);
    expect(result.history).toHaveLength(2);
    expect(result.history[0].critique.passed).toBe(false);
    expect(result.history[1].critique.passed).toBe(true);
    expect(mockGenerateContent).toHaveBeenCalledTimes(4);

    // Verify feedback was passed to Generator on Attempt 2
    const secondGenCallArgs = mockGenerateContent.mock.calls[2][0];
    expect(secondGenCallArgs.contents).toContain("[CRITICAL - PREVIOUS DRAFT CRITIQUE]");
    expect(secondGenCallArgs.contents).toContain("Hallucinated 'Heated Steering Wheel'");
  });

  test("MAX ATTEMPTS EXHAUSTION: Terminates at maxAttempts if score never passes", async () => {
    const failingCritique: DiscriminatorCritique = {
      score: 0.50,
      passed: false,
      issues: ["Body copy is too wordy for Facebook"],
      suggestions: ["Shorten body text under 100 words"]
    };

    // 3 Attempts x 2 model calls each = 6 mock calls
    for (let i = 0; i < 3; i++) {
      mockGenerateContent
        .mockResolvedValueOnce({ text: JSON.stringify(validAdCopy) })
        .mockResolvedValueOnce({ text: JSON.stringify(failingCritique) });
    }

    const pipeline = new DualAgentPipeline(3, 0.90);
    const result = await pipeline.execute(sampleVehicle);

    expect(result.attempts).toBe(3);
    expect(result.history).toHaveLength(3);
    expect(mockGenerateContent).toHaveBeenCalledTimes(6);
    expect(result.history[2].critique.score).toBe(0.50);
  });
});