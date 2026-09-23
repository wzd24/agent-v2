import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const office = require(path.join(root, "src-tauri/mcp/office.cjs"));
const pdfFont = require(path.join(root, "src-tauri/mcp/pdf-font.cjs"));

function rpc(child, message) {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(() => {
      child.stdout.off("data", onData);
      reject(new Error(`timeout waiting for ${message.method}`));
    }, 15000);
    const onData = (chunk) => {
      buffer += chunk;
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || "";
      for (const line of lines) {
        if (!line.trim()) continue;
        let payload;
        try {
          payload = JSON.parse(line);
        } catch {
          continue;
        }
        if (payload.id !== message.id) continue;
        clearTimeout(timer);
        child.stdout.off("data", onData);
        if (payload.error) return reject(new Error(payload.error.message || "RPC error"));
        resolve(payload.result);
      }
    };
    child.stdout.on("data", onData);
    child.stdin.write(`${JSON.stringify(message)}\n`);
  });
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "local-codex-office-"));
const doc = office.createDocument({ title: "报告", body: "# 标题\n一段话\n- 要点" });
const readDoc = office.readDocument(doc);
assert.match(readDoc.text, /标题/);
assert.match(readDoc.text, /要点/);

const sheet = office.createSpreadsheet({
  title: "表",
  sheets: [{ name: "数据", rows: [["姓名", "分数"], ["张三", "90"]] }],
});
assert.equal(office.readSpreadsheet(sheet).sheets[0].rows[1][0], "张三");

const deck = office.createPresentation({ title: "演示", slides: [{ title: "封面", bullets: ["第一点"] }] });
assert.match(office.readPresentation(deck).text, /封面/);

const pdf = office.createPdf({ title: "手册", body: "第一行\n第二行" });
assert.equal(office.readPdf(pdf).pages >= 1, true);
assert.match(office.readPdf(pdf).text, /第一行/);
assert.equal(office.verifyPdf(pdf).ok, true);
if (pdfFont.findCjkFont()) {
  const latin = pdf.toString("latin1");
  assert.match(latin, /\/FontFile2/);
  assert.match(latin, /\/Identity-H/);
}
const english = office.createPdf({ title: "Manual", body: "Hello line" });
assert.match(office.readPdf(english).text, /Hello line/);

const replaced = office.replaceText(doc, "document", [{ from: "要点", to: "结论" }]);
assert.match(office.readDocument(replaced).text, /结论/);

const contextFile = path.join(tmp, "context.json");
fs.writeFileSync(contextFile, JSON.stringify({ cwd: tmp, codexHome: tmp }), "utf8");
const child = spawn(process.execPath, [path.join(root, "src-tauri/mcp/office-mcp.cjs")], {
  env: { ...process.env, LOCAL_CODEX_OFFICE_CONTEXT: contextFile },
  stdio: ["pipe", "pipe", "pipe"],
  windowsHide: true,
});
try {
  const initialized = await rpc(child, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "smoke", version: "0" } },
  });
  assert.equal(initialized.serverInfo.name, "local-codex-office");
  const listed = await rpc(child, { jsonrpc: "2.0", id: 2, method: "tools/list" });
  const names = listed.tools.map((item) => item.name);
  assert.ok(names.includes("office_create_document"));
  assert.ok(names.includes("office_apply_template"));
  const created = await rpc(child, {
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: { name: "office_create_document", arguments: { path: "note.docx", title: "笔记", body: "hello office" } },
  });
  assert.match(created.content[0].text, /note\.docx/);
} finally {
  child.kill();
}

console.log("office-smoke ok");
