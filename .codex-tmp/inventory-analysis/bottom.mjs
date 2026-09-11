import { FileBlob, SpreadsheetFile } from "@oai/artifact-tool";

const input = await FileBlob.load("/Users/michael/Downloads/Warehouse move to 400 UAT.xlsx");
const workbook = await SpreadsheetFile.importXlsx(input);
for (const [sheetId, range] of [
  ["WH 440 before transfer", "A468:Q474"],
  ["Transfer Journal InventTrans", "A914:S920"],
  ["WH 400 after transfer", "A350:Q356"],
]) {
  const report = await workbook.inspect({
    kind: "table,formula",
    sheetId,
    range,
    include: "values,formulas",
    maxChars: 12000,
    tableMaxRows: 10,
    tableMaxCols: 20,
    options: { maxResults: 50 },
  });
  console.log(`--- ${sheetId} ${range} ---`);
  console.log(report.ndjson);
}
