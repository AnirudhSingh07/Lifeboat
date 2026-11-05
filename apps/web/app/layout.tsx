import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Lifeboat — quantum-veto vault",
  description:
    "Your everyday ECDSA key can only start timelocked withdrawals; a post-quantum key can veto them or move funds instantly. A quantum attacker who steals your key still can't take your money.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
