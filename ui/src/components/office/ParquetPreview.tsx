import React from "react";
import { parquetMetadataAsync, parquetReadObjects } from "hyparquet";
import { loadFileBytes } from "./loadFileBytes";

const ROW_LIMIT = 300;

function fileBuffer(data: ArrayBuffer) {
  return {
    byteLength: data.byteLength,
    slice(start: number, end?: number) {
      return data.slice(start, end ?? data.byteLength);
    },
  };
}

function cellText(value: unknown) {
  if (value == null) return "";
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

export default function ParquetPreview({ path }: { path: string }) {
  const [columns, setColumns] = React.useState<string[]>([]);
  const [rows, setRows] = React.useState<Array<Record<string, unknown>>>([]);
  const [summary, setSummary] = React.useState("");
  const [error, setError] = React.useState("");

  React.useEffect(() => {
    let cancelled = false;
    setError("");
    setRows([]);
    setColumns([]);
    void loadFileBytes(path).then(async (buffer) => {
      const file = fileBuffer(buffer);
      const metadata = await parquetMetadataAsync(file);
      const data = await parquetReadObjects({ file, rowEnd: ROW_LIMIT }) as Array<Record<string, unknown>>;
      if (cancelled) return;
      const names = data.length ? Object.keys(data[0]).filter((key) => key !== "__index__") : metadata.schema.filter((field) => field.name && field.num_children == null).map((field) => field.name);
      const total = Number(metadata.num_rows);
      setColumns(names);
      setRows(data);
      setSummary(`${total.toLocaleString()} 行 · ${names.length} 列${total > data.length ? ` · 显示前 ${data.length} 行` : ""}`);
    }).catch((reason) => {
      if (!cancelled) setError(reason instanceof Error ? reason.message : "无法打开 Parquet");
    });
    return () => { cancelled = true; };
  }, [path]);

  if (error) return <pre className="office-visual-fallback">{error}</pre>;
  if (!summary) return <div className="office-visual-status">正在打开表格…</div>;
  return <div className="parquet-view">
    <small>{summary}</small>
    <div className="office-sheet"><table>
      <thead><tr>{columns.map((column) => <th key={column}>{column}</th>)}</tr></thead>
      <tbody>{rows.map((row, index) => <tr key={index}>{columns.map((column) => <td key={column}>{cellText(row[column])}</td>)}</tr>)}</tbody>
    </table></div>
  </div>;
}
