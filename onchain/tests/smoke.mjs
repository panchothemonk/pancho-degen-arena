const required = ["ANCHOR_PROVIDER_URL", "ANCHOR_WALLET"];
const missing = required.filter((key) => !process.env[key]);

if (missing.length > 0) {
  console.error(`[smoke] missing env: ${missing.join(", ")}`);
  process.exit(1);
}

console.log(`[smoke] provider=${process.env.ANCHOR_PROVIDER_URL}`);
console.log(`[smoke] wallet=${process.env.ANCHOR_WALLET}`);
console.log("[smoke] on-chain test harness booted");
