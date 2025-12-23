import { ArrowUpRight } from "lucide-react";
import { Link } from "react-router";

export function FormsDemoCallout() {
  return (
    <Link
      to="/forms"
      className="not-prose border-fd-border bg-fd-card hover:bg-fd-accent my-6 block rounded-lg border p-4 transition-colors"
    >
      <div className="flex items-center justify-between">
        <div>
          <div className="text-fd-foreground font-medium">Live demo</div>
          <div className="text-fd-muted-foreground text-sm">
            See the Form fragment combined with our shadcn/ui renderer in action
          </div>
        </div>
        <ArrowUpRight className="text-fd-muted-foreground" />
      </div>
    </Link>
  );
}
