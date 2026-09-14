/**
 * Порт евристики вибору «актуального листа». Чистий модуль без DOM/AI —
 * придатний для юніт-тестів і паритет-перевірки. Поведінка збережена 1:1.
 */

export interface SheetInput {
  name: string;
  rows: (string | number | null | undefined)[][];
}

export interface SheetMeta {
  sheet: SheetInput;
  name: string;
  parsedDate: Date | null;
  hasTable: boolean;
  headerIdx: number;
}

export interface SelectResult {
  selected: SheetMeta | null;
  reason: string;
  ignored: string[];
}

/** Витягує дату з назви листа. */
export function parseSheetDate(sheetName: string | null | undefined, currentDate: Date): Date | null {
  if (!sheetName) return null;
  const s = String(sheetName).trim();
  const refYear = currentDate.getFullYear();

  // DD.MM.YYYY / DD-MM-YYYY / DD/MM/YYYY / DD,MM,YYYY
  let m = s.match(/(\d{1,2})[.\-/,](\d{1,2})[.\-/,](\d{4})/);
  if (m) {
    const d = new Date(parseInt(m[3]!), parseInt(m[2]!) - 1, parseInt(m[1]!));
    if (!isNaN(d.getTime()) && d <= currentDate) return d;
    return null;
  }
  // DD.MM / DD-MM / DD/MM / DD,MM (без року)
  m = s.match(/(\d{1,2})[.\-/,](\d{1,2})(?!\d)/);
  if (m) {
    const day = parseInt(m[1]!);
    const mon = parseInt(m[2]!);
    if (day >= 1 && day <= 31 && mon >= 1 && mon <= 12) {
      let d = new Date(refYear, mon - 1, day);
      // якщо дата в майбутньому — пробуємо минулий рік
      if (d > currentDate) d = new Date(refYear - 1, mon - 1, day);
      return d;
    }
  }
  return null;
}

/** Знаходить рядок заголовків товарної таблиці. */
export function findDataHeader(rows: SheetInput['rows']): number {
  if (!rows || rows.length < 2) return -1;
  for (let i = 0; i < Math.min(10, rows.length); i++) {
    const rowText = (rows[i] || []).map((c) => String(c ?? '').toLowerCase()).join('\t');
    const hasNameCol = /номенкл|наименован|назван|product\b|item\b/i.test(rowText);
    const hasNumCol =
      /кол[\-\s]*ва|вес|цена|кг\b|kg\b|закупк|нетто|price\b|qty\b|тнвэд|уктзед/i.test(rowText);
    if (hasNameCol && hasNumCol) return i;
    // fallback: тільки колонка назви
    if (hasNameCol) return i;
  }
  return -1;
}

/** Вибирає ОДИН актуальний лист. */
export function selectActualSheet(sheetsArr: SheetInput[], currentDate: Date): SelectResult {
  const today = new Date(currentDate.getFullYear(), currentDate.getMonth(), currentDate.getDate());

  const meta: SheetMeta[] = sheetsArr.map((sheet) => {
    const parsedDate = parseSheetDate(sheet.name, today);
    const headerIdx = findDataHeader(sheet.rows);
    return { sheet, name: sheet.name, parsedDate, hasTable: headerIdx >= 0, headerIdx };
  });

  const withTable = meta.filter((m) => m.hasTable);
  const pool = withTable.length > 0 ? withTable : meta;

  const dated = pool.filter((m) => m.parsedDate !== null);
  const undated = pool.filter((m) => m.parsedDate === null);

  let selected: SheetMeta | null = null;
  let reason = '';

  if (dated.length > 0) {
    dated.sort((a, b) => (b.parsedDate!.getTime() - a.parsedDate!.getTime()));
    const todayMs = today.getTime();
    const exact = dated.find((m) => m.parsedDate!.getTime() === todayMs);
    if (exact) {
      selected = exact;
      reason = `Дата листа "${exact.name}" збігається з поточною датою аналізу`;
    } else {
      const best = dated.find((m) => m.parsedDate! <= today);
      if (best) {
        selected = best;
        reason = `Лист "${best.name}" — найновіший з датою не пізніше поточної (${best.parsedDate!.toLocaleDateString('uk-UA')})`;
      }
    }
  }

  if (!selected && undated.length > 0) {
    selected = undated[0]!;
    reason = `Листів із датою не знайдено; обраний лист "${selected.name}" як найкраща таблиця`;
  }

  if (!selected) {
    selected = meta[0] ?? null;
    reason = 'Аварійний fallback — обрано перший лист';
  }

  const ignored = meta.filter((m) => m !== selected).map((m) => m.name);
  return { selected, reason, ignored };
}
