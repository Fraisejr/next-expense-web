import { FileBlob, SpreadsheetFile } from "@oai/artifact-tool";

const input = await FileBlob.load("/Users/michael/Downloads/Warehouse move to 400 UAT.xlsx");
const workbook = await SpreadsheetFile.importXlsx(input);
const before = workbook.worksheets.getItem("WH 440 before transfer").getRange("A2:Q473").values;
const journal = workbook.worksheets.getItem("Transfer Journal InventTrans").getRange("A2:S919").values;
const after = workbook.worksheets.getItem("WH 400 after transfer").getRange("A2:Q355").values;
const n = (v) => typeof v === "number" && Number.isFinite(v) ? v : 0;
const sum = (rows, i) => rows.reduce((a, r) => a + n(r[i]), 0);

const issues = journal.filter((r) => r[13] === "440" && r[6] === "Sold");
const receipts = journal.filter((r) => r[13] === "400" && r[5] === "Purchased");

function group(rows, keyFn, qtyIndex, costFn) {
  const m = new Map();
  for (const row of rows) {
    const k = keyFn(row);
    const v = m.get(k) || { qty: 0, cost: 0, rows: 0 };
    v.qty += n(row[qtyIndex]);
    v.cost += costFn(row);
    v.rows++;
    m.set(k, v);
  }
  return m;
}

const beforeKey = (r) => [r[0], r[7], r[8], r[9], r[10], r[11], r[16]].map((x) => x ?? "").join("|");
const issueKey = (r) => [r[0], r[14], r[15], r[16], r[17], r[18], r[8]].map((x) => x ?? "").join("|");
const afterKey = (r) => [r[0], r[7], r[8], r[9], r[10], r[11], r[16]].map((x) => x ?? "").join("|");
const receiptKey = (r) => [r[0], r[14], r[15], r[16], r[17], r[18], r[8]].map((x) => x ?? "").join("|");

const beforeG = group(before, beforeKey, 12, (r) => n(r[3]) + n(r[4]));
const issueG = group(issues, issueKey, 7, (r) => n(r[11]));
const afterG = group(after, afterKey, 12, (r) => n(r[3]) + n(r[4]));
const receiptG = group(receipts, receiptKey, 7, (r) => n(r[11]));

function compare(a, b, bSign = 1) {
  const keys = new Set([...a.keys(), ...b.keys()]);
  const diffs = [];
  for (const k of keys) {
    const av = a.get(k) || { qty: 0, cost: 0 };
    const bv = b.get(k) || { qty: 0, cost: 0 };
    const qtyDiff = av.qty - bSign * bv.qty;
    const costDiff = av.cost - bSign * bv.cost;
    if (Math.abs(qtyDiff) > 1e-7 || Math.abs(costDiff) > 0.005) diffs.push({ k, a: av, b: bv, qtyDiff, costDiff });
  }
  return diffs;
}

const sourceDiffs = compare(beforeG, issueG, -1);
const receivingDiffs = compare(afterG, receiptG, 1);

console.log(JSON.stringify({
  before: { rows: before.length, qty: sum(before, 12), financial: sum(before, 3), physical: sum(before, 4), total: sum(before, 3) + sum(before, 4) },
  issues: { rows: issues.length, qty: sum(issues, 7), cost: sum(issues, 11) },
  receipts: { rows: receipts.length, qty: sum(receipts, 7), cost: sum(receipts, 11) },
  after: { rows: after.length, qty: sum(after, 12), financial: sum(after, 3), physical: sum(after, 4), total: sum(after, 3) + sum(after, 4) },
  sourceComparison: {
    keys: new Set([...beforeG.keys(), ...issueG.keys()]).size,
    diffs: sourceDiffs.length,
    qtyOnlyDiffs: sourceDiffs.filter((d) => Math.abs(d.qtyDiff) > 1e-7).length,
    costOnlyOrAnyDiffs: sourceDiffs.filter((d) => Math.abs(d.costDiff) > 0.005).length,
    sample: sourceDiffs.sort((x,y) => Math.abs(y.costDiff)-Math.abs(x.costDiff)).slice(0,10),
    quantityDifferences: sourceDiffs.filter((d) => Math.abs(d.qtyDiff) > 1e-7),
  },
  receivingComparison: {
    keys: new Set([...afterG.keys(), ...receiptG.keys()]).size,
    diffs: receivingDiffs.length,
    qtyOnlyDiffs: receivingDiffs.filter((d) => Math.abs(d.qtyDiff) > 1e-7).length,
    costOnlyOrAnyDiffs: receivingDiffs.filter((d) => Math.abs(d.costDiff) > 0.005).length,
    sample: receivingDiffs.sort((x,y) => Math.abs(y.costDiff)-Math.abs(x.costDiff)).slice(0,10),
  },
}, null, 2));
