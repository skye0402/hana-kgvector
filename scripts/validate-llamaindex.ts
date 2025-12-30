import { loadEnv } from "../src/env";

loadEnv();

async function main() {
  const mod: any = await import("llamaindex");
  const keys = Object.keys(mod).sort();
  const hasPropertyGraphIndex = "PropertyGraphIndex" in mod;

  console.log("llamaindex exports (first 50):");
  console.log(keys.slice(0, 50));
  console.log("PropertyGraphIndex:", hasPropertyGraphIndex ? "✅ present" : "❌ missing");

  process.exit(hasPropertyGraphIndex ? 0 : 2);
}

main().catch((err) => {
  console.error("Validation failed:", err);
  process.exit(1);
});
