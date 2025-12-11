import type { CellProps, WithClassname } from "@jsonforms/core";
import { memo, useMemo, useState } from "react";
import { ChevronDownIcon } from "../icons/ChevronDown";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { formatDateForSave, parseDate } from "../util/date-time";

type ShadcnDatePickerProps = CellProps & WithClassname;

export const ShadcnDatePicker = memo(function ShadcnDatePicker(props: ShadcnDatePickerProps) {
  const { data, className, id, enabled, path, handleChange } = props;
  const [open, setOpen] = useState(false);

  const selectedDate = useMemo(() => parseDate(data), [data]);

  const handleSelect = (date: Date | undefined) => {
    handleChange(path, formatDateForSave(date));
    setOpen(false);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          id={id}
          variant="outline"
          disabled={!enabled}
          className={cn(
            "w-full justify-between font-normal",
            !selectedDate && "text-muted-foreground",
            className,
          )}
        >
          {selectedDate ? selectedDate.toLocaleDateString() : "Select date"}
          <ChevronDownIcon />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-auto overflow-hidden p-0" align="start">
        <Calendar
          mode="single"
          selected={selectedDate}
          captionLayout="dropdown"
          onSelect={handleSelect}
        />
      </PopoverContent>
    </Popover>
  );
});
