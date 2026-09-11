import { FileBlob, SpreadsheetFile } from "@oai/artifact-tool";

const inputPath = "/Users/michael/Downloads/Warehouse move to 400 UAT.xlsx";
const input = await FileBlob.load(inputPath);
const workbook = await SpreadsheetFile.importXlsx(input);

const summary = await workbook.inspect({
  kind: "workbook,sheet,table,definedName",
  maxChars: 18000,
  tableMaxRows: 12,
  tableMaxCols: 20,
  tableMaxCellChars: 120,
});
console.log(summary.ndjson);
