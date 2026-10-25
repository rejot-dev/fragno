import { useState } from "react";

import { Button } from "./button";
import { Dialog } from "./dialog";
import { Field } from "./field";
import { Input } from "./input";

export default { title: "Overlays/Dialog" };

export function AddRecord() {
  const [open, setOpen] = useState(true);
  return (
    <>
      <Button
        variant="solid"
        onClick={() => {
          setOpen(true);
        }}
      >
        New journal
      </Button>
      <Dialog
        open={open}
        onOpenChange={setOpen}
        title="New journal"
        description="Entries are numbered per journal, without gaps."
      >
        <form className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-[8rem_1fr]">
            <Field label="Code">
              <Input className="w-full" name="code" />
            </Field>
            <Field label="Name">
              <Input className="w-full" name="name" />
            </Field>
          </div>
          <div className="flex justify-end gap-2">
            <Button
              variant="ghost"
              onClick={() => {
                setOpen(false);
              }}
            >
              Cancel
            </Button>
            <Button variant="solid">Add journal</Button>
          </div>
        </form>
      </Dialog>
    </>
  );
}
