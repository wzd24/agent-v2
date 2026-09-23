import assert from "node:assert/strict";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const office = require(path.join(root, "src-tauri/mcp/office.cjs"));
const notebook = require(path.join(root, "src-tauri/mcp/notebook.cjs"));

const doc = office.readAny("note.docx", office.createDocument({ title: "报告", body: "# 标题\n一段话" }));
assert.equal(doc.kind, "document");
assert.match(doc.text, /标题/);

const sheet = office.readAny(
  "data.xlsx",
  office.createSpreadsheet({ sheets: [{ name: "数据", rows: [["姓名"], ["李四"]] }] }),
);
assert.equal(sheet.kind, "spreadsheet");
assert.equal(sheet.sheets[0].rows[1][0], "李四");

const deck = office.readAny("talk.pptx", office.createPresentation({ slides: [{ title: "封面", bullets: ["要点"] }] }));
assert.equal(deck.kind, "presentation");
assert.match(deck.slides[0].text, /封面/);

const pdf = office.readAny("manual.pdf", office.createPdf({ title: "手册", body: "第一页" }));
assert.equal(pdf.kind, "pdf");
assert.match(pdf.text, /第一页/);

const nb = notebook.previewNotebook(
  notebook.createNotebook({
    title: "分析",
    cells: [
      { cell_type: "markdown", source: "# 分析\n" },
      { cell_type: "code", source: "print(1)\n" },
    ],
  }),
);
assert.equal(nb.kind, "notebook");
assert.equal(nb.cells.length, 2);
assert.equal(nb.cells[1].type, "code");
assert.match(nb.text, /print\(1\)/);

console.log("preview-smoke ok");
