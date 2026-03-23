export default function BackofficeOrganisationResendIncomingIndex() {
  return (
    <div className="flex h-full flex-col justify-center gap-2 text-sm text-[var(--bo-muted)]">
      <p className="text-[10px] tracking-[0.24em] text-[var(--bo-muted-2)] uppercase">
        Incoming detail
      </p>
      <p>Select an incoming email on the left to inspect headers, bodies, and attachments.</p>
    </div>
  );
}
