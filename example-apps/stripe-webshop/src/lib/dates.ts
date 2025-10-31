export const formatDate = (date: Date | number | string | null | undefined) => {
  if (!date) {
    return "N/A";
  }

  let dateObj: Date;
  if (typeof date === "number") {
    dateObj = new Date(date);
  } else if (typeof date === "string") {
    dateObj = new Date(date);
  } else {
    dateObj = date;
  }

  // Check if the date is valid
  if (isNaN(dateObj.getTime())) {
    return "Invalid Date";
  }

  return dateObj.toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
};
