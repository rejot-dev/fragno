import type { CellProps, WithClassname } from "@jsonforms/core";
import { memo, useMemo, useState } from "react";
import { ChevronDownIcon } from "../icons/ChevronDown";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { formatTimeFromDate } from "../util/date-time";

type ShadcnDateTimePickerProps = CellProps & WithClassname;

function parseDateTime(value: string | undefined): { date: Date | undefined; time: string } {
  if (!value) {
    return { date: undefined, time: "" };
  }

  const dateTime = new Date(value);
  if (isNaN(dateTime.getTime())) {
    return { date: undefined, time: "" };
  }

  return {
    date: dateTime,
    time: formatTimeFromDate(dateTime),
  };
}

function formatDateTimeForSave(date: Date | undefined, time: string): string | undefined {
  if (!date) {
    return undefined;
  }

  const [hours, minutes] = time ? time.split(":").map(Number) : [0, 0];
  const dateTime = new Date(date);
  dateTime.setHours(hours || 0, minutes || 0, 0, 0);

  return dateTime.toISOString();
}

export const ShadcnDateTimePicker = memo(function ShadcnDateTimePicker(
  props: ShadcnDateTimePickerProps,
) {
  const { data, className, id, enabled, path, handleChange } = props;
  const [open, setOpen] = useState(false);

  const { date: selectedDate, time: selectedTime } = useMemo(() => parseDateTime(data), [data]);

  const handleDateSelect = (date: Date | undefined) => {
    handleChange(path, formatDateTimeForSave(date, selectedTime || "00:00"));
    setOpen(false);
  };

  const handleTimeChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const newTime = e.target.value;
    handleChange(path, formatDateTimeForSave(selectedDate, newTime));
  };

  return (
    <div className={cn("flex gap-2", className)}>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            id={id}
            variant="outline"
            disabled={!enabled}
            className={cn(
              "flex-1 justify-between font-normal",
              !selectedDate && "text-muted-foreground",
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
            onSelect={handleDateSelect}
          />
        </PopoverContent>
      </Popover>
      <Input
        type="time"
        value={selectedTime}
        onChange={handleTimeChange}
        disabled={!enabled}
        className="bg-background w-28 appearance-none [&::-webkit-calendar-picker-indicator]:hidden [&::-webkit-calendar-picker-indicator]:appearance-none"
      />
    </div>
  );
});
