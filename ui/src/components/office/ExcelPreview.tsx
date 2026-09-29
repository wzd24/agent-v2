import React from "react";
import Spreadsheet from "x-data-spreadsheet";
import "x-data-spreadsheet/dist/xspreadsheet.css";
import * as XLSX from "xlsx";
import { loadFileBytes } from "./loadFileBytes";

type SheetRows = { name?: string; rows?: string[][] };

function sheetsFromRows(sheets: SheetRows[]) {
  return sheets.map((sheet, index) => {
    const rows = sheet.rows || [];
    const data: Record<string, any> = { name: sheet.name || `Sheet${index + 1}`, rows: {}, cols: { len: 26 } };
    let maxCol = 0;
    rows.forEach((row, rowIndex) => {
      const cells: Record<number, { text: string }> = {};
      (row || []).forEach((cell, colIndex) => {
        cells[colIndex] = { text: String(cell ?? "") };
        maxCol = Math.max(maxCol, colIndex + 1);
      });
      data.rows[rowIndex] = { cells };
    });
    data.rows.len = Math.max(rows.length + 20, 40);
    data.cols.len = Math.max(maxCol + 4, 16);
    return data;
  });
}

function sheetsFromWorkbook(buffer: ArrayBuffer) {
  const book = XLSX.read(buffer, { type: "array", cellDates: true });
  return book.SheetNames.map((name) => {
    const sheet = book.Sheets[name];
    const range = XLSX.utils.decode_range(sheet["!ref"] || "A1");
    const rows: Record<number, { cells: Record<number, { text: string }> }> = {};
    for (let row = range.s.r; row <= range.e.r; row += 1) {
      const cells: Record<number, { text: string }> = {};
      for (let col = range.s.c; col <= range.e.c; col += 1) {
        const cell = sheet[XLSX.utils.encode_cell({ r: row, c: col })];
        if (!cell) continue;
        const text = cell.w != null ? String(cell.w) : cell.v == null ? "" : String(cell.v);
        if (text) cells[col] = { text };
      }
      rows[row] = { cells };
    }
    return {
      name,
      rows: { ...rows, len: Math.max(range.e.r + 21, 40) },
      cols: { len: Math.max(range.e.c + 5, 16) },
    };
  });
}

export default function ExcelPreview({ path, sheets }: { path: string; sheets?: SheetRows[] }) {
  const hostRef = React.useRef<HTMLDivElement>(null);
  const sheetsRef = React.useRef(sheets);
  sheetsRef.current = sheets;
  const [error, setError] = React.useState("");
  React.useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let cancelled = false;
    let grid: Spreadsheet | null = null;
    setError("");
    void (async () => {
      let data: Record<string, any>[] = [];
      try {
        data = sheetsFromWorkbook(await loadFileBytes(path));
      } catch (reason) {
        if (sheetsRef.current?.length) data = sheetsFromRows(sheetsRef.current);
        else throw reason;
      }
      if (cancelled || !hostRef.current) return;
      await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
      if (cancelled || !hostRef.current) return;
      hostRef.current.innerHTML = "";
      const width = () => hostRef.current?.clientWidth || 640;
      const height = () => Math.max(240, hostRef.current?.clientHeight || 480);
      grid = new Spreadsheet(hostRef.current, {
        mode: "read",
        showToolbar: true,
        showGrid: true,
        showContextmenu: false,
        showBottomBar: true,
        view: { height, width },
        row: { len: 40, height: 28 },
        col: { len: 16, width: 100, indexWidth: 46, minWidth: 40 },
      });
      grid.loadData((data.length ? data : [{ name: "Sheet1", rows: { len: 40 } }]) as unknown as Record<string, unknown>);
    })().catch((reason) => {
      if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason));
    });
    return () => {
      cancelled = true;
      grid = null;
      if (host) host.innerHTML = "";
    };
  }, [path]);
  return <div className="office-excel-host">
    {error && <div className="office-visual-status">{error}</div>}
    <div ref={hostRef} className="office-excel-grid" />
  </div>;
}
