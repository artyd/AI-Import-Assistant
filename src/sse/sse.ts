import type { FastifyReply, FastifyRequest } from 'fastify';

/**
 * A hijacked Server-Sent Events response. We take manual control of the raw
 * Node response (reply.hijack) so we can write many named events over the
 * lifetime of one agentic turn.
 */
export class SseStream {
  private closed = false;
  private readonly raw: FastifyReply['raw'];
  private readonly abort = new AbortController();
  /**
   * Aborted when the CLIENT goes away before we finish (tab closed, navigation,
   * stop button) — pass it to long work (the agent loop / Anthropic stream) so a
   * disconnected user stops costing tokens.
   */
  readonly signal: AbortSignal = this.abort.signal;

  constructor(_req: FastifyRequest, reply: FastifyReply) {
    reply.hijack();
    this.raw = reply.raw;

    this.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      // Disable proxy buffering (nginx-style; harmless elsewhere).
      'X-Accel-Buffering': 'no',
    });
    // Prime the stream so intermediaries flush headers immediately.
    this.raw.write(': connected\n\n');

    // Track the RESPONSE, not the request: on Node ≥16 `req.raw` emits 'close' as
    // soon as the request BODY is consumed (≈ immediately for a POST), which
    // silently turned every later send()/close() into a no-op when the stream was
    // created early. The response 'close' reflects the connection; if it closes
    // before we ended the stream ourselves, the client disconnected.
    this.raw.on('close', () => {
      this.closed = true;
      if (!this.raw.writableFinished) this.abort.abort();
    });
  }

  get isClosed(): boolean {
    return this.closed;
  }

  /** Emit a named event with a JSON payload. */
  send(event: string, data: unknown): void {
    if (this.closed) return;
    this.raw.write(`event: ${event}\n`);
    this.raw.write(`data: ${JSON.stringify(data)}\n\n`);
  }

  /** Send a comment as a keep-alive heartbeat. */
  ping(): void {
    if (this.closed) return;
    this.raw.write(': ping\n\n');
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.raw.end();
  }
}
