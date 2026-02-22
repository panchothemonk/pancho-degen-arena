import UpDownTerminal from "@/components/updown-terminal";

export default function Page() {
  return (
    <main className="shell">
      <section className="hero">
        <div className="hero-content">
          <div>
            <div className="hero-badge">
              <span className="hero-live-dot" aria-hidden="true" />
              SOL MAINNET LAUNCH COMING SOON
            </div>
            <h1>Pancho Degen Arena</h1>
            <p>
              PANCHO MAINNET ARENA is launching soon on Solana. Connect your wallet, pick <strong>BULL</strong> or{" "}
              <strong>BEAR</strong>, and run preview rounds with real oracle outcomes on SOL, BTC, and ETH.
            </p>
          </div>
          <div className="hero-art">
            <img src="/pancho-bull-bear.png?v=1" alt="Pancho bull vs bear" />
          </div>
        </div>
      </section>
      <UpDownTerminal />
      <section className="notes">
        <p>
          Preview mode uses Pancho Bucks. Entry closes every 60s and settles 5m after lock. Tap Payout Math for simple pool examples.
        </p>
      </section>
    </main>
  );
}
