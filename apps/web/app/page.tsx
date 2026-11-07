import Link from "next/link";

export default function Landing() {
  return (
    <div>
      <header className="topbar">
        <div className="brand"><span className="mark">⬡</span> Lifeboat</div>
        <div className="spacer" />
        <Link className="btn btn-primary" href="/app">Open app</Link>
      </header>

      <main style={{ maxWidth: 820, margin: "0 auto", padding: "72px 24px 90px" }}>
        <section className="hero">
          <h1>Your money survives a stolen key.</h1>
          <p className="lede">
            Lifeboat is a smart-account vault with two keys. Your everyday wallet can only start a
            slow, cancelable withdrawal. A separate quantum-safe key can veto it or move funds
            instantly. Someone who steals your everyday key — even a future quantum computer that
            breaks it — still can't take your money.
          </p>
          <div className="actions">
            <Link className="btn btn-primary btn-lg" href="/app">Create a vault</Link>
          </div>
          <div className="rule" />
        </section>

        <section style={{ margin: "8px 0 56px" }}>
          <div className="keys">
            <div className="keycard hot">
              <div className="role"><span className="pip" />Everyday key</div>
              <div className="can">Your normal wallet. Can only open a timelocked withdrawal that anyone can see and cancel. It can never move funds on its own.</div>
            </div>
            <div className="keycard pq">
              <div className="role"><span className="pip" />Quantum-safe key</div>
              <div className="can">A hash-based key no quantum computer can forge. Vetoes a bad withdrawal, moves funds instantly, or rotates itself. Held on your device.</div>
            </div>
          </div>
        </section>

        <section>
          <div className="section-head"><h1 style={{ fontSize: 24 }}>How an attack plays out</h1></div>
          <div className="stack">
            <div className="listrow"><div className="meta">An attacker steals your everyday key and calls for a withdrawal.<div className="sub">It only enters a pending, timelocked state — nothing moves.</div></div></div>
            <div className="listrow"><div className="meta">You get alerted and veto it with your quantum-safe key.<div className="sub">The vault verifies a real post-quantum signature on-chain and cancels the withdrawal.</div></div></div>
            <div className="listrow done"><div className="meta">The funds stay put. Optionally, you revoke the stolen key for good.<div className="sub">The attacker is left holding a key that can't do anything.</div></div></div>
          </div>
        </section>

        <section style={{ marginTop: 56 }}>
          <div className="panel">
            <h3>Useful today, not just for Q-day</h3>
            <p className="sub" style={{ marginBottom: 0 }}>
              The same two-key design stops today's wallet drains — phishing, malicious approvals,
              compromised seeds. Set a daily limit so small payments stay instant and large ones are
              held for review. Add a guardian (a hardware wallet or a friend) that can veto with an
              ordinary signature. Name a beneficiary who can recover the vault if you go silent.
            </p>
          </div>
        </section>

        <p className="field help" style={{ marginTop: 44, textAlign: "center" }}>
          A research project for post-quantum account security. Runs on Sepolia or a local devnet.
        </p>
      </main>
    </div>
  );
}
