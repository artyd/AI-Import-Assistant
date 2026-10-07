import { describe, expect, it, vi } from 'vitest';

vi.mock('../../agent/tools.js', () => ({
  logistTools: () => [
    { name: 'uktzed_lookup_code', description: 'lookup', input_schema: { type: 'object', properties: {} } },
  ],
  executeTool: vi.fn(async (name: string) => ({
    result: `ok:${name}`,
    summary: 'УКТ ЗЕД 2941: довідка',
    citations: [{ file: 'https://qdpro.com.ua/x', page: null }],
  })),
}));
vi.mock('../drugRegistry.js', () => ({ getRegistration: vi.fn(async () => null) }));

const { handleMcpPayload } = await import('../mcp/server.js');

describe('MCP server', () => {
  it('negotiates the protocol version on initialize', async () => {
    const res = await handleMcpPayload({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
    expect(res).toMatchObject({ id: 1, result: { protocolVersion: '2025-06-18', serverInfo: { name: 'shturman' } } });
    const old = await handleMcpPayload({ jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '1999-01-01' } });
    expect((old as { result: { protocolVersion: string } }).result.protocolVersion).toBe('2025-11-25');
  });

  it('answers notifications with nothing', async () => {
    expect(await handleMcpPayload({ jsonrpc: '2.0', method: 'notifications/initialized' })).toBeNull();
  });

  it('lists the logist tools plus the registry lookup, all read-only', async () => {
    const res = (await handleMcpPayload({ jsonrpc: '2.0', id: 3, method: 'tools/list' })) as {
      result: { tools: { name: string; annotations: { readOnlyHint: boolean } }[] };
    };
    expect(res.result.tools.map((t) => t.name)).toEqual(['uktzed_lookup_code', 'check_drug_registration']);
    expect(res.result.tools.every((t) => t.annotations.readOnlyHint)).toBe(true);
  });

  it('calls a tool and appends its source', async () => {
    const res = (await handleMcpPayload({
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'uktzed_lookup_code', arguments: { code: '2941' } },
    })) as { result: { content: { text: string }[]; isError: boolean } };
    expect(res.result.isError).toBe(false);
    expect(res.result.content[0]!.text).toContain('ok:uktzed_lookup_code');
    expect(res.result.content[0]!.text).toContain('qdpro.com.ua');
  });

  it('says plainly when a registration is not in the registry', async () => {
    const res = (await handleMcpPayload({
      jsonrpc: '2.0',
      id: 5,
      method: 'tools/call',
      params: { name: 'check_drug_registration', arguments: { reg_number: 'UA/0/01/01' } },
    })) as { result: { content: { text: string }[] } };
    expect(res.result.content[0]!.text).toContain('не знайдено');
  });

  it('rejects unknown tools and methods', async () => {
    const tool = await handleMcpPayload({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'read_file' } });
    expect(tool).toMatchObject({ error: { code: -32602 } });
    const method = await handleMcpPayload({ jsonrpc: '2.0', id: 7, method: 'sampling/createMessage' });
    expect(method).toMatchObject({ error: { code: -32601 } });
  });
});
