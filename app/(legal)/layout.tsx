import LegalLinks from "../legal-links";
import { legal } from "@/lib/legal";

export default function LegalLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="legal-shell">
      <header className="legal-header">
        <a className="legal-brand" href="/">
          {legal.appName}
        </a>
        <LegalLinks />
      </header>
      <main className="legal-main">{children}</main>
      <footer className="legal-footer">
        <span>{legal.operator}</span>
        <a href="/">Return to app</a>
      </footer>
    </div>
  );
}
