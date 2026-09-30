import feather, { type FeatherIconNames } from "feather-icons";

export type IconName = FeatherIconNames;

export function Icon({
  name,
  className,
  strokeWidth = 2,
}: {
  name: IconName;
  className?: string;
  strokeWidth?: number;
}) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
      // Feather ships each icon as trusted inner SVG markup from the package itself.
      dangerouslySetInnerHTML={{ __html: feather.icons[name].contents }}
    />
  );
}
