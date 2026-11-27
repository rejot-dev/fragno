import { AgentFace } from "./agent-face";

export default { title: "Brand/Agent face" };

// As the top bar's agent button: hover it to see the face smile, and move the mouse near it to
// see the eyes follow.
export function InButton() {
  return (
    <button
      type="button"
      aria-label="Open agent"
      className="flex h-16 w-16 cursor-pointer items-center justify-center border border-[color:var(--bo-border)] hover:bg-[var(--bo-panel-2)]"
    >
      <AgentFace size="bar" motion="lively" />
    </button>
  );
}

// As a message's face while its turn loads.
export function Thinking() {
  return <AgentFace size="message" motion="thinking" />;
}
