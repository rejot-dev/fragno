import { OverflowTabRow } from "@fragno-private/design-system/overflow-tab-row";

type AutomationSubpageTab = {
  id: string;
  label: string;
  to: string;
  disabled?: boolean;
  onSelect?: () => void;
};

export function AutomationSubpageTabs({
  tabs,
  activeTab,
  ariaLabel,
}: {
  tabs: readonly AutomationSubpageTab[];
  activeTab: string;
  ariaLabel: string;
}) {
  const items = tabs.map((tab) => ({
    ...tab,
    active: activeTab === tab.id,
  }));

  return <OverflowTabRow items={items} ariaLabel={ariaLabel} variant="underline" trailing={null} />;
}
