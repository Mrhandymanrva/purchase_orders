import "./globals.css";
export const metadata = {
  title: "Richmond | Purchase reconciliation",
  description: "ServiceTitan and QuickBooks purchase reconciliation",
  icons: { icon: "/favicon.svg" },
};
export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
