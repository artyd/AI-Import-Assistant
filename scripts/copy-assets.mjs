// Copies non-TS assets that tsc does not emit into dist/:
//  - the SQL schema
//  - the analysis reference-data JSON (loaded at runtime via fs from import.meta.url)
import { copyFileSync, mkdirSync, readdirSync } from 'node:fs';

mkdirSync('dist/db', { recursive: true });
copyFileSync('src/db/schema.sql', 'dist/db/schema.sql');
// eslint-disable-next-line no-console
console.log('Copied src/db/schema.sql -> dist/db/schema.sql');

// Analysis engines read their reference data (*.json) at runtime relative to the
// compiled module (new URL('./x.json', import.meta.url)). tsc does not emit JSON,
// so copy the whole data dir into dist to keep the loader working in production.
const analysisDataSrc = 'src/services/analysis/data';
const analysisDataDst = 'dist/services/analysis/data';
mkdirSync(analysisDataDst, { recursive: true });
let jsonCount = 0;
for (const file of readdirSync(analysisDataSrc)) {
  if (!file.endsWith('.json')) continue;
  copyFileSync(`${analysisDataSrc}/${file}`, `${analysisDataDst}/${file}`);
  jsonCount++;
}
// eslint-disable-next-line no-console
console.log(`Copied ${jsonCount} analysis data JSON files -> ${analysisDataDst}`);
