import { ActionItem, ActionItemLink } from "./action-item";

export default { title: "Controls/Action item" };

export function NextSteps() {
  return (
    <div className="flex max-w-xs flex-col gap-1.5 bg-[var(--bo-panel)] p-4">
      <ActionItem icon="share-2" emphasis="primary">
        Create a workflow
      </ActionItem>
      <ActionItemLink to="#done" icon="check" emphasis="quiet">
        Done
      </ActionItemLink>
      <ActionItem icon="log-in" emphasis="primary" disabled>
        Connect Gmail
      </ActionItem>
    </div>
  );
}
