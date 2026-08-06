import type { FastifyReply, FastifyRequest } from 'fastify';

/**
 * A hijacked Server-Sent Events response. We take manual control of the raw
 * Node response (reply.hijack) so we can write many named events over the
 * lifetime of one agentic turn.
 */
export class SseStream {
  private closed = false;
  private readonly raw: FastifyReply['raw'];

  constructor(req: FastifyRequest, reply: FastifyReply) {
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

    req.raw.on('close', () => {
      this.closed = true;
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
