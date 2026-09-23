'use strict';

const fs = require('node:fs');
const path = require('node:path');
const office = require('./office.cjs');
const notebook = require('./notebook.cjs');

const file = process.argv[2];
if (!file) {
  process.stderr.write('missing file\n');
  process.exit(1);
}
const buffer = fs.readFileSync(file);
const ext = path.extname(file).toLowerCase();
let preview;
if (ext === '.ipynb') {
  preview = notebook.previewNotebook(buffer);
} else {
  preview = office.readAny(file, buffer);
}
process.stdout.write(JSON.stringify(preview));
