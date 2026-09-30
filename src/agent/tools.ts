import { z } from 'zod';
import type { ChatTool } from '../anthropic/client.js';
import { query } from '../db/pool.js';
import * as logist from '../services/logist/index.js';
import { digestUktzedSections } from '../services/logist/uktzedDigest.js';
import { readStoredFile, contentHashOf } from '../services/storage.js';
import { convertToMarkdown } from '../services/markdown/convert.js';
import { joinPages } from '../services/markdown/format.js';
import { enqueueIndexJob } from '../queue/index.js';
import { insertNotification } from '../services/notifications.js';
import { publishFileStatus } from '../events/fileStatus.js';
import {
  searchWorkspace,
  workspaceCoverage,
  loadFileMarkdown,
  saveFileMarkdown,
} from '../services/markdown/store.js';
import { getWorkspaceById } from '../services/workspaceAccess.js';
import { buildSupplierInstruction } from '../services/supplierInstruction.js';
import { computeDiscrepancies } from '../services/discrepancies.js';
import { computeRegistryChecks } from '../services/drugRegistry.js';
import { computeRisks } from '../services/risks.js';
import { refreshWorkspaceState } from '../services/status.js';
import { getMissingContext, upsertParties, type PartyInput } from '../services/parties.js';
import { analyzeParties } from '../services/partyExtraction.js';
import { classifyAndFile, sortInbox } from '../services/classify.js';
import { buildAndSaveReport } from '../services/report.js';
import { compareFileVersions, previousVersionId } from '../services/versions.js';
import { runAnalysis, type AnalysisInput } from '../services/analysis/run.js';
import { formatAnalysisMarkdown } from '../services/analysis/format.js';
import { persistAnalysis } from '../services/analyses.js';
import type { Citation } from '../services/conversations.js';
import type { FileType } from '../domain/folders.js';

/**
 * Tool execution scope. Shipment ("supply") tools need a `workspaceId`; the
 * consolidated-analysis tool needs a `collectionId` (+ `ownerId` to persist).
 * Both are optional so one shape covers every chat kind — handlers narrow via
 * `requireWorkspace(ctx)` / `requireCollection(ctx)`.
 */
export interface ToolContext {
  workspaceId?: string;
  collectionId?: string;
  ownerId?: string;
}

/** Narrows to a shipment scope; throws if the tool was called without one. */
function requireWorkspace(ctx: ToolContext): string {
  if (!ctx.workspaceId) throw new Error('Цей інструмент доступний лише в межах постачання.');
  return ctx.workspaceId;
}

export interface ToolOutcome {
  /** Text returned to the model as the tool_result content. */
  result: string;
  /** Short human-readable summary for the tool_result SSE event / agent log. */
  summary: string;
  /** Sources surfaced by this tool call, for inline citation chips. */
  citations: Citation[];
}

/** Tool definitions advertised to Claude. The model decides which to call. */
export const toolDefinitions: ChatTool[] = [
  {
    name: 'search_documents',
    description:
      'Повнотекстовий пошук (за ключовими словами, номерами, кодами) по Markdown-версіях документів ' +
      'поточного постачання. Використовуй, щоб ЗНАЙТИ, де згадується номер/товар/сторона/умова, коли не ' +
      'знаєш точного файлу. Шукає за словами, не за змістом — пробуй синоніми й мову документа. ' +
      'Повертає фрагменти з назвою файлу та сторінкою; для аналізу документа читай його повністю через read_file.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Пошуковий запит українською або мовою документа.' },
      },
      required: ['query'],
    },
  },
  {
    name: 'read_file',
    description:
      'Читає повний або частковий вміст конкретного файлу постачання. ' +
      'Використовуй, коли потрібне точне формулювання пункту, конкретна цифра чи назва файлу відома. ' +
      'ВАЖЛИВО: якщо відповідь закінчується позначкою «…[обрізано]», це НЕ весь файл — ' +
      'дочитай наступні сторінки/символи, викликавши read_file ще раз із параметром range.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Назва файлу (напр. "invoice_draft_v2.pdf"). Достатньо приблизної назви — шукається і за частковим збігом.' },
        file_id: { type: 'string', description: 'Необовʼязково: точний ID файлу (з list_files) — надійніше за назву.' },
        range: {
          type: 'string',
          description: 'Необовʼязково: діапазон сторінок "1-5" (для PDF) або символів "0-50000". Використовуй, щоб дочитати обрізаний файл.',
        },
      },
    },
  },
  {
    name: 'list_files',
    description:
      'Повертає дерево файлів поточного постачання: тека, назва, ID файлу, тип документа ' +
      '(інвойс/пакувальний/контракт/…), статус індексації та чи вже оброблений (перетворений на Markdown). ' +
      'Використовуй, щоб зорієнтуватися, які документи є, і взяти ID/назву для read_file.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'get_checklist',
    description:
      'Повертає розрахований чек-лист комплектності документів постачання та поточний ' +
      'статус (дані з бази, не з перечитування тексту). Використовуй для питань про ' +
      'комплектність — «що є / чого бракує».',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'get_discrepancies',
    description:
      'Повертає розрахований звіт розбіжностей між контрактом, інвойсом та пакувальним листом ' +
      '(детермінована звірка структурованих полів). Використовуй для питань про ' +
      'невідповідності — не звіряй текст вручну.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'get_risks',
    description:
      'Повертає перелік поточних і майбутніх ризиків постачання (прострочені/близькі до ' +
      'завершення сертифікати, брак документів, розбіжності цифр, наближення терміну ' +
      'поставки). Викликай проактивно, коли користувач питає «які проблеми?», «що не так?», ' +
      '«на що звернути увагу?» — не оцінюй ризики самостійно з тексту.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'check_drug_registration',
    description:
      'Довідкова перевірка реєстраційних номерів ліків (напр. UA/19603/01/01) з документів ' +
      'за ЛОКАЛЬНОЮ копією Держреєстру ліків України: чинність реєстрації, збіг виробника та ' +
      'наявність власника реєстраційного посвідчення в документах. Викликай, коли в постачанні ' +
      'є лікарський засіб / субстанція з реєстраційним номером. Це ДОВІДКОВО — остаточне ' +
      'підтвердження робить регуляторний/митний фахівець; не роби юридичних висновків сам.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'generate_supplier_instruction',
    description:
      'Генерує інструкцію (лист) для постачальника на основі параметрів постачання та ' +
      'сторін. Якщо бракує вхідних даних — поверне їх перелік замість вигаданого листа.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'get_missing_context',
    description:
      'Повертає, які параметри постачання ще не задані (contract_type, parties, ' +
      'product_category, incoterm, transport_mode, origin_country). Використовуй, щоб ' +
      'зрозуміти, чого бракує, перш ніж генерувати документи.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'save_workspace_context',
    description:
      'Зберігає параметри постачання, зібрані в розмові (контракт, категорія товару, ' +
      'інкотермс, транспорт, країна походження) та за потреби сторони (parties). ' +
      'Використовуй, коли користувач повідомив ці дані.',
    input_schema: {
      type: 'object',
      properties: {
        contract_type: { type: 'string', enum: ['bilateral', 'trilateral'] },
        product_category: { type: 'string' },
        incoterm_in: { type: 'string', description: 'Вхідний Incoterms (закупівля: постачальник→ми).' },
        incoterm_out: { type: 'string', description: 'Вихідний Incoterms (продаж: ми→покупець).' },
        transport_mode: { type: 'string' },
        origin_country: { type: 'string' },
        parties: {
          type: 'array',
          description: 'Опційно: перелік сторін для перезапису (3 фіксовані ролі).',
          items: {
            type: 'object',
            properties: {
              role: {
                type: 'string',
                enum: ['sender', 'intermediary', 'recipient'],
                description: 'sender=Від кого, intermediary=Через кого, recipient=Кому.',
              },
              company_name: { type: 'string' },
              is_internal: { type: 'boolean' },
              country: { type: 'string' },
            },
            required: ['role', 'company_name'],
          },
        },
      },
    },
  },
  {
    name: 'get_contract_mode',
    description:
      'Визначає структуру контракту постачання за завантаженими документами: ' +
      'двосторонній (2 сторони: постачальник→AGroup95) чи тристоронній (3 сторони: ' +
      'постачальник→PrimeForce→AGroup95). Рішення детерміноване (виробник vs продавець в ' +
      'інвойсі). Повертає авто-висновок, впевненість (0..1), пояснення, а також поточне ' +
      'збережене значення та його джерело (ручне/авто). НЕ змінює даних. Виклич перед ' +
      'аналізом, щоб знати режим — перевірки для 2- і 3-сторонніх постачань різні.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'set_contract_mode',
    description:
      'Зберігає структуру контракту постачання. source="survey" — коли КОРИСТУВАЧ підтвердив ' +
      'режим у розмові (перезаписує будь-яке значення, зокрема автоматичне). source="auto" — ' +
      'коли фіксуєш автоматичний висновок: режим і впевненість беруться з детермінованого ' +
      'аналізу документів (твій contract_type ігнорується), і воно НЕ перезаписує значення, ' +
      'встановлене вручну. Спершу виклич get_contract_mode.',
    input_schema: {
      type: 'object',
      properties: {
        source: {
          type: 'string',
          enum: ['auto', 'survey'],
          description: 'auto=автовисновок з документів; survey=підтверджено користувачем.',
        },
        contract_type: {
          type: 'string',
          enum: ['bilateral', 'trilateral'],
          description:
            'Режим. Обовʼязковий для source="survey". Для source="auto" ігнорується — ' +
            'береться з аналізу документів.',
        },
      },
      required: ['source'],
    },
  },
  {
    name: 'classify_and_file',
    description:
      'Класифікує один файл із інбоксу та переміщує його у відповідну теку скелета. ' +
      'Лише переміщує файл, нічого не видаляє.',
    input_schema: {
      type: 'object',
      properties: { file_id: { type: 'string', description: 'ID файлу.' } },
      required: ['file_id'],
    },
  },
  {
    name: 'sort_inbox',
    description:
      'Розкладає всі файли з інбоксу (без теки) по відповідних теках. Лише переміщує ' +
      'файли; повертає перелік «файл → тека», щоб показати користувачу.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'normalize_shipment_files',
    description:
      'Перевіряє файли поточного постачання на точні дублікати за вмістом (не за іменем) та ' +
      'донараховує відсутні хеші для файлів, завантажених до цієї функції. Ніколи не видаляє ' +
      'файли — лише повідомляє про знайдені дублікати. Також повторно запускає індексацію всіх ' +
      'файлів зі статусом «Помилка». Використовуй за проханням «нормалізуй файли», «перевір ' +
      'дублікати», «повтори невдалі файли» тощо.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'generate_report',
    description:
      'Генерує та зберігає HTML-звіт по постачанню (огляд, комплектність, розбіжності, ' +
      'ключові показники, висновки). Використовуй замість того, щоб складати звіт вручну.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'compare_document_versions',
    description:
      'Порівнює вказаний файл із його попередньою версією (тим, який він замінив) за ' +
      'структурованими полями. Використовуй для «порівняння нового драфту з попереднім».',
    input_schema: {
      type: 'object',
      properties: { file_id: { type: 'string', description: 'ID файлу (нова версія).' } },
      required: ['file_id'],
    },
  },
  {
    name: 'run_consolidated_analysis',
    description:
      'Запускає повний аналіз маніфесту збірника: рахує митну вартість (CIF), мито та ПДВ ' +
      'по кожній позиції, визначає походження, перевірки ЄС/UA та ризики, звіряє коди з qdpro. ' +
      'ДЖЕРЕЛО маніфесту: якщо користувач дав посилання на Google Sheets — передай його у ' +
      'source_url; якщо вставив таблицю рядками — передай у manifest_text; якщо нічого не ' +
      'задано — береться останній завантажений файл-маніфест збірника. Використовуй, коли ' +
      'користувач просить проаналізувати збірник / порахувати платежі / перевірити позиції. ' +
      'Повертає готову відповідь по позиціях (презентуй її користувачу як є).',
    input_schema: {
      type: 'object',
      properties: {
        source_url: {
          type: 'string',
          description: 'Публічне посилання на Google Sheets із маніфестом (необовʼязково).',
        },
        manifest_text: {
          type: 'string',
          description: 'Вставлена таблиця-маніфест рядками, TSV/CSV (необовʼязково).',
        },
      },
    },
  },
];

/**
 * Customs/logistics reference tools backed by the internal `logist-mcp` service
 * (УКТ ЗЕД довідка/класифікатор, подвійне використання, курс НБУ, PubChem). They
 * are scope-less external lookups (no workspace/collection needed), advertised in
 * every chat kind — but ONLY when LOGIST_MCP_URL is configured. Their results are
 * first-source facts: the agent must prefer them over reasoning from memory for
 * duty/VAT/rates, while HS-code SELECTION stays advisory (see the system prompt).
 */
export const logistToolDefinitions: ChatTool[] = [
  {
    name: 'uktzed_lookup_code',
    description:
      'Офіційна митна довідка по 10-значному коду УКТ ЗЕД (джерело: qdpro.com.ua, дані ' +
      'ДФС/Мінфіну): опис товару, ставки ввізного мита (пільгова/повна), ПДВ, пільги за ' +
      'торговими угодами (ЄС тощо), ліцензування, обмеження. Використовуй, щоб дати ТОЧНІ ' +
      'ставки/вимоги по вже визначеному коду — не бери ставки з памʼяті.',
    input_schema: {
      type: 'object',
      properties: {
        code: {
          type: 'string',
          description: '10-значний код УКТ ЗЕД, з пробілами або без (напр. "3004 32 00 00").',
        },
      },
      required: ['code'],
    },
  },
  {
    name: 'uktzed_browse_classifier',
    description:
      'Навігація по ієрархії класифікатора УКТ ЗЕД (розділ → група → товарна позиція → ' +
      'підпозиція), щоб знайти потрібний код. Виклич без коду — усі розділи; далі ' +
      'заглиблюйся, передаючи код рівня з поля links попередньої відповіді.',
    input_schema: {
      type: 'object',
      properties: {
        code: {
          type: 'string',
          description:
            'Код рівня: порожньо — усі розділи; римська цифра (напр. "VI") — розділ; ' +
            '2 цифри — група; 4+ цифри — товарна позиція.',
        },
      },
    },
  },
  {
    name: 'dualuse_browse_classifier',
    description:
      'Навігація по Єдиному списку товарів подвійного використання (експортний контроль). ' +
      'Виклич без node_id — корінь дерева; далі заглиблюйся, передаючи node_id з поля links ' +
      'попередньої відповіді (node_id — внутрішній ID вузла, НЕ код категорії). Кінцеві ' +
      'категорії перелічують повʼязані коди УКТ ЗЕД — звір їх із кодом товару.',
    input_schema: {
      type: 'object',
      properties: {
        node_id: {
          type: 'string',
          description: 'Внутрішній ID вузла з links попередньої відповіді; порожньо — корінь.',
        },
      },
    },
  },
  {
    name: 'get_exchange_rate',
    description:
      'Офіційний курс гривні НБУ до валюти на дату. Використовуй для перерахунку вартості з ' +
      'валюти контракту в грн (митна вартість, порівняння пропозицій). Не бери курс з памʼяті.',
    input_schema: {
      type: 'object',
      properties: {
        currency: { type: 'string', description: 'Код валюти ISO-4217 (напр. USD, EUR, CNY).' },
        date: { type: 'string', description: 'Опційно, YYYYMMDD; порожньо — курс на сьогодні.' },
      },
      required: ['currency'],
    },
  },
  {
    name: 'pubchem_identify_substance',
    description:
      'Ідентифікація хімічної речовини за назвою, синонімом або CAS-номером через PubChem: ' +
      'IUPAC-назва, молекулярна формула, маса, InChIKey, синоніми. Використовуй, щоб звірити, ' +
      'чи дві торгові назви — це одна й та сама субстанція.',
    input_schema: {
      type: 'object',
      properties: {
        identifier: {
          type: 'string',
          description: 'Назва, синонім або CAS-номер (напр. "aspirin" або "50-78-2").',
        },
      },
      required: ['identifier'],
    },
  },
];

/** The logist tools when the service is configured, else none. */
export function logistTools(): ChatTool[] {
  return logist.logistEnabled() ? logistToolDefinitions : [];
}

interface FileRow {
  id: string;
  name: string;
  type: FileType;
  disk_path: string;
  status: string;
  folder_name: string | null;
  doc_type?: string | null;
}

export async function executeTool(
  name: string,
  input: unknown,
  ctx: ToolContext,
): Promise<ToolOutcome> {
  switch (name) {
    case 'search_documents':
      return runSearch(input, ctx);
    case 'read_file':
      return runReadFile(input, ctx);
    case 'list_files':
      return runListFiles(ctx);
    case 'get_checklist':
      return runChecklist(ctx);
    case 'get_discrepancies':
      return runDiscrepancies(ctx);
    case 'get_risks':
      return runRisks(ctx);
    case 'check_drug_registration':
      return runRegistryCheck(ctx);
    case 'generate_supplier_instruction':
      return runSupplierInstruction(ctx);
    case 'get_missing_context':
      return runMissingContext(ctx);
    case 'save_workspace_context':
      return runSaveContext(input, ctx);
    case 'get_contract_mode':
      return runGetContractMode(ctx);
    case 'set_contract_mode':
      return runSetContractMode(input, ctx);
    case 'classify_and_file':
      return runClassifyAndFile(input, ctx);
    case 'sort_inbox':
      return runSortInbox(ctx);
    case 'normalize_shipment_files':
      return runNormalizeShipmentFiles(ctx);
    case 'generate_report':
      return runGenerateReport(ctx);
    case 'compare_document_versions':
      return runCompareVersions(input, ctx);
    case 'run_consolidated_analysis':
      return runConsolidatedAnalysis(input, ctx);
    case 'uktzed_lookup_code':
      return runUktzedLookup(input);
    case 'uktzed_browse_classifier':
      return runUktzedBrowse(input);
    case 'dualuse_browse_classifier':
      return runDualuseBrowse(input);
    case 'get_exchange_rate':
      return runExchangeRate(input);
    case 'pubchem_identify_substance':
      return runPubchemIdentify(input);
    default:
      return { result: `Невідомий інструмент: ${name}`, summary: `Невідомий інструмент`, citations: [] };
  }
}

// ── logist-mcp reference tools (scope-less external lookups) ──────────────────

function logistFail(msg: string, summary: string): ToolOutcome {
  return { result: msg, summary, citations: [] };
}

async function runUktzedLookup(input: unknown): Promise<ToolOutcome> {
  const code = String((input as { code?: unknown })?.code ?? '').trim();
  if (!code) return logistFail('Не вказано код УКТ ЗЕД.', 'УКТ ЗЕД: помилка');
  try {
    const r = await logist.uktzedLookup(code);
    // The goodinfo page is large and split by customs regime (ІМПОРТ/ЕКСПОРТ/
    // ТРАНЗИТ) with critical parts sitting deep (ветеринарний контроль, заборони,
    // ліцензування). Digest each regime in batches so nothing is lost and each
    // requirement is attributed to its regime. Legacy flat `text` maps to common.
    const common = r.common ?? r.text ?? '';
    const digest = await digestUktzedSections(r.code, common, r.tabs ?? []);
    const body = digest || 'Довідку отримано, але вміст порожній — перевірте код.';
    return {
      result: `Митна довідка УКТ ЗЕД ${r.code} (джерело: qdpro.com.ua):\n${body}`,
      summary: `УКТ ЗЕД ${r.code}: довідка`,
      citations: [{ file: r.source, page: null }],
    };
  } catch (err) {
    return logistFail(`Не вдалося отримати довідку: ${(err as Error).message}`, 'УКТ ЗЕД: помилка');
  }
}

async function runUktzedBrowse(input: unknown): Promise<ToolOutcome> {
  const code = String((input as { code?: unknown })?.code ?? '').trim();
  try {
    const r = await logist.uktzedBrowse(code);
    const links = r.links.length
      ? `\n\nДочірні рівні (код — опис):\n${r.links.map((l) => `- ${l.id} — ${l.label}`).join('\n')}`
      : '';
    return {
      result: `${r.text}${links}`,
      summary: `Класифікатор УКТ ЗЕД: ${r.links.length} рівнів`,
      citations: [{ file: r.source, page: null }],
    };
  } catch (err) {
    return logistFail(`Не вдалося відкрити класифікатор: ${(err as Error).message}`, 'Класифікатор: помилка');
  }
}

async function runDualuseBrowse(input: unknown): Promise<ToolOutcome> {
  const nodeId = String((input as { node_id?: unknown })?.node_id ?? '').trim();
  try {
    const r = await logist.dualuseBrowse(nodeId);
    // Surface node_ids so the model can drill down (get_text alone loses them).
    const links = r.links.length
      ? `\n\nВузли для заглиблення (node_id — назва):\n${r.links.map((l) => `- ${l.id} — ${l.label}`).join('\n')}`
      : '';
    return {
      result: `${r.text}${links}`,
      summary: `Подвійне використання: ${r.links.length} вузлів`,
      citations: [{ file: r.source, page: null }],
    };
  } catch (err) {
    return logistFail(`Не вдалося відкрити список подвійного використання: ${(err as Error).message}`, 'Подвійне використання: помилка');
  }
}

async function runExchangeRate(input: unknown): Promise<ToolOutcome> {
  const currency = String((input as { currency?: unknown })?.currency ?? '').trim();
  const date = String((input as { date?: unknown })?.date ?? '').trim();
  if (!currency) return logistFail('Не вказано код валюти.', 'Курс НБУ: помилка');
  try {
    const r = await logist.exchangeRate(currency, date);
    return { result: r.text, summary: `Курс НБУ: ${r.currency}`, citations: [] };
  } catch (err) {
    return logistFail(`Не вдалося отримати курс НБУ: ${(err as Error).message}`, 'Курс НБУ: помилка');
  }
}

async function runPubchemIdentify(input: unknown): Promise<ToolOutcome> {
  const identifier = String((input as { identifier?: unknown })?.identifier ?? '').trim();
  if (!identifier) return logistFail('Не вказано назву/CAS речовини.', 'PubChem: помилка');
  try {
    const r = await logist.pubchemIdentify(identifier);
    return { result: r.text, summary: `PubChem: ${identifier}`, citations: [] };
  } catch (err) {
    return logistFail(`Не вдалося ідентифікувати речовину: ${(err as Error).message}`, 'PubChem: помилка');
  }
}

async function runChecklist(ctx: ToolContext): Promise<ToolOutcome> {
  const ws = await getWorkspaceById(requireWorkspace(ctx));
  if (!ws) return { result: 'Постачання не знайдено.', summary: 'Чек-лист: помилка', citations: [] };
  const { checklist, status } = await refreshWorkspaceState(ws);
  if (checklist.length === 0) {
    return {
      result: 'Чек-лист порожній — не задано параметри постачання (категорія/інкотермс/транспорт).',
      summary: 'Чек-лист: порожньо',
      citations: [],
    };
  }
  const lines = checklist.map((i) => `- ${i.requirement_key}: ${statusUa(i.status)}`);
  return {
    result: `Статус постачання: ${status}\n${lines.join('\n')}`,
    summary: `Чек-лист: ${checklist.length} пунктів`,
    citations: [],
  };
}

function statusUa(s: string): string {
  return s === 'verified' ? 'підтверджено' : s === 'received' ? 'отримано' : 'бракує';
}

async function runDiscrepancies(ctx: ToolContext): Promise<ToolOutcome> {
  const findings = await computeDiscrepancies(requireWorkspace(ctx));
  if (findings.length === 0) {
    return {
      result: 'Розбіжностей між контрактом / інвойсом / пакувальним листом не виявлено (за наявними даними).',
      summary: 'Розбіжності: 0',
      citations: [],
    };
  }
  const result = findings
    .map((f) => {
      const mark = f.kind === 'confirmed' ? '🔴' : '🟡';
      const srcs = f.citations
        .map((c) => (c.file_name ? `${c.doc_type}: «${c.file_name}» = ${c.value}` : `${c.doc_type} = ${c.value}`))
        .join('; ');
      const src = srcs ? ` (джерела: ${srcs})` : '';
      return `- ${mark} [${f.severity}] ${f.field}: очікується ${f.expected}; факт ${f.actual}${src}`;
    })
    .join('\n');
  // Surface the source documents as citation chips (dedup by file name).
  const seen = new Set<string>();
  const citations: Citation[] = [];
  for (const f of findings) {
    for (const c of f.citations) {
      if (c.file_name && !seen.has(c.file_name)) {
        seen.add(c.file_name);
        citations.push({ file: c.file_name, page: null });
      }
    }
  }
  const confirmed = findings.filter((f) => f.kind === 'confirmed').length;
  return {
    result,
    summary: `Розбіжності: ${findings.length} (🔴 ${confirmed})`,
    citations,
  };
}

async function runRegistryCheck(ctx: ToolContext): Promise<ToolOutcome> {
  const findings = await computeRegistryChecks(requireWorkspace(ctx));
  if (findings.length === 0) {
    return {
      result:
        'Реєстраційних номерів у документах не знайдено, або зауважень за локальною базою ' +
        'Держреєстру ліків немає. Це довідкова перевірка — остаточне підтвердження за регуляторним фахівцем.',
      summary: 'Реєстр: 0 зауважень',
      citations: [],
    };
  }
  const result = findings
    .map((f) => `- [${f.severity}] ${f.title}: ${f.detail}`)
    .join('\n');
  return {
    result: `Перевірка за Держреєстром ліків (довідково, підтверджує фахівець):\n${result}`,
    summary: `Реєстр: ${findings.length} зауважень`,
    citations: [],
  };
}

async function runRisks(ctx: ToolContext): Promise<ToolOutcome> {
  const ws = await getWorkspaceById(requireWorkspace(ctx));
  if (!ws) return { result: 'Постачання не знайдено.', summary: 'Ризики: помилка', citations: [] };
  const risks = await computeRisks(ws);
  if (risks.length === 0) {
    return {
      result: 'Наразі ризиків не виявлено (за наявними даними).',
      summary: 'Ризики: 0',
      citations: [],
    };
  }
  const result = risks
    .map((r) => `- [${r.severity}] ${r.title}: ${r.detail}`)
    .join('\n');
  return { result, summary: `Ризики: ${risks.length}`, citations: [] };
}

async function runSupplierInstruction(ctx: ToolContext): Promise<ToolOutcome> {
  const ws = await getWorkspaceById(requireWorkspace(ctx));
  if (!ws) return { result: 'Постачання не знайдено.', summary: 'Інструкція: помилка', citations: [] };
  const res = await buildSupplierInstruction(ws);
  if ('missing' in res) {
    return {
      result: `Бракує даних для інструкції: ${res.missing.join(', ')}. Заповни їх у картці постачання.`,
      summary: 'Інструкція: бракує даних',
      citations: [],
    };
  }
  return { result: res.instruction, summary: 'Згенеровано інструкцію постачальнику', citations: [] };
}

async function runMissingContext(ctx: ToolContext): Promise<ToolOutcome> {
  const ws = await getWorkspaceById(requireWorkspace(ctx));
  if (!ws) return { result: 'Постачання не знайдено.', summary: 'Контекст: помилка', citations: [] };
  const missing = await getMissingContext(ws);
  if (missing.length === 0) {
    return { result: 'Усі параметри постачання задані.', summary: 'Контекст: повний', citations: [] };
  }
  return {
    result: `Не задано: ${missing.join(', ')}.`,
    summary: `Бракує параметрів: ${missing.length}`,
    citations: [],
  };
}

const saveContextSchema = z.object({
  contract_type: z.enum(['bilateral', 'trilateral']).optional(),
  product_category: z.string().optional(),
  incoterm: z.string().optional(),
  incoterm_in: z.string().optional(),
  incoterm_out: z.string().optional(),
  transport_mode: z.string().optional(),
  origin_country: z.string().optional(),
  destination_country: z.string().optional(),
  parties: z
    .array(
      z.object({
        role: z.string().min(1),
        company_name: z.string().min(1),
        is_internal: z.boolean().optional(),
        country: z.string().nullable().optional(),
      }),
    )
    .optional(),
});

async function runSaveContext(input: unknown, ctx: ToolContext): Promise<ToolOutcome> {
  const parsed = saveContextSchema.safeParse(input ?? {});
  if (!parsed.success) {
    return { result: 'Некоректні дані для збереження контексту.', summary: 'Контекст: помилка', citations: [] };
  }
  const ws = await getWorkspaceById(requireWorkspace(ctx));
  if (!ws) return { result: 'Постачання не знайдено.', summary: 'Контекст: помилка', citations: [] };

  const scalarKeys = [
    'contract_type',
    'product_category',
    'incoterm',
    'incoterm_in',
    'incoterm_out',
    'transport_mode',
    'origin_country',
    'destination_country',
  ] as const;
  const sets: string[] = [];
  const vals: unknown[] = [ws.id];
  for (const key of scalarKeys) {
    const value = parsed.data[key];
    if (value === undefined) continue;
    sets.push(`${key} = $${vals.length + 1}`);
    vals.push(value);
  }
  // A contract_type gathered from the user in conversation is a human-confirmed
  // value → stamp provenance so auto-detection (set_contract_mode source="auto")
  // won't overwrite it. The dedicated set_contract_mode tool is preferred for the
  // mode; this keeps the invariant when the agent bundles it into intake context.
  if (parsed.data.contract_type !== undefined) {
    sets.push(`contract_type_source = $${vals.length + 1}`);
    vals.push('survey');
    sets.push(`contract_type_confidence = $${vals.length + 1}`);
    vals.push(null);
    sets.push(`contract_type_reason = $${vals.length + 1}`);
    vals.push('Зібрано в розмові з користувачем.');
  }
  if (sets.length > 0) {
    await query(`UPDATE workspaces SET ${sets.join(', ')} WHERE id = $1`, vals);
  }
  if (parsed.data.incoterm_in !== undefined) {
    await query('UPDATE workspaces SET incoterm = incoterm_in WHERE id = $1', [ws.id]);
  }
  if (parsed.data.parties) {
    await upsertParties(ws.id, parsed.data.parties as PartyInput[]);
  }

  // Recompute intake_complete and refresh derived state.
  await refreshAfterWorkspaceWrite(ws.id);
  const changed = [
    ...scalarKeys.filter((k) => parsed.data[k] !== undefined),
    ...(parsed.data.parties ? ['parties'] : []),
  ];
  if (changed.length) await notifyAgentContextChange(ws.id, changed.join(', '));
  const finalWs = (await getWorkspaceById(ws.id))!;
  const missing = await getMissingContext(finalWs);
  return {
    result:
      'Контекст збережено.' +
      (missing.length ? ` Ще бракує: ${missing.join(', ')}.` : ' Усі параметри задані.'),
    summary: 'Збережено контекст постачання',
    citations: [],
  };
}

/**
 * Recompute intake_complete from the required-five fields and refresh the derived
 * status/checklist. Single source of the completeness formula for the agent-side
 * writes (save_workspace_context, set_contract_mode) so it can't drift.
 */
/**
 * Marks uploaded-document text as DATA for the model (prompt-injection guard; the
 * system prompt tells it never to follow instructions found inside these tags).
 * Closing tags inside the document are neutralised so it can't break out.
 */
function wrapDoc(name: string, text: string): string {
  const safe = text.replace(/<\/?документ/gi, '‹документ');
  return `<документ файл="${name.replace(/"/g, "'")}">\n${safe}\n</документ>`;
}

/**
 * Provenance for agent-made context changes: the responsible user gets an in-app
 * notification, so a change the agent was talked into (e.g. by text inside an
 * uploaded document) is visible and can be reverted in the sidebar.
 */
async function notifyAgentContextChange(wsId: string, what: string): Promise<void> {
  const ws = await getWorkspaceById(wsId);
  if (!ws?.responsible_user_id) return;
  await insertNotification(
    ws.responsible_user_id,
    wsId,
    'agent_context_change',
    `Постачання №${ws.number}: Штурман змінив контекст — ${what}. Перевірте на панелі.`,
  ).catch(() => undefined);
}

async function refreshAfterWorkspaceWrite(wsId: string): Promise<void> {
  const merged = (await getWorkspaceById(wsId))!;
  const complete = Boolean(
    merged.contract_type &&
      merged.product_category &&
      (merged.incoterm_in ?? merged.incoterm) &&
      merged.transport_mode &&
      merged.origin_country,
  );
  if (complete !== merged.intake_complete) {
    await query('UPDATE workspaces SET intake_complete = $2 WHERE id = $1', [wsId, complete]);
  }
  const finalWs = (await getWorkspaceById(wsId))!;
  if (finalWs.intake_complete) await refreshWorkspaceState(finalWs);
}

// Ukrainian labels for the two contract structures, used in tool output.
const CONTRACT_MODE_UK: Record<'bilateral' | 'trilateral', string> = {
  bilateral: 'двосторонній (2 сторони: постачальник → AGroup95)',
  trilateral: 'тристоронній (3 сторони: постачальник → PrimeForce → AGroup95)',
};

async function runGetContractMode(ctx: ToolContext): Promise<ToolOutcome> {
  const wsId = requireWorkspace(ctx);
  const ws = await getWorkspaceById(wsId);
  if (!ws) return { result: 'Постачання не знайдено.', summary: 'Режим: помилка', citations: [] };

  const analysis = await analyzeParties(wsId);
  const manual = ws.contract_type_source === 'sidebar' || ws.contract_type_source === 'survey';

  const storedLine = ws.contract_type
    ? `Збережено: ${CONTRACT_MODE_UK[ws.contract_type]} — джерело: ${
        manual
          ? 'встановлено вручну (не перезаписувати автоматично)'
          : ws.contract_type_source === 'auto'
            ? 'автовизначено'
            : 'невідоме'
      }.`
    : 'Збережено: режим ще не задано.';

  const autoLine = analysis.contract_type
    ? `За документами: ${CONTRACT_MODE_UK[analysis.contract_type]} — впевненість ${Math.round(
        analysis.contract_type_confidence * 100,
      )}%. ${analysis.contract_type_reason}`
    : `За документами визначити не вдалося: ${analysis.contract_type_reason}`;

  const hint = manual
    ? 'Значення встановлене вручну — set_contract_mode source="auto" його не змінить. Щоб ' +
      'змінити, потрібне підтвердження користувача (source="survey").'
    : analysis.contract_type
      ? 'Щоб зафіксувати авто-висновок, виклич set_contract_mode source="auto".'
      : 'Даних недостатньо — уточни в користувача або запусти опитування.';

  return {
    result: `${storedLine}\n${autoLine}\n${hint}`,
    summary: `Режим: ${ws.contract_type ?? 'не задано'}`,
    citations: [],
  };
}

const setContractModeSchema = z.object({
  source: z.enum(['auto', 'survey']),
  contract_type: z.enum(['bilateral', 'trilateral']).optional(),
});

async function runSetContractMode(input: unknown, ctx: ToolContext): Promise<ToolOutcome> {
  const parsed = setContractModeSchema.safeParse(input ?? {});
  if (!parsed.success) {
    return { result: 'Некоректні дані для set_contract_mode.', summary: 'Режим: помилка', citations: [] };
  }
  const wsId = requireWorkspace(ctx);
  const ws = await getWorkspaceById(wsId);
  if (!ws) return { result: 'Постачання не знайдено.', summary: 'Режим: помилка', citations: [] };

  if (parsed.data.source === 'auto') {
    // Auto path re-derives the verdict deterministically — the model's
    // contract_type is ignored to prevent persisting a hallucinated mode.
    const analysis = await analyzeParties(wsId);
    if (!analysis.contract_type) {
      return {
        result: `Автовизначення неможливе: ${analysis.contract_type_reason} Уточни в користувача або запусти опитування.`,
        summary: 'Режим: не визначено',
        citations: [],
      };
    }
    // Honor the manual-override lock — never overwrite a human-set value.
    if (ws.contract_type_source === 'sidebar' || ws.contract_type_source === 'survey') {
      return {
        result:
          `Режим уже встановлено вручну (${ws.contract_type ? CONTRACT_MODE_UK[ws.contract_type] : '—'}). ` +
          'Автовизначення не перезаписує ручне значення. За документами: ' +
          `${CONTRACT_MODE_UK[analysis.contract_type]} (впевненість ${Math.round(
            analysis.contract_type_confidence * 100,
          )}%).`,
        summary: 'Режим: залишено ручне значення',
        citations: [],
      };
    }
    await query(
      `UPDATE workspaces SET contract_type = $2, contract_type_source = 'auto',
         contract_type_confidence = $3, contract_type_reason = $4 WHERE id = $1`,
      [wsId, analysis.contract_type, analysis.contract_type_confidence, analysis.contract_type_reason],
    );
    await refreshAfterWorkspaceWrite(wsId);
    return {
      result:
        `Збережено режим (авто): ${CONTRACT_MODE_UK[analysis.contract_type]}, впевненість ` +
        `${Math.round(analysis.contract_type_confidence * 100)}%. ${analysis.contract_type_reason}`,
      summary: `Режим (авто): ${analysis.contract_type}`,
      citations: [],
    };
  }

  // source === 'survey' — user-confirmed; wins over any prior value (incl. auto/manual).
  const ct = parsed.data.contract_type;
  if (!ct) {
    return {
      result: 'Для source="survey" вкажи contract_type (bilateral|trilateral) — те, що підтвердив користувач.',
      summary: 'Режим: бракує contract_type',
      citations: [],
    };
  }
  await query(
    `UPDATE workspaces SET contract_type = $2, contract_type_source = 'survey',
       contract_type_confidence = NULL, contract_type_reason = $3 WHERE id = $1`,
    [wsId, ct, 'Підтверджено користувачем у розмові.'],
  );
  await refreshAfterWorkspaceWrite(wsId);
  await notifyAgentContextChange(wsId, `режим контракту → ${CONTRACT_MODE_UK[ct]}`);
  return {
    result: `Збережено режим (підтверджено користувачем): ${CONTRACT_MODE_UK[ct]}.`,
    summary: `Режим (survey): ${ct}`,
    citations: [],
  };
}

async function runClassifyAndFile(input: unknown, ctx: ToolContext): Promise<ToolOutcome> {
  const fileId = String((input as { file_id?: unknown })?.file_id ?? '').trim();
  if (!fileId) return { result: 'Не вказано file_id.', summary: 'Класифікація: помилка', citations: [] };
  const res = await classifyAndFile(requireWorkspace(ctx), fileId);
  if (!res) return { result: 'Файл не знайдено.', summary: 'Класифікація: не знайдено', citations: [] };
  if (!res.to) {
    // Low-confidence guess left in inbox with a suggestion, or truly unclassified.
    const suggestion = res.suggested
      ? ` Схоже на теку ${res.suggested} (${res.reason}) — підтвердіть вручну.`
      : '';
    return {
      result: `Не вдалося впевнено визначити теку для «${res.name}» — залишено в інбоксі.${suggestion}`,
      summary: 'Класифікація: потрібне підтвердження',
      citations: [],
    };
  }
  return {
    result: `Файл «${res.name}» переміщено до теки ${res.to}. Причина: ${res.reason}.`,
    summary: `Переміщено: ${res.name} → ${res.to}`,
    citations: [],
  };
}

async function runCompareVersions(input: unknown, ctx: ToolContext): Promise<ToolOutcome> {
  const fileId = String((input as { file_id?: unknown })?.file_id ?? '').trim();
  if (!fileId) return { result: 'Не вказано file_id.', summary: 'Порівняння: помилка', citations: [] };
  const prev = await previousVersionId(requireWorkspace(ctx), fileId);
  if (!prev) {
    return {
      result: 'У цього файлу немає попередньої версії для порівняння.',
      summary: 'Порівняння: немає попередньої версії',
      citations: [],
    };
  }
  const cmp = await compareFileVersions(requireWorkspace(ctx), fileId, prev);
  if (!cmp) return { result: 'Файл не знайдено в постачанні.', summary: 'Порівняння: не знайдено', citations: [] };
  if (cmp.differences.length === 0) {
    return {
      result: 'Структуровані поля нової та попередньої версії збігаються — змін немає.',
      summary: 'Порівняння: без змін',
      citations: [],
    };
  }
  const lines = cmp.differences.map(
    (d) => `- ${d.field}: було «${fmt(d.b)}» → стало «${fmt(d.a)}»`,
  );
  return {
    result: `Зміни щодо попередньої версії:\n${lines.join('\n')}`,
    summary: `Порівняння: ${cmp.differences.length} змін`,
    citations: [],
  };
}

function fmt(v: unknown): string {
  return v === null || v === undefined || v === '' ? '—' : String(v);
}

async function runGenerateReport(ctx: ToolContext): Promise<ToolOutcome> {
  const ws = await getWorkspaceById(requireWorkspace(ctx));
  if (!ws) return { result: 'Постачання не знайдено.', summary: 'Звіт: помилка', citations: [] };
  const { id } = await buildAndSaveReport(ws);
  return {
    // Do not return the full HTML — just confirm; it's saved and exportable.
    result: `HTML-звіт по постачанню згенеровано та збережено (artifact ${id}). Його можна завантажити через експорт постачання.`,
    summary: 'Згенеровано звіт постачання',
    citations: [],
  };
}

async function runSortInbox(ctx: ToolContext): Promise<ToolOutcome> {
  const { moved, unclassified } = await sortInbox(requireWorkspace(ctx));
  if (moved.length === 0 && unclassified.length === 0) {
    return { result: 'Інбокс порожній — нема чого сортувати.', summary: 'Сортування: 0', citations: [] };
  }
  const lines = moved.map((m) => `- «${m.name}» → ${m.to}${m.reason ? ` (${m.reason})` : ''}`);
  for (const u of unclassified) {
    lines.push(
      u.suggested
        ? `- «${u.name}» — залишено в інбоксі, схоже на ${u.suggested} (${u.reason}) — підтвердіть вручну`
        : `- «${u.name}» — не визначено, залишено в інбоксі`,
    );
  }
  return {
    result: lines.join('\n'),
    summary: `Розкладено: ${moved.length}, не визначено: ${unclassified.length}`,
    citations: [],
  };
}

async function runNormalizeShipmentFiles(ctx: ToolContext): Promise<ToolOutcome> {
  // 1. Backfill content_hash for files that predate this feature.
  const { rows: unhashed } = await query<{ id: string; disk_path: string }>(
    `SELECT id, disk_path FROM files
     WHERE workspace_id = $1 AND is_latest = true AND content_hash IS NULL`,
    [requireWorkspace(ctx)],
  );
  let backfilled = 0;
  for (const f of unhashed) {
    try {
      const buf = await readStoredFile(f.disk_path);
      await query('UPDATE files SET content_hash = $2 WHERE id = $1', [f.id, contentHashOf(buf)]);
      backfilled++;
    } catch {
      // Stored bytes missing/unreadable — skip; not fatal for the rest of the sweep.
    }
  }

  // 2. Report (never delete) duplicate groups among is_latest files.
  const { rows: dupGroups } = await query<{ content_hash: string; names: string[]; ids: string[] }>(
    `SELECT content_hash, array_agg(name ORDER BY created_at) AS names, array_agg(id ORDER BY created_at) AS ids
     FROM files
     WHERE workspace_id = $1 AND is_latest = true AND content_hash IS NOT NULL
     GROUP BY content_hash HAVING COUNT(*) > 1`,
    [requireWorkspace(ctx)],
  );

  // 3. Bulk-retry currently-errored files (same primitive as POST …/reindex).
  const { rows: errored } = await query<{ id: string; name: string }>(
    `SELECT id, name FROM files WHERE workspace_id = $1 AND status = 'error'`,
    [requireWorkspace(ctx)],
  );
  for (const f of errored) {
    await query(`UPDATE files SET status = 'queued', error_reason = NULL WHERE id = $1`, [f.id]);
    await enqueueIndexJob(f.id);
    await publishFileStatus(requireWorkspace(ctx), { fileId: f.id, status: 'queued', name: f.name });
  }

  const lines: string[] = [];
  lines.push(`Донараховано хешів: ${backfilled}.`);
  if (dupGroups.length === 0) {
    lines.push('Дублікатів за вмістом не знайдено.');
  } else {
    lines.push(`Знайдено груп дублікатів: ${dupGroups.length} (файли НЕ видалено, це лише звіт):`);
    for (const g of dupGroups) lines.push(`- ${g.names.map((n) => `«${n}»`).join(' = ')}`);
  }
  lines.push(`Поставлено на повторну індексацію (були в статусі «Помилка»): ${errored.length}.`);

  return {
    result: lines.join('\n'),
    summary: `Нормалізація: хешів +${backfilled}, дублікатів ${dupGroups.length}, повторно проіндексовано ${errored.length}`,
    citations: [],
  };
}

async function runConsolidatedAnalysis(input: unknown, ctx: ToolContext): Promise<ToolOutcome> {
  if (!ctx.collectionId) {
    return { result: 'Аналіз доступний лише в межах збірника.', summary: 'Аналіз: помилка', citations: [] };
  }
  const sourceUrl = String((input as { source_url?: unknown })?.source_url ?? '').trim();
  const manifestText = String((input as { manifest_text?: unknown })?.manifest_text ?? '').trim();

  // Source: an explicit Google Sheets link / pasted table, else the collection's
  // latest uploaded manifest file.
  let analysisInput: AnalysisInput;
  if (sourceUrl) {
    analysisInput = { kind: 'sheetUrl', url: sourceUrl };
  } else if (manifestText) {
    analysisInput = { kind: 'text', text: manifestText };
  } else {
    const { rows } = await query<{ id: string; name: string; type: string; disk_path: string }>(
      `SELECT id, name, type, disk_path FROM files
       WHERE collection_id = $1 AND is_latest = true AND type IN ('xlsx', 'csv')
       ORDER BY created_at DESC LIMIT 1`,
      [ctx.collectionId],
    );
    const file = rows[0];
    if (!file) {
      return {
        result:
          'Немає джерела для аналізу: дайте посилання на Google Sheets, вставте таблицю, ' +
          'або завантажте файл-маніфест (xlsx/csv) у збірник.',
        summary: 'Аналіз: немає маніфесту',
        citations: [],
      };
    }
    try {
      const buf = await readStoredFile(file.disk_path);
      analysisInput = { kind: 'file', buffer: buf, filename: file.name };
    } catch {
      return { result: `Не вдалося прочитати файл «${file.name}».`, summary: 'Аналіз: помилка читання', citations: [] };
    }
  }

  let result;
  try {
    result = await runAnalysis(analysisInput, ctx.ownerId);
  } catch (err) {
    return { result: `Аналіз не вдався: ${(err as Error).message}`, summary: 'Аналіз: помилка', citations: [] };
  }

  // Persist (best-effort — still return the computed result on failure).
  if (ctx.ownerId) {
    try {
      await persistAnalysis(ctx.ownerId, ctx.collectionId, result);
    } catch {
      /* persistence failed — the analysis text is still useful this turn */
    }
  }

  // Return the ready per-product answer; the agent presents it to the user as-is.
  return {
    result: formatAnalysisMarkdown(result),
    summary: `Аналіз збірника: ${result.totals.count} позицій`,
    citations: [],
  };
}

async function runSearch(input: unknown, ctx: ToolContext): Promise<ToolOutcome> {
  const q = String((input as { query?: unknown })?.query ?? '').trim();
  if (!q) return { result: 'Порожній запит.', summary: 'Пошук: порожній запит', citations: [] };

  const wsId = requireWorkspace(ctx);
  const hits = await searchWorkspace(wsId, q); // top-K 24, diversified per doc
  const cov = await workspaceCoverage(wsId).catch(() => ({ sections: 0, files: 0, unconverted: 0 }));
  const pending =
    cov.unconverted > 0
      ? `\n\n(${cov.unconverted} файл(ів) ще обробляються і в пошук не потрапили — за потреби прочитай їх через read_file.)`
      : '';

  if (hits.length === 0) {
    return {
      result:
        'Пошук за ключовими словами нічого не знайшов. Це пошук по словах (не за змістом): ' +
        'спробуй інші формулювання/синоніми/номери, або виклич list_files і прочитай потрібний файл ' +
        'повністю через read_file.' +
        pending,
      summary: 'Пошук: 0 результатів',
      citations: [],
    };
  }

  const citations = dedupeCitations(hits.map((h) => ({ file: h.file, page: h.page })));
  const result = hits
    .map((h, i) => {
      const loc = h.page ? `, стор. ${h.page}` : '';
      const fold = h.folder ? ` (${h.folder})` : '';
      return `[${i + 1}] ${h.file}${loc}${fold}\n${wrapDoc(h.file, h.text)}`;
    })
    .join('\n\n');
  const files = [...new Set(hits.map((h) => h.file))];
  // Tell the agent this is a partial top-matches view, not the whole corpus.
  const scale =
    cov.sections > hits.length
      ? `\n\n(Показано ${hits.length} з ${cov.sections} фрагментів — це топ-збіги, не повний перегляд. ` +
        'Для аналізу документа прочитай його повністю через read_file.)'
      : '';
  return {
    result: result + scale + pending,
    summary: `Знайдено ${hits.length} фрагм. у: ${files.join(', ')}`,
    citations,
  };
}

async function runReadFile(input: unknown, ctx: ToolContext): Promise<ToolOutcome> {
  const path = String((input as { path?: unknown })?.path ?? '').trim();
  const fileId = String((input as { file_id?: unknown })?.file_id ?? '').trim();
  const range = (input as { range?: unknown })?.range;
  if (!path && !fileId) {
    return { result: 'Не вказано файл (path або file_id).', summary: 'Читання: не вказано файл', citations: [] };
  }

  const file = await findFile(requireWorkspace(ctx), path, fileId);
  if (!file) {
    return {
      result: `Файл "${path || fileId}" не знайдено в постачанні. Виклич list_files, щоб побачити точні назви/ID.`,
      summary: `Файл не знайдено: ${path || fileId}`,
      citations: [],
    };
  }

  // Read the ingest-time Markdown (Claude's transcription). Files indexed before
  // the Markdown pipeline existed are converted on first read and stored.
  let stored = await loadFileMarkdown(file.id);
  if (!stored && (file.status === 'queued' || file.status === 'indexing')) {
    // The worker is converting it right now — don't duplicate the (vision) cost inline.
    return {
      result: `Файл "${file.name}" ще обробляється (розпізнавання в Markdown). Спробуй прочитати його трохи пізніше.`,
      summary: `Читання: ${file.name} (ще обробляється)`,
      citations: [{ file: file.name, page: null }],
    };
  }
  if (!stored) {
    const buf = await readStoredFile(file.disk_path);
    const conv = await convertToMarkdown(buf, file.type, file.name);
    await saveFileMarkdown(file.id, requireWorkspace(ctx), conv).catch(() => undefined);
    stored = {
      pages: conv.pages,
      converter: conv.converter,
      partial: conv.partial,
      pageCount: conv.pageCount,
      note: conv.note,
      charCount: conv.pages.reduce((n, p) => n + p.markdown.length, 0),
    };
  }
  let pages = stored.pages.map((p) => ({ page: p.page, text: p.markdown }));
  if (pages.length === 0) {
    return {
      result:
        `Файл "${file.name}" не містить тексту, який вдалося розпізнати.` +
        (stored.note ? ` Причина: ${stored.note}` : ''),
      summary: `Читання: ${file.name} (без тексту)`,
      citations: [{ file: file.name, page: null }],
    };
  }

  // Optional page range "N-M" for paged formats.
  if (typeof range === 'string' && /^\d+-\d+$/.test(range) && pages.some((p) => p.page)) {
    const [from, to] = range.split('-').map(Number) as [number, number];
    pages = pages.filter((p) => p.page !== null && p.page >= from && p.page <= to);
  }

  let text = joinPages(pages.map((p) => ({ page: p.page, markdown: p.text })));

  // Optional char range "0-2000".
  if (typeof range === 'string' && /^\d+-\d+$/.test(range) && !pages.some((p) => p.page)) {
    const [from, to] = range.split('-').map(Number) as [number, number];
    text = text.slice(from, to);
  }

  // Raised from 12000: the agent used to see only ~4-5 pages of any file and stop.
  const MAX = 50000;
  const fullLen = text.length;
  const truncated = fullLen > MAX;
  if (truncated) {
    const pageCount = pages.filter((p) => p.page !== null).length;
    const hint = pageCount
      ? ` Показано перші ~${MAX} символів із ${fullLen} (${pageCount} стор.). Щоб дочитати, виклич read_file з range (напр. "6-12" за сторінками).`
      : ` Показано перші ${MAX} із ${fullLen} символів. Щоб дочитати, виклич read_file з range="${MAX}-${Math.min(fullLen, MAX * 2)}".`;
    text = `${text.slice(0, MAX)}\n…[обрізано —${hint}]`;
  }

  const citations = dedupeCitations(pages.map((p) => ({ file: file.name, page: p.page })));
  const quality = stored.partial || stored.note ? `\n(Увага: ${stored.note ?? 'документ розпізнано не повністю'}.)` : '';
  return {
    result: `Файл: ${file.name} (Markdown${stored.pageCount ? `, ${stored.pageCount} стор.` : ''})${quality}\n${wrapDoc(file.name, text)}`,
    summary: `Прочитано: ${file.name}${truncated ? ' (частково)' : ''}`,
    citations: citations.length ? citations : [{ file: file.name, page: null }],
  };
}

async function runListFiles(ctx: ToolContext): Promise<ToolOutcome> {
  const files = await listFiles(requireWorkspace(ctx));
  if (files.length === 0) {
    return { result: 'У постачанні поки немає файлів.', summary: 'Список файлів: порожньо', citations: [] };
  }
  const byFolder = new Map<string, FileRow[]>();
  for (const f of files) {
    const key = f.folder_name ?? '(корінь)';
    (byFolder.get(key) ?? byFolder.set(key, []).get(key)!).push(f);
  }
  const lines: string[] = [];
  for (const [folder, group] of byFolder) {
    lines.push(`${folder}:`);
    for (const f of group) {
      const dt = f.doc_type ? `, тип: ${f.doc_type}` : '';
      lines.push(`  - ${f.name} [${statusLabel(f.status)}${dt}] (id: ${f.id})`);
    }
  }
  return { result: lines.join('\n'), summary: `Список файлів: ${files.length}`, citations: [] };
}

function statusLabel(status: string): string {
  return status === 'ready'
    ? 'проіндексовано'
    : status === 'indexing'
      ? 'індексується'
      : status === 'error'
        ? 'помилка'
        : 'у черзі';
}

async function findFile(
  workspaceId: string,
  path: string,
  fileId?: string,
): Promise<FileRow | null> {
  // 1) Exact id (most reliable, from list_files).
  if (fileId) {
    const { rows } = await query<FileRow>(
      `SELECT f.id, f.name, f.type, f.disk_path, f.status, fo.name AS folder_name
       FROM files f LEFT JOIN folders fo ON fo.id = f.folder_id
       WHERE f.workspace_id = $1 AND f.id = $2 LIMIT 1`,
      [workspaceId, fileId],
    );
    if (rows[0]) return rows[0];
  }
  if (!path) return null;
  const name = path.split(/[/\\]/).pop() ?? path;
  // 2) Exact (case-insensitive) name.
  const exact = await query<FileRow>(
    `SELECT f.id, f.name, f.type, f.disk_path, f.status, fo.name AS folder_name
     FROM files f LEFT JOIN folders fo ON fo.id = f.folder_id
     WHERE f.workspace_id = $1 AND lower(f.name) = lower($2)
     ORDER BY f.is_latest DESC, f.version DESC, f.created_at DESC
     LIMIT 1`,
    [workspaceId, name],
  );
  if (exact.rows[0]) return exact.rows[0];
  // 3) Fuzzy: name contains the query (or vice-versa) — tolerate an approximate name.
  const fuzzy = await query<FileRow>(
    `SELECT f.id, f.name, f.type, f.disk_path, f.status, fo.name AS folder_name
     FROM files f LEFT JOIN folders fo ON fo.id = f.folder_id
     WHERE f.workspace_id = $1 AND f.is_latest = true AND lower(f.name) LIKE '%' || lower($2) || '%'
     ORDER BY length(f.name) ASC, f.created_at DESC
     LIMIT 1`,
    [workspaceId, name],
  );
  return fuzzy.rows[0] ?? null;
}

async function listFiles(workspaceId: string): Promise<FileRow[]> {
  const { rows } = await query<FileRow>(
    `SELECT f.id, f.name, f.type, f.disk_path, f.status, fo.name AS folder_name,
            de.extracted_fields->>'doc_type' AS doc_type
     FROM files f
     LEFT JOIN folders fo ON fo.id = f.folder_id
     LEFT JOIN LATERAL (
       SELECT extracted_fields FROM document_extractions
       WHERE file_id = f.id ORDER BY extracted_at DESC LIMIT 1
     ) de ON true
     WHERE f.workspace_id = $1
     ORDER BY fo.position NULLS LAST, f.created_at`,
    [workspaceId],
  );
  return rows;
}

function dedupeCitations(citations: Citation[]): Citation[] {
  const seen = new Set<string>();
  const out: Citation[] = [];
  for (const c of citations) {
    const key = `${c.file}#${c.page ?? ''}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push(c);
    }
  }
  return out;
}
