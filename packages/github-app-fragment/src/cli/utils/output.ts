export const printResult = (value: unknown) => {
  if (value === undefined) {
    console.log("OK");
    return;
  }
  console.log(JSON.stringify(value, null, 2));
};
