import "dotenv/config";
import { DualAgentPipeline } from "./DualAgentPipeline.js";
import { VehicleSpec } from "./types.js";

async function main() {
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

  console.log("Starting Dual-Agent Generator-Discriminator Orchestration Loop...");
  try {
    const pipeline = new DualAgentPipeline(3, 0.90);
    const result = await pipeline.execute(sampleVehicle);
    console.log("\n==========================================");
    console.log(result.passed
      ? "FINAL AUDITED AD COPY"
      : `⚠️ BEST DRAFT (DID NOT PASS AUDIT - attempt ${result.bestAttempt})`);
    console.log("==========================================");
    if (result.error) console.error(`Pipeline interrupted: ${result.error}`);
    if (!result.passed || result.error) process.exitCode = 1;
    console.log(`Headline: ${result.finalCopy.headline}`);
    console.log(`Platform: ${result.finalCopy.targetPlatform}`);
    console.log(`Body:\n${result.finalCopy.bodyText}`);
    console.log(`CTA: ${result.finalCopy.callToAction}`);
    console.log(`Total Passes Required: ${result.attempts}`);
  } catch (error) {
    console.error("Pipeline Execution Failed:", error);
    process.exitCode = 1;
  }
}

main();