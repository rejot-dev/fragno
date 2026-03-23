export default function BackofficeOrganisationResendDomainsIndex() {
  return (
    <div className="flex h-full flex-col justify-center gap-2 text-sm text-[var(--bo-muted)]">
      <p className="text-[10px] tracking-[0.24em] text-[var(--bo-muted-2)] uppercase">
        Domain detail
      </p>
      <p>Select a domain on the left to inspect capabilities and DNS records.</p>
    </div>
  );
}
