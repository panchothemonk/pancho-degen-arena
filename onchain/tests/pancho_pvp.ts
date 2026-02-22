import * as anchor from "@coral-xyz/anchor";

describe("pancho_pvp", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  it("bootstraps provider", async () => {
    if (!provider.wallet?.publicKey) {
      throw new Error("Missing test wallet");
    }
  });
});
