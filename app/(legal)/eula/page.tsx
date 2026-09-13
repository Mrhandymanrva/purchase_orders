import type { Metadata } from "next";
import { legal } from "@/lib/legal";
import LegalContact from "../contact";

export const metadata: Metadata = {
  title: "EULA | Richmond Purchase Orders",
  description:
    "End User License Agreement for the Richmond Purchase Orders reconciliation app.",
};

export default function EulaPage() {
  return (
    <article className="legal-document">
      <p className="legal-eyebrow">RICHMOND PURCHASE ORDERS · LEGAL</p>
      <h1>EULA</h1>
      <p className="legal-subtitle">End User License Agreement</p>
      <p className="legal-date">Effective {legal.effectiveDate}</p>
      <p className="legal-intro">
        These terms govern access to {legal.appName} (the “App”), operated by{" "}
        {legal.operator} (the “Operator”) for authorized business users. By
        using the App, you agree to these terms. If you do not agree, do not use
        the App and contact your workspace administrator.
      </p>

      <section aria-labelledby="eula-license">
        <h2 id="eula-license">1. Permission to use the App</h2>
        <p>
          The Operator grants you a limited, non-exclusive, non-transferable
          permission to access the hosted App for the internal business purposes
          authorized by your organization. You must have permission to access
          the workspace and any connected ServiceTitan or QuickBooks company.
          You may not grant access to anyone your organization has not
          authorized.
        </p>
      </section>
      <section aria-labelledby="eula-purpose">
        <h2 id="eula-purpose">
          2. Reconciliation and your responsibility to review
        </h2>
        <p>
          The App compares posted QuickBooks credit-card purchases with
          ServiceTitan purchase orders, assigns card users, and produces
          reconciliation results and technician reports. Matching uses
          deterministic rules and confidence scores. A score is a policy result,
          not a guarantee that a match is correct.
        </p>
        <p>
          You are responsible for verifying source data, card assignments,
          reporting periods, exceptions, overrides, and rules before relying on
          a report. Missing or incomplete source data can affect totals. Reports
          alone do not establish employee misconduct, personal liability, or a
          basis for payroll deductions. The App does not provide accounting,
          tax, legal, or employment advice.
        </p>
      </section>
      <section aria-labelledby="eula-integrations">
        <h2 id="eula-integrations">3. Connected services</h2>
        <p>
          The App reads financial records from ServiceTitan and QuickBooks; it
          does not create, edit, delete, pay, or post transactions in those
          systems. Saving a mapping, override, or rule changes this App’s
          records. Authentication and token refresh are required to maintain
          connections.
        </p>
        <p>
          Your organization must obtain and maintain the necessary
          subscriptions, permissions, and authorizations. ServiceTitan, Intuit,
          and hosting providers have their own terms and policies. Their
          availability, restrictions, or changes may interrupt this App. The App
          is not endorsed by ServiceTitan or Intuit; their names and trademarks
          belong to their respective owners.
        </p>
      </section>
      <section aria-labelledby="eula-conduct">
        <h2 id="eula-conduct">4. Authorized and secure use</h2>
        <p>
          Protect your access credentials and exported reports. Submit only
          information you are authorized to use, and keep card-user assignments
          accurate. Do not bypass access controls, tamper with audit records,
          introduce malicious content, disrupt the service, or use the App for
          unlawful purposes. Do not upload full payment-card numbers, security
          codes, bank login credentials, or unrelated sensitive information.
        </p>
      </section>
      <section aria-labelledby="eula-data">
        <h2 id="eula-data">5. Business data and privacy</h2>
        <p>
          Your organization and other rights holders retain their rights in
          submitted and connected data. You authorize the processing necessary
          to operate the App, including matching, storage, reporting, and audit
          history. Data handling is described in the{" "}
          <a href="/privacy-policy">Privacy Policy</a>. These terms do not
          transfer rights in third-party software or replace any applicable
          open-source licenses.
        </p>
      </section>
      <section aria-labelledby="eula-availability">
        <h2 id="eula-availability">6. Availability and limitations</h2>
        <p>
          To the extent permitted by applicable law, the App is provided “as is”
          and “as available,” without warranties of uninterrupted operation,
          completeness, accuracy, merchantability, or fitness for a particular
          purpose. Keep required accounting records in your source systems and
          follow your organization’s backup and review procedures.
        </p>
        <p>
          To the extent permitted by applicable law, the Operator is not liable
          for indirect, incidental, special, or consequential losses arising
          from use of the App. Nothing in these terms excludes rights or
          liabilities that cannot lawfully be excluded.
        </p>
      </section>
      <section aria-labelledby="eula-ending">
        <h2 id="eula-ending">7. Access changes and termination</h2>
        <p>
          The Operator may suspend or end access when authorization ends, these
          terms are breached, or security, legal, or operational needs require
          it. You may stop using the App at any time. Ending access does not
          automatically delete retained business or audit records. Revoking a
          source connection and requesting deletion are separate actions;
          contact your administrator for assistance.
        </p>
      </section>
      <section aria-labelledby="eula-updates">
        <h2 id="eula-updates">8. Updates and contact</h2>
        <p>
          The Operator may update these terms by publishing a revised version
          and effective date on this page. Any notice or agreement required by
          applicable law remains required.
        </p>
        <LegalContact />
      </section>
    </article>
  );
}
