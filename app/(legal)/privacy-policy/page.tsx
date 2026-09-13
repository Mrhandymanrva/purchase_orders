import type { Metadata } from "next";
import { legal } from "@/lib/legal";
import LegalContact from "../contact";

export const metadata: Metadata = {
  title: "Privacy Policy | Richmond Purchase Orders",
  description:
    "How Richmond Purchase Orders handles connected accounting data, card-user mappings, and audit records.",
};

export default function PrivacyPage() {
  return (
    <article className="legal-document">
      <p className="legal-eyebrow">RICHMOND PURCHASE ORDERS · LEGAL</p>
      <h1>Privacy Policy</h1>
      <p className="legal-subtitle">
        How information is handled in this workspace
      </p>
      <p className="legal-date">Effective {legal.effectiveDate}</p>
      <p className="legal-intro">
        This policy describes information handled by {legal.appName} (the
        “App”), operated by {legal.operator} (the “Operator”) for internal
        purchase reconciliation. It covers this hosted App, including its public
        policy pages, rather than the separate websites or services of
        ServiceTitan, Intuit, or other providers.
      </p>

      <section aria-labelledby="privacy-information">
        <h2 id="privacy-information">1. Information the App processes</h2>
        <ul>
          <li>
            <strong>QuickBooks data:</strong> authorized credit-card purchase
            and credit records, vendor names, amounts, dates, references, notes,
            account and subaccount IDs/names, and card-user fields when
            configured.
          </li>
          <li>
            <strong>ServiceTitan data:</strong> authorized purchase orders,
            vendor names, amounts, dates, summaries, references, business-unit
            identifiers, and technician, PO-type, and inventory-location IDs.
            Source directories supply employee/technician IDs, names, active
            status, and PO-type names.
          </li>
          <li>
            <strong>User-provided data:</strong> spreadsheet card mappings,
            assignment dates, employee identities, review reasons, manual
            decisions, rule settings, and other information entered into the
            App.
          </li>
          <li>
            <strong>Access and audit information:</strong> the configured
            operator identity, event times, changes, source evidence, import
            filenames and file hashes, and integration credentials needed for
            authorized access.
          </li>
          <li>
            <strong>Technical information:</strong> hosting and network systems
            may process IP addresses, browser/request metadata, requested URLs,
            timestamps, and error logs to deliver and protect the service.
          </li>
        </ul>
        <p>
          The App does not request full card numbers, card security codes,
          Social Security numbers, or bank login passwords. Free-text notes and
          uploads may contain information placed there by users or source
          systems; include only what is needed for reconciliation.
        </p>
      </section>
      <section aria-labelledby="privacy-uses">
        <h2 id="privacy-uses">2. How information is used</h2>
        <p>
          Information is used to retrieve authorized records, associate cards
          and POs with actual card users, normalize vendors, calculate matches
          and exceptions, prepare technician and Van Stock reports, maintain
          audit evidence, troubleshoot errors, and protect access. A successful
          sync stores an imported snapshot in the App’s database.
        </p>
        <p>
          The App uses deterministic matching logic. It does not send workspace
          data to an LLM service or use it to train AI models. Reports support
          human review; they do not independently establish employee misconduct
          or personal liability.
        </p>
      </section>
      <section aria-labelledby="privacy-sharing">
        <h2 id="privacy-sharing">3. Access and service providers</h2>
        <p>
          Authorized workspace operators and administrators can access business
          records, mappings, reports, and audit history. Technician filters
          organize reports; they are not separate access controls. People with
          workspace access may be able to view information about multiple
          technicians.
        </p>
        <p>
          Railway provides hosting and PostgreSQL infrastructure. ServiceTitan
          and Intuit process the authentication and API requests needed for
          their respective connections under their own policies. Authorized
          support personnel may access relevant information to operate or
          troubleshoot the App. Information may also be disclosed when legally
          required or necessary to protect the security and rights of the
          organization or users.
        </p>
        <p>
          The Operator does not sell App data or share it for targeted
          advertising. Downloaded CSV reports are stored wherever the user saves
          or sends them and are subject to the organization’s handling
          practices.
        </p>
      </section>
      <section aria-labelledby="privacy-storage">
        <h2 id="privacy-storage">4. Storage and security</h2>
        <p>
          The production workspace stores imported records, mappings, settings,
          and audit events in PostgreSQL on Railway. HTTPS protects browser
          connections, and the App requires authentication for business-data
          pages and APIs. Stored QuickBooks refresh tokens are encrypted; server
          credentials and encryption keys are maintained in the deployment’s
          configuration. Hosting administrators retain operational access.
        </p>
        <p>
          Uploaded mapping workbooks are processed to create a preview rather
          than retained as original files by the App. A signed preview
          containing parsed mapping data is returned to the browser and expires
          after 15 minutes. Approved mappings and associated audit evidence are
          saved. No system can guarantee absolute security.
        </p>
      </section>
      <section aria-labelledby="privacy-retention">
        <h2 id="privacy-retention">5. Retention and deletion</h2>
        <p>
          The current App has no automatic record-expiration schedule. Imported
          snapshots remain until replaced or removed through administrative
          handling. Mappings, decisions, and append-only audit evidence may
          remain after a source record changes or a connection ends. Retention
          depends on business recordkeeping needs, applicable obligations, and
          the organization’s retention decisions. Any retained backups follow
          their separately configured retention.
        </p>
        <p>
          Contact the Operator to request access, correction, export, or
          deletion of information. Requests require administrator handling;
          there is no self-service deletion control. The Operator may verify
          your identity and authority and may need to retain certain records for
          accounting, security, or legal obligations. Exported copies held by
          others must be addressed separately.
        </p>
      </section>
      <section aria-labelledby="privacy-connections">
        <h2 id="privacy-connections">6. Connected accounts and your choices</h2>
        <p>
          Your organization controls which ServiceTitan tenant, business units,
          QuickBooks company, and card subaccounts are connected. Administrators
          can stop future imports by removing integration access; an authorized
          QuickBooks administrator can also revoke the App’s connection in
          QuickBooks. Disconnecting stops authorized future access but does not
          automatically erase previously imported information.
        </p>
        <p>
          Correct underlying accounting or PO records in the relevant source
          system, then sync again. Correct App mappings through an authorized
          operator. These integrations read financial records and do not post
          changes back to ServiceTitan or QuickBooks.
        </p>
      </section>
      <section aria-labelledby="privacy-browser">
        <h2 id="privacy-browser">7. Browser data and intended audience</h2>
        <p>
          The App does not include advertising cookies, analytics trackers, or
          third-party marketing scripts. Browsers may temporarily retain
          authentication information, downloaded files, and page or preview
          data. Protect the device and follow your organization’s sign-out and
          access procedures when finished.
        </p>
        <p>
          Connecting QuickBooks sets a necessary security cookie for up to ten
          minutes to bind the authorization to your browser. The server stores
          hashed, single-use connection state with the initiating operator and
          selected environment; expired state cannot authorize a connection and
          is cleaned up when a new connection starts. The callback clears the
          cookie. Company identity, chosen card accounts, and connection audit
          events are retained with the workspace; authorization tokens remain
          encrypted on the server.
        </p>
        <p>
          The App is intended for authorized business users, not children or a
          public consumer audience. Applicable privacy rights depend on your
          location and relationship with the organization. This policy does not
          limit rights available under applicable law.
        </p>
      </section>
      <section aria-labelledby="privacy-contact">
        <h2 id="privacy-contact">8. Changes and contact</h2>
        <p>
          Updates to this policy will appear here with a revised effective date.
          Any additional notice or consent required by applicable law will be
          handled separately. The <a href="/eula">EULA</a> explains the terms
          for use of the App.
        </p>
        <LegalContact />
      </section>
    </article>
  );
}
