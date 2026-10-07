import { executeTool, logistTools } from '../../agent/tools.js';
import { getRegistration } from '../drugRegistry.js';
import { portStatusTool, publicTrackTool } from '../../agent/hubTools.js';

/**
 * Public MCP server (Streamable HTTP, stateless, JSON responses only).
 *
 * Exposes Штурман's scope-less reference lookups — УКТ ЗЕД довідка/класифікатор,
 * подвійне використання, курс НБУ, PubChem, Держреєстр ліків — to external MCP
 * clients (Claude, Cursor, Claude Code…). No shipment data is reachable here:
 * every tool is a read-only reference query, so a leaked token exposes nothing
 * private. The logist tools reuse the agent's own handlers (same digest/format).
 *
 * Protocol: each POST carries one JSON-RPC message (or a legacy batch array);
 * requests get a JSON response, notifications get 202. No sessions, no SSE.
 */

export const SUPPORTED_PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const LATEST_PROTOCOL_VERSION = SUPPORTED_PROTOCOL_VERSIONS[0]!;

const SERVER_INFO = { name: 'shturman', title: 'Shturman', version: '1.0.0' };

const INSTRUCTIONS =
  'Штурман (Shturman) — довідкові інструменти для імпорту в Україну: митна довідка за кодом ' +
  'УКТ ЗЕД (мито, ПДВ, пільги, ліцензування, обмеження, документи — джерело qdpro.com.ua), ' +
  'навігація по класифікатору УКТ ЗЕД і по списку товарів подвійного використання, курс НБУ, ' +
  'ідентифікація речовини (PubChem), перевірка реєстрації лікарського засобу в Держреєстрі, ' +
  'відстеження вантажу за номером (контейнер, B/L, AWB, курʼєр, Нова Пошта/Укрпошта). ' +
  'Підбір коду УКТ ЗЕД — довідковий: пропонуй кілька кандидатів з обґрунтуванням і нагадуй, ' +
  'що остаточно код підтверджує митний фахівець. Ставки/вимоги бери з інструментів, не з памʼяті.';

interface McpTool {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: Record<string, boolean | string>;
}

const TITLES: Record<string, string> = {
  uktzed_lookup_code: 'УКТ ЗЕД: митна довідка за кодом',
  uktzed_browse_classifier: 'УКТ ЗЕД: класифікатор',
  dualuse_browse_classifier: 'Товари подвійного використання',
  get_exchange_rate: 'Курс НБУ',
  pubchem_identify_substance: 'PubChem: ідентифікація речовини',
  check_drug_registration: 'Держреєстр ліків України',
  track_by_number: 'Трекінг вантажу за номером',
  get_port_status: 'Чи працює порт / аеропорт / кордон',
};

const REGISTRY_TOOL = {
  name: 'check_drug_registration',
  description:
    'Перевірка реєстраційного посвідчення лікарського засобу за номером (напр. UA/19603/01/01) ' +
    'у локальній копії Державного реєстру лікарських засобів України: назва, діюча речовина, ' +
    'форма, виробник і країна, власник РП, строк дії. Довідково — остаточне рішення за ' +
    'регуляторним фахівцем.',
  input_schema: {
    type: 'object',
    properties: {
      reg_number: { type: 'string', description: 'Реєстраційний номер, напр. "UA/19603/01/01".' },
    },
    required: ['reg_number'],
  },
};

interface CustomToolDef {
  name: string;
  description?: string;
  input_schema: unknown;
}

function toolCatalog(): McpTool[] {
  // logistTools() are all plain custom tools (name/description/input_schema).
  const defs = [...(logistTools() as CustomToolDef[]), REGISTRY_TOOL, publicTrackTool as CustomToolDef, portStatusTool as CustomToolDef];
  return defs.map((d) => ({
    name: d.name,
    title: TITLES[d.name] ?? d.name,
    description: d.description ?? '',
    inputSchema: d.input_schema as Record<string, unknown>,
    annotations: {
      title: TITLES[d.name] ?? d.name,
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: d.name !== 'check_drug_registration',
    },
  }));
}

async function runRegistryLookup(input: unknown): Promise<{ text: string; isError: boolean }> {
  const reg = String((input as { reg_number?: unknown })?.reg_number ?? '').trim();
  if (!reg) return { text: 'Не вказано реєстраційний номер.', isError: true };
  const r = await getRegistration(reg);
  if (!r) {
    return {
      text: `Номер ${reg} не знайдено в локальній копії Держреєстру лікарських засобів. Даних немає — перевірте номер або зверніться до drlz.com.ua.`,
      isError: false,
    };
  }
  const validity = r.valid_unlimited ? 'безстроково' : `${r.valid_from ?? '—'} — ${r.valid_to ?? '—'}`;
  const lines = [
    `Реєстраційне посвідчення ${r.reg_number} (джерело: Держреєстр ЛЗ України, локальна копія):`,
    `- Назва: ${r.product_name ?? '—'}`,
    `- Діюча речовина: ${r.active_substance ?? '—'}`,
    `- Форма випуску: ${r.dosage_form ?? '—'}`,
    `- Виробник: ${r.manufacturer ?? '—'}${r.manufacturer_country ? ` (${r.manufacturer_country})` : ''}`,
    `- Власник РП: ${r.mah_owner ?? '—'}`,
    `- Строк дії: ${validity}`,
  ];
  return { text: lines.join('\n'), isError: false };
}

async function callTool(name: string, args: unknown): Promise<{ content: { type: 'text'; text: string }[]; isError: boolean }> {
  if (!toolCatalog().some((t) => t.name === name)) {
    throw new RpcError(-32602, `Unknown tool: ${name}`);
  }
  if (name === 'check_drug_registration') {
    const r = await runRegistryLookup(args);
    return { content: [{ type: 'text', text: r.text }], isError: r.isError };
  }
  // Logist tools are scope-less: an empty context is all they need.
  const out = await executeTool(name, args ?? {}, {});
  const failed = out.summary.endsWith('помилка');
  const sources = out.citations.map((c) => c.file).filter(Boolean);
  const text = sources.length ? `${out.result}\n\nДжерело: ${sources.join(', ')}` : out.result;
  return { content: [{ type: 'text', text }], isError: failed };
}

class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

interface RpcMessage {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: unknown;
}

type RpcResponse =
  | { jsonrpc: '2.0'; id: string | number | null; result: unknown }
  | { jsonrpc: '2.0'; id: string | number | null; error: { code: number; message: string } };

function isId(v: unknown): v is string | number {
  return typeof v === 'string' || typeof v === 'number';
}

async function dispatch(method: string, params: Record<string, unknown>): Promise<unknown> {
  switch (method) {
    case 'initialize': {
      const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      return {
        protocolVersion: SUPPORTED_PROTOCOL_VERSIONS.includes(requested) ? requested : LATEST_PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions: INSTRUCTIONS,
      };
    }
    case 'ping':
      return {};
    case 'tools/list':
      return { tools: toolCatalog() };
    case 'tools/call': {
      const name = typeof params.name === 'string' ? params.name : '';
      if (!name) throw new RpcError(-32602, 'Missing tool name');
      return callTool(name, params.arguments);
    }
    case 'resources/list':
      return { resources: [] };
    case 'resources/templates/list':
      return { resourceTemplates: [] };
    case 'prompts/list':
      return { prompts: [] };
    default:
      throw new RpcError(-32601, `Method not found: ${method}`);
  }
}

/** Handles one JSON-RPC message; returns null for notifications/responses. */
async function handleOne(msg: unknown): Promise<RpcResponse | null> {
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) {
    return { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } };
  }
  const m = msg as RpcMessage;
  if (typeof m.method !== 'string') {
    // A client response (to a server request we never send) or garbage — ignore
    // responses, reject anything else that carries an id.
    return null;
  }
  if (!isId(m.id)) return null; // notification (initialized, cancelled, …)
  const params = m.params && typeof m.params === 'object' ? (m.params as Record<string, unknown>) : {};
  try {
    const result = await dispatch(m.method, params);
    return { jsonrpc: '2.0', id: m.id, result };
  } catch (err) {
    if (err instanceof RpcError) {
      return { jsonrpc: '2.0', id: m.id, error: { code: err.code, message: err.message } };
    }
    return { jsonrpc: '2.0', id: m.id, error: { code: -32603, message: (err as Error).message || 'Internal error' } };
  }
}

/**
 * Processes a POST body. Returns the response payload, or null when the body
 * held only notifications/responses (the route answers 202 Accepted).
 */
export async function handleMcpPayload(body: unknown): Promise<RpcResponse | RpcResponse[] | null> {
  if (Array.isArray(body)) {
    if (body.length === 0) return { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } };
    const out = (await Promise.all(body.map(handleOne))).filter((r): r is RpcResponse => r !== null);
    return out.length ? out : null;
  }
  return handleOne(body);
}
