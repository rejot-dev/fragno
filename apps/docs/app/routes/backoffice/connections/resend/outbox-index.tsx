export default function BackofficeOrganisationResendOutboxIndex() {
  return (
    <div className="flex h-full flex-col justify-center gap-2 text-sm text-[var(--bo-muted)]">
      <p className="text-[10px] uppercase tracking-[0.24em] text-[var(--bo-muted-2)]">
        Email detail
      </p>
      <p>Select an email on the left to review delivery status and metadata.</p>
    </div>
  );
}
