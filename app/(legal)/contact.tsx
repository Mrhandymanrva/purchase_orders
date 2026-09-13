import { legal } from "@/lib/legal";

export default function LegalContact() {
  return (
    <p>
      For questions about these terms, privacy requests, or security concerns,
      contact {legal.operator}
      {legal.contactEmail ? (
        <>
          {" "}
          at <a href={`mailto:${legal.contactEmail}`}>{legal.contactEmail}</a>.
        </>
      ) : (
        <>
          {" "}
          through your Richmond Purchase Orders workspace administrator, using
          your usual company support channel.
        </>
      )}{" "}
      Include the nature of your request and enough information to identify the
      relevant workspace or records. Do not send passwords, access tokens, full
      card numbers, or card security codes.
    </p>
  );
}
