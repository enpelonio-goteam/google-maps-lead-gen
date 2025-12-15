import type { ReactNode } from "react";

export const metadata = {
  title: "Google Maps Lead Gen API",
  description: "Single endpoint API for batch-deduped Google Maps results via SerpApi."
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body style={{ fontFamily: "system-ui, sans-serif", padding: 24 }}>{children}</body>
    </html>
  );
}


