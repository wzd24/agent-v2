use crate::mcp;
use crate::workspace;
use serde_json::{json, Value};
use std::fs;
use std::path::Path;

pub fn is_structured_extension(ext: &str) -> bool {
    matches!(
        ext,
        "docx" | "dotx"
            | "xls"
            | "xlsx"
            | "xlsm"
            | "csv"
            | "tsv"
            | "ppt"
            | "pptx"
            | "pptm"
            | "pdf"
            | "ipynb"
            | "odt"
            | "ods"
            | "odp"
            | "epub"
            | "xmind"
            | "zip"
            | "jar"
            | "apk"
            | "vsix"
            | "crx"
            | "7z"
            | "rar"
            | "tar"
            | "tgz"
            | "gz"
            | "ttf"
            | "otf"
            | "woff"
            | "woff2"
            | "psd"
            | "icns"
            | "tif"
            | "tiff"
            | "heic"
            | "heif"
            | "parquet"
    )
}

pub fn read_structured(path: &Path) -> Result<Value, String> {
    let ext = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_lowercase();
    match mcp::preview_file(path) {
        Ok(preview) => Ok(wrap_preview(path, preview)),
        Err(err) => match ext.as_str() {
            "csv" => csv_preview(path),
            "ipynb" => notebook_preview(path).map(|preview| wrap_preview(path, preview)),
            _ => Err(err),
        },
    }
}

fn wrap_preview(path: &Path, preview: Value) -> Value {
    json!({
        "path": workspace::display_path(path),
        "content": preview.get("text").and_then(Value::as_str).unwrap_or(""),
        "preview": preview,
    })
}

fn csv_preview(path: &Path) -> Result<Value, String> {
    let text = fs::read_to_string(path).map_err(|err| err.to_string())?;
    let rows: Vec<Vec<String>> = text
        .replace("\r\n", "\n")
        .split('\n')
        .filter(|line| !line.is_empty())
        .map(split_csv_line)
        .collect();
    Ok(json!({
        "path": workspace::display_path(path),
        "content": text,
        "preview": { "kind": "spreadsheet", "sheets": [{ "name": "Sheet1", "rows": rows }] }
    }))
}

fn split_csv_line(line: &str) -> Vec<String> {
    let mut cells = Vec::new();
    let mut current = String::new();
    let mut quoted = false;
    let mut chars = line.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch == '"' {
            if quoted && chars.peek() == Some(&'"') {
                current.push('"');
                chars.next();
            } else {
                quoted = !quoted;
            }
        } else if ch == ',' && !quoted {
            cells.push(std::mem::take(&mut current));
        } else {
            current.push(ch);
        }
    }
    cells.push(current);
    cells
}

fn notebook_preview(path: &Path) -> Result<Value, String> {
    let raw: Value = serde_json::from_str(&fs::read_to_string(path).map_err(|err| err.to_string())?)
        .map_err(|err| err.to_string())?;
    let language = raw
        .pointer("/metadata/language_info/name")
        .or_else(|| raw.pointer("/metadata/kernelspec/language"))
        .and_then(Value::as_str)
        .unwrap_or("python");
    let title = raw
        .pointer("/metadata/title")
        .and_then(Value::as_str)
        .unwrap_or("");
    let cells = raw
        .get("cells")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut text_parts = Vec::new();
    let mapped: Vec<Value> = cells
        .iter()
        .enumerate()
        .map(|(index, cell)| {
            let source = match cell.get("source") {
                Some(Value::Array(parts)) => parts
                    .iter()
                    .filter_map(Value::as_str)
                    .collect::<String>(),
                Some(Value::String(value)) => value.clone(),
                _ => String::new(),
            };
            text_parts.push(source.clone());
            json!({
                "index": index,
                "type": cell.get("cell_type").and_then(Value::as_str).unwrap_or("markdown"),
                "source": source,
                "executionCount": cell.get("execution_count").cloned().unwrap_or(Value::Null),
                "outputs": cell.get("outputs").and_then(Value::as_array).map(Vec::len).unwrap_or(0),
            })
        })
        .collect();
    Ok(json!({
        "kind": "notebook",
        "title": title,
        "language": language,
        "cells": mapped,
        "text": text_parts.join("\n\n"),
    }))
}

#[cfg(test)]
mod tests {
    use super::split_csv_line;

    #[test]
    fn structured_extensions_cover_viewers() {
        for ext in ["epub", "zip", "ttf", "ods", "tsv", "woff2", "xlsm", "dotx", "psd", "parquet", "heic", "7z"] {
            assert!(super::is_structured_extension(ext));
        }
        assert!(!super::is_structured_extension("png"));
        assert!(!super::is_structured_extension("rs"));
    }

    #[test]
    fn split_csv_line_keeps_quoted_commas() {
        assert_eq!(
            split_csv_line(r#"a,"b,c",d"#),
            vec!["a".to_string(), "b,c".to_string(), "d".to_string()]
        );
        assert_eq!(
            split_csv_line(r#""say ""hi""",x"#),
            vec![r#"say "hi""#.to_string(), "x".to_string()]
        );
    }
}
