import { FileBlob, SpreadsheetFile } from "@oai/artifact-tool";

const inputPath = "/Users/michael/Downloads/Warehouse move to 400 UAT.xlsx";
const input = await FileBlob.load(inputPath);
const workbook = await SpreadsheetFile.importXlsx(input);

function n(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function countNonZero(rows, indexes) {
  return rows.filter((row) => indexes.some((i) => Math.abs(n(row[i])) > 0.0000001)).length;
}

const beforeSheet = workbook.worksheets.getItem("WH 440 before transfer");
const journalSheet = workbook.worksheets.getItem("Transfer Journal InventTrans");
const afterSheet = workbook.worksheets.getItem("WH 400 after transfer");

const before = beforeSheet.getUsedRange().values;
const journal = journalSheet.getUsedRange().values;
const after = afterSheet.getUsedRange().values;

const beforeRows = before.slice(1);
const journalRows = journal.slice(1);
const afterRows = after.slice(1);

const sum = (rows, index) => rows.reduce((total, row) => total + n(row[index]), 0);
const grouped = new Map();
for (const row of journalRows) {
  const key = `${row[12]}|${row[13]}|${row[5] || ""}|${row[6] || ""}`;
  const curr = grouped.get(key) || { rows: 0, quantity: 0, cost: 0 };
  curr.rows += 1;
  curr.quantity += n(row[7]);
  curr.cost += n(row[11]);
  grouped.set(key, curr);
}

const result = {
  before: {
    rows: beforeRows.length,
    financialCost: sum(beforeRows, 3),
    physicalCost: sum(beforeRows, 4),
    totalCost: sum(beforeRows, 3) + sum(beforeRows, 4),
    rowsWithInventory: countNonZero(beforeRows, [12, 13, 14, 15]),
    rowsWithCost: countNonZero(beforeRows, [3, 4]),
  },
  journal: {
    rows: journalRows.length,
    totalQuantity: sum(journalRows, 7),
    totalCost: sum(journalRows, 11),
    grouped: Object.fromEntries(grouped),
  },
  after: {
    rows: afterRows.length,
    financialCost: sum(afterRows, 3),
    physicalCost: sum(afterRows, 4),
    totalCost: sum(afterRows, 3) + sum(afterRows, 4),
    rowsWithInventory: countNonZero(afterRows, [12, 13, 14, 15]),
    rowsWithCost: countNonZero(afterRows, [3, 4]),
  },
};

console.log(JSON.stringify(result, null, 2));

const beforeItems = new Map();
for (const row of beforeRows) {
  const key = String(row[0] ?? "");
  const curr = beforeItems.get(key) || { financial: 0, physical: 0, rows: 0 };
  curr.financial += n(row[3]);
  curr.physical += n(row[4]);
  curr.rows += 1;
  beforeItems.set(key, curr);
}
const afterItems = new Map();
for (const row of afterRows) {
  const key = String(row[0] ?? "");
  const curr = afterItems.get(key) || { financial: 0, physical: 0, rows: 0 };
  curr.financial += n(row[3]);
  curr.physical += n(row[4]);
  curr.rows += 1;
  afterItems.set(key, curr);
}
const diffs = [...new Set([...beforeItems.keys(), ...afterItems.keys()])]
  .map((item) => ({
    item,
    before: (beforeItems.get(item)?.financial || 0) + (beforeItems.get(item)?.physical || 0),
    after: (afterItems.get(item)?.financial || 0) + (afterItems.get(item)?.physical || 0),
  }))
  .map((x) => ({ ...x, difference: x.after - x.before }))
  .filter((x) => Math.abs(x.difference) > 0.005)
  .sort((a, b) => Math.abs(b.difference) - Math.abs(a.difference));
console.log(JSON.stringify({ itemDifferenceCount: diffs.length, largestItemDifferences: diffs.slice(0, 30) }, null, 2));
