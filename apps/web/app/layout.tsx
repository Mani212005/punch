import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Punch - Multi-Agent System",
  description: "Agents that plan, delegate, and take over for each other. Runs on your machine.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="bz">{children}</body>
    </html>
  );
}
