
import type { ChatTool } from '../lib/anthropic/client.js';
import * as logist from '../customs/logist/index.js';
import { executeHubTool, isHubTool } from './tools/hub.js';
import { executeSheetTool, isSheetTool } from './tools/sheet.js';
import { type ToolContext, type ToolOutcome } from './tools/shared.js';
import { runUktzedLookup, runUktzedBrowse, runDualuseBrowse, runExchangeRate, runPubchemIdentify } from './tools/logist.js';
import { runChecklist, runDiscrepancies, runRegistryCheck, runRisks } from './tools/reconciliation.js';
import { runSupplierInstruction, runGetInstructionDraft, runProposeInstructionFields } from './tools/instruction.js';
import { runMissingContext, runSaveContext, runGetContractMode, runSetContractMode } from './tools/context.js';
import { runClassifyAndFile, runCompareVersions, runSortInbox, runNormalizeShipmentFiles } from './tools/files.js';
import { runGenerateReport } from './tools/report.js';
import { runConsolidatedAnalysis } from './tools/analysis.js';
import { runSearch, runReadFile, runListFiles, runFindFiles } from './tools/retrieval.js';
export type { ToolContext, ToolOutcome } from './tools/shared.js';

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
    name: 'find_files',
    description:
      'Шукає ФАЙЛИ постачання за назвою, номером документа, типом або словом із вмісту (напр. ' +
      '"export declaration", "报关单", "10122025/PVS", "HBL-C", "CHED", "контракт", "інструкц"). ' +
      'Повертає до 30 файлів із текою, типом, ознаками версії (чернетка / COPY / telex / переклад / ' +
      'дублікат) і ID. ОБОВʼЯЗКОВО виклич перед тим, як сказати, що документа в постачанні немає; ' +
      'пробуй кілька варіантів (номер, тип англійською/українською/мовою документа).',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Частина назви файлу, номер документа, тип або слово з вмісту.' },
      },
      required: ['query'],
    },
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
      'Повертає англійський лист-інструкцію постачальнику з конструктора (детермінований ' +
      'шаблон, остання збережена версія або автозаповнення). Якщо бракує обовʼязкових полів — ' +
      'поверне їх перелік. Для редагування інструкції користувач має екран «Інструкція».',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'get_instruction_draft',
    description:
      'Читає поточну інструкцію постачальнику з конструктора: усі поля, їх джерела, незаповнені ' +
      'обовʼязкові поля та вже запропоновані значення. Викликай першим, коли користувач питає про ' +
      'інструкцію або просить допомогти її заповнити.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'propose_instruction_fields',
    description:
      'ПРОПОНУЄ значення полів інструкції (НЕ зберігає): кожна пропозиція показується в конструкторі ' +
      'з кнопками «Прийняти/Відхилити». Пропонуй ЛИШЕ те, що знайшов у документах постачання (вкажи ' +
      'файл у reason) або що користувач прямо назвав у чаті. Не вигадуй контакти, адреси, номери. ' +
      'Шляхи полів: from.name, product.name, product.grade, product.cas, product.quantity, ' +
      'product.hsCode, product.regNumber, consignor.name, consignor.address, consignor.country, ' +
      'consignee.name, consignee.address, finalConsignee, contract.number, contract.date, ' +
      'terms.incoterm, terms.place, terms.destination, terms.finalDestination, labelNotes, ' +
      'originals.contact, originals.phone, originals.address, supplierEmail.',
    input_schema: {
      type: 'object',
      properties: {
        fields: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              path: { type: 'string' },
              value: { type: 'string' },
              reason: { type: 'string', description: 'Звідки значення (файл/сторінка або «зі слів користувача»).' },
            },
            required: ['path', 'value', 'reason'],
          },
        },
      },
      required: ['fields'],
    },
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
      'двосторонній (2 сторони: постачальник→імпортер) чи тристоронній (3 сторони: ' +
      'постачальник→посередник→імпортер). Рішення детерміноване (виробник vs продавець в ' +
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
      'встановлене вручну. Спершу виклич get_contract_mode. Після source="survey" сторони й ' +
      'конструктор інструкції вирівнюються автоматично (двосторонній: продавець стає «Хто», ' +
      '«Через кого» очищається; у чернетці інструкції зʼявляються пропозиції відправника/одержувача) — ' +
      'перекажи користувачу результат інструмента, а не проси правити поля вручну.',
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
    case 'find_files':
      return runFindFiles(input, ctx);
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
    case 'get_instruction_draft':
      return runGetInstructionDraft(ctx);
    case 'propose_instruction_fields':
      return runProposeInstructionFields(input, ctx);
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
      if (isHubTool(name)) return { ...(await executeHubTool(name, input, ctx)), citations: [] };
      if (isSheetTool(name)) return { ...(await executeSheetTool(name, input)), citations: [] };
      return { result: `Невідомий інструмент: ${name}`, summary: `Невідомий інструмент`, citations: [] };
  }
}
