import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = fs.readFileSync(path.join(root, "src-tauri/src/updates.rs"), "utf8");
assert.match(source, /fn version_of/);
assert.match(source, /parse_version\(&latest\)/);
assert.match(source, /version_of_keeps_semver_and_drops_garbage/);
assert.doesNotMatch(source, /latest = tag\.to_string\(\);\s*$/);

console.log("updates-smoke ok");
