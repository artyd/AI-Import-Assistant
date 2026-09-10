#!/usr/bin/env node
// Ingest the State Register of Medicinal Products of Ukraine into the local
// `drug_registry` table so the registry cross-check runs OFFLINE (no live
// browsing — per the grounding rules).
//
// Source: data.gov.ua CKAN dataset "Державний реєстр лікарських засобів України"
//   (slug reestr_likarskyh_zasobiv_moz, CC-BY, updated quarterly).
//   CSV: ';'-delimited, Windows-1251 encoded, ~16.5k rows, 45 columns.
//
// Usage:
//   node scripts/ingest-drug-registry.mjs [path-to-reestr.csv]   # ingest a file
//   node scripts/ingest-drug-registry.mjs --url <csv-url>        # download + ingest
//   node scripts/ingest-drug-registry.mjs --seed                 # seed 1 known record (demo/test)
//   node scripts/ingest-drug-registry.mjs                        # download the default snapshot
//
// Needs DATABASE_URL in the environment (present in the backend container).
// Dependency-free except `pg` (a runtime dependency).

import { readFile } from 'node:fs/promises';
import https from 'node:https';
import http from 'node:http';
import pg from 'pg';

const { Client } = pg;

// data.gov.ua-hosted snapshot (stable). Override with --url or REGISTRY_CSV_URL;
// the freshest live export is http://www.drlz.com.ua/ibp/zvity.nsf/all/zvit/$file/reestr.csv
const DEFAULT_URL =
  'https://data.gov.ua/dataset/fded13b8-4e2c-4c48-bf14-65d0e3106463/resource/e97475e8-129e-4309-ae39-3ea1fcad7c1a/download/reestr.csv';

// ── minimal RFC-4180-ish CSV parser (delimiter ';', handles quotes + embedded
//    newlines and "" escapes). Returns array of string[] rows. ────────────────
function parseCsv(text, delimiter = ';') {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === delimiter) {
      row.push(field);
      field = '';
    } else if (c === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (c === '\r') {
      // swallow; \n handles the row break
    } else {
      field += c;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function download(url) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    client
      .get(url, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          download(res.headers.location).then(resolve, reject);
          res.resume();
          return;
        }
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode} for ${url}`));
          res.resume();
          return;
        }
        const chunks = [];
        res.on('data', (d) => chunks.push(d));
        res.on('end', () => resolve(Buffer.concat(chunks)));
      })
      .on('error', reject);
  });
}

// Find a column index by trying header substrings (order-independent), else fall
// back to a known 0-based position.
function colIndex(header, needles, fallback) {
  const lower = header.map((h) => (h || '').toLowerCase());
  for (const n of needles) {
    const idx = lower.findIndex((h) => h.includes(n.toLowerCase()));
    if (idx >= 0) return idx;
  }
  return fallback;
}

function toIsoDate(s) {
  const m = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec((s || '').trim());
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
}

const SEED_RECORD = {
  reg_number: 'UA/19603/01/01',
  product_name: 'НАТРІЮ ТІОСУЛЬФАТ',
  active_substance: 'натрію тіосульфату не менше 99,0 % і не більше 101,0 %',
  dosage_form: 'кристали (субстанція) у подвійних поліетиленових пакетах для фармацевтичного застосування',
  manufacturer: 'Суджата Кемікалз',
  manufacturer_country: 'Індія',
  mah_owner: 'ТОВ "БІОЛІК ФАРМА"',
  valid_from: '2022-08-16',
  valid_to: '2027-08-16',
  valid_unlimited: false,
  raw: { source: 'seed', note: 'validated record from research' },
};

async function upsert(client, rec) {
  await client.query(
    `INSERT INTO drug_registry
       (reg_number, product_name, active_substance, dosage_form, manufacturer,
        manufacturer_country, mah_owner, valid_from, valid_to, valid_unlimited, raw, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb, now())
     ON CONFLICT (reg_number) DO UPDATE SET
       product_name = EXCLUDED.product_name,
       active_substance = EXCLUDED.active_substance,
       dosage_form = EXCLUDED.dosage_form,
       manufacturer = EXCLUDED.manufacturer,
       manufacturer_country = EXCLUDED.manufacturer_country,
       mah_owner = EXCLUDED.mah_owner,
       valid_from = EXCLUDED.valid_from,
       valid_to = EXCLUDED.valid_to,
       valid_unlimited = EXCLUDED.valid_unlimited,
       raw = EXCLUDED.raw,
       updated_at = now()`,
    [
      rec.reg_number,
      rec.product_name,
      rec.active_substance,
      rec.dosage_form,
      rec.manufacturer,
      rec.manufacturer_country,
      rec.mah_owner,
      rec.valid_from,
      rec.valid_to,
      rec.valid_unlimited,
      JSON.stringify(rec.raw ?? {}),
    ],
  );
}

async function main() {
  const args = process.argv.slice(2);
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL is not set.');

  const client = new Client({ connectionString });
  await client.connect();
  try {
    if (args.includes('--seed')) {
      await upsert(client, SEED_RECORD);
      console.log(`Seeded 1 record: ${SEED_RECORD.reg_number}`);
      return;
    }

    // Resolve the CSV bytes: local path, --url, env, or the default snapshot.
    let buf;
    const urlFlagIdx = args.indexOf('--url');
    const url =
      urlFlagIdx >= 0 ? args[urlFlagIdx + 1] : process.env.REGISTRY_CSV_URL || null;
    const filePath = args.find((a) => !a.startsWith('--') && a !== url);
    if (filePath) {
      console.log(`Reading ${filePath} …`);
      buf = await readFile(filePath);
    } else {
      const src = url || DEFAULT_URL;
      console.log(`Downloading ${src} …`);
      buf = await download(src);
    }

    // The register file is Windows-1251. Node ships full ICU, so TextDecoder
    // handles it directly.
    const text = new TextDecoder('windows-1251').decode(buf);
    const rows = parseCsv(text, ';');
    if (rows.length < 2) throw new Error('CSV parsed to < 2 rows — wrong file/encoding?');

    const header = rows[0];
    const iReg = colIndex(header, ['номер реєстраційного', 'реєстраційного посвідчення'], 29);
    const iName = colIndex(header, ['торгівельне найменування', 'торгів'], 1);
    const iInn = colIndex(header, ['міжнародне непатентоване', 'непатентоване'], 2);
    const iForm = colIndex(header, ['форма випуску'], 3);
    const iSubst = colIndex(header, ['склад'], 5);
    const iMah = colIndex(header, ['заявник: назва', 'заявник'], 10);
    const iMahCountry = colIndex(header, ['заявник: країна'], 11);
    const iMfr = colIndex(header, ['виробник 1: назва', 'виробник 1'], 14);
    const iMfrCountry = colIndex(header, ['виробник 1: країна'], 15);
    const iFrom = colIndex(header, ['дата початку'], 30);
    const iTo = colIndex(header, ['дата закінчення'], 31);

    let n = 0;
    let skipped = 0;
    await client.query('BEGIN');
    for (let r = 1; r < rows.length; r++) {
      const row = rows[r];
      const reg = (row[iReg] || '').trim();
      if (!reg) {
        skipped++;
        continue;
      }
      const toRaw = (row[iTo] || '').trim();
      const unlimited = /необмежен/i.test(toRaw);
      await upsert(client, {
        reg_number: reg,
        product_name: (row[iName] || '').trim() || null,
        active_substance: (row[iSubst] || '').trim() || null,
        dosage_form: (row[iForm] || '').trim() || null,
        manufacturer: (row[iMfr] || '').trim() || null,
        manufacturer_country: (row[iMfrCountry] || '').trim() || null,
        mah_owner: (row[iMah] || '').trim() || null,
        valid_from: toIsoDate(row[iFrom]),
        valid_to: unlimited ? null : toIsoDate(toRaw),
        valid_unlimited: unlimited,
        raw: { inn: (row[iInn] || '').trim(), mah_country: (row[iMahCountry] || '').trim() },
      });
      n++;
      if (n % 2000 === 0) console.log(`  … ${n} rows`);
    }
    await client.query('COMMIT');
    console.log(`Ingested ${n} registrations (skipped ${skipped} rows without a reg number).`);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error('Ingest failed:', err.message);
  process.exit(1);
});
