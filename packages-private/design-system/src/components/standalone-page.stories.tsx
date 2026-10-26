import { Button } from "./button";
import { StandalonePage, StandalonePageAccount } from "./standalone-page";

export default { title: "Layout/Standalone page" };

export function AccountSetup() {
  return (
    <StandalonePage
      headerEnd={
        <StandalonePageAccount
          email="ada@example.com"
          signOut={
            <Button variant="ghost" type="button">
              Sign out
            </Button>
          }
        />
      }
      footer={
        <footer className="border-t border-[color:var(--bo-border)] px-12 py-6 text-xs text-[var(--bo-muted-2)]">
          © 2026 ReJot
        </footer>
      }
    >
      <div className="mx-auto flex w-full max-w-xl flex-1 flex-col justify-center gap-6 px-5 py-10">
        <div className="space-y-2">
          <h1 className="text-3xl leading-tight font-semibold">How will you use Backoffice?</h1>
          <p className="text-sm text-[var(--bo-muted)]">
            This decides what Backoffice sets up for you.
          </p>
        </div>
        <Button variant="accent" type="button" className="self-start">
          Continue
        </Button>
      </div>
    </StandalonePage>
  );
}
