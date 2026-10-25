import { Button } from "./button";
import { Field } from "./field";
import { Input } from "./input";
import { ListRow, RowList } from "./list-row";
import { BackofficeStatusLight } from "./status-light";
import {
  SurfaceFacts,
  SurfacePanel,
  SurfacePanelBody,
  SurfacePanelFooter,
  SurfacePanelRows,
  SurfaceSection,
  SurfaceTable,
  SurfaceTableGroupRow,
  SurfaceTableRow,
  SurfaceTableTotalRow,
  type SurfaceTableColumn,
} from "./surface-panel";
import { BackofficeSystemState } from "./system-state";

export default { title: "Data/Surface panel" };

const columns: SurfaceTableColumn[] = [
  { label: "Member", align: "start" },
  { label: "Roles", align: "start" },
  { label: "Joined", align: "end" },
];

export function Table() {
  return (
    <div className="max-w-3xl">
      <SurfacePanel
        caption="2 members"
        actions={<Input type="search" aria-label="Search" placeholder="Search" />}
      >
        <SurfaceTable columns={columns}>
          <SurfaceTableRow
            columns={columns}
            cells={[
              <span key="name" className="font-semibold text-[var(--bo-fg)]">
                Ada Lovelace
              </span>,
              "owner",
              "Oct 22, 2026",
            ]}
          />
          <SurfaceTableRow
            columns={columns}
            cells={[
              <span key="name" className="font-semibold text-[var(--bo-fg)]">
                Alan Turing
              </span>,
              "member",
              "Oct 23, 2026",
            ]}
          />
        </SurfaceTable>
        <SurfacePanelFooter>
          <Button variant="secondary">Previous</Button>
          <Button variant="secondary">Next</Button>
        </SurfacePanelFooter>
      </SurfacePanel>
    </div>
  );
}

export function Facts() {
  return (
    <div className="max-w-3xl">
      <SurfacePanel
        caption="Organization"
        actions={<BackofficeStatusLight tone="live">Active</BackofficeStatusLight>}
      >
        <SurfaceFacts
          items={[
            { key: "slug", label: "Slug", value: "acme" },
            { key: "roles", label: "Your roles", value: "owner" },
            { key: "created", label: "Created", value: "Oct 22, 2026" },
          ]}
        />
      </SurfacePanel>
    </div>
  );
}

export function Form() {
  return (
    <div className="max-w-3xl">
      <SurfacePanel caption="Rename organization" actions={null}>
        <SurfacePanelBody>
          <form className="flex max-w-xl flex-col gap-3">
            <Field label="Organization name">
              <Input defaultValue="Acme" className="w-full" />
            </Field>
            <Button variant="accent" type="submit" className="self-start">
              Save name
            </Button>
          </form>
        </SurfacePanelBody>
      </SurfacePanel>
    </div>
  );
}

export function Empty() {
  return (
    <div className="max-w-3xl">
      <SurfacePanel caption="0 invitations" actions={null}>
        <BackofficeSystemState
          tone="empty"
          title="No open invitations."
          description="Invite a teammate to share this organization."
          flush
        />
      </SurfacePanel>
    </div>
  );
}

export function Rows() {
  return (
    <div className="max-w-md">
      <SurfacePanel caption="2 runs" actions={null}>
        <SurfacePanelRows>
          <RowList empty="No runs yet.">
            <ListRow
              to="/runs/1"
              leading={null}
              title="reports/weekly.ts"
              detail="schedule · Oct 22, 2026, 9:00 AM"
              trailing={<BackofficeStatusLight tone="live">completed</BackofficeStatusLight>}
              expansion={null}
            />
            <ListRow
              to="/runs/2"
              leading={null}
              title="inline"
              detail="agent · Oct 22, 2026, 9:04 AM"
              trailing={<BackofficeStatusLight tone="failed">failed</BackofficeStatusLight>}
              expansion={null}
            />
          </RowList>
        </SurfacePanelRows>
      </SurfacePanel>
    </div>
  );
}

const ledgerColumns: SurfaceTableColumn[] = [
  { label: "Account", align: "start" },
  { label: "Debit", align: "end" },
  { label: "Credit", align: "end" },
];

export function Section() {
  return (
    <div className="max-w-3xl">
      <SurfaceSection
        title="Journal"
        meta="Sales · 2 entries"
        actions={<Button variant="solid">New entry</Button>}
      >
        <SurfaceTable columns={ledgerColumns}>
          <SurfaceTableGroupRow columns={ledgerColumns}>
            <span className="font-semibold">SAL 1</span> · 10 Mar 2026 · Invoice 2026-001
          </SurfaceTableGroupRow>
          <SurfaceTableRow
            columns={ledgerColumns}
            cells={["1300 Accounts receivable", "1,210.00", ""]}
          />
          <SurfaceTableRow columns={ledgerColumns} cells={["8000 Revenue", "", "1,000.00"]} />
          <SurfaceTableRow columns={ledgerColumns} cells={["1700 VAT payable", "", "210.00"]} />
          <SurfaceTableTotalRow columns={ledgerColumns} cells={["Total", "1,210.00", "1,210.00"]} />
        </SurfaceTable>
      </SurfaceSection>
    </div>
  );
}
