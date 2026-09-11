import { FileBlob, SpreadsheetFile } from "@oai/artifact-tool";
const input = await FileBlob.load("/Users/michael/Downloads/Warehouse move to 400 UAT.xlsx");
const workbook = await SpreadsheetFile.importXlsx(input);
for (const spec of [
  ["WH 440 before transfer", "A2:Q473", (r) => String(r[10] ?? "").startsWith("Missing")],
  ["WH 400 after transfer", "A2:Q355", (r) => ["H1-A081", "H1-A071", "H1-A031", "H1-B051", "H1-B130"].includes(r[8])],
]) {
  const [name, address, predicate] = spec;
  const rows = workbook.worksheets.getItem(name).getRange(address).values;
  console.log(name);
  rows.forEach((row, i) => { if (predicate(row)) console.log(JSON.stringify({ excelRow: i + 2, row })); });
}
