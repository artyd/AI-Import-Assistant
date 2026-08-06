// Copies non-TS assets that tsc does not emit (the SQL schema) into dist/.
import { copyFileSync, mkdirSync } from 'node:fs';

mkdirSync('dist/db', { recursive: true });
copyFileSync('src/db/schema.sql', 'dist/db/schema.sql');
// eslint-disable-next-line no-console
console.log('Copied src/db/schema.sql -> dist/db/schema.sql');
