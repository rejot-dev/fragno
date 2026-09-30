import { BackofficeFragmentMark } from "./fragment-mark";

export default { title: "Brand/Fragment mark" };

export function Palettes() {
  return (
    <div className="flex items-center gap-6">
      <BackofficeFragmentMark palette="system" size="md" />
      <BackofficeFragmentMark palette="blue" size="md" />
      <BackofficeFragmentMark palette="grey" size="md" />
    </div>
  );
}

export function Variants() {
  return (
    <div className="flex items-center gap-6">
      <BackofficeFragmentMark variant={1} size="md" />
      <BackofficeFragmentMark variant={2} size="md" />
      <BackofficeFragmentMark variant={3} size="md" />
      <BackofficeFragmentMark variant={4} size="md" />
    </div>
  );
}

export function Animated() {
  return <BackofficeFragmentMark animated size="md" />;
}
