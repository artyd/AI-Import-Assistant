// The package root (`pdf-parse`) runs a debug block that reads a bundled test
// PDF at import time, which throws in production. We import the lib entry
// (`pdf-parse/lib/pdf-parse.js`) instead, which has no such side effect. This
// ambient declaration types that subpath.
declare module 'pdf-parse/lib/pdf-parse.js' {
  interface PdfData {
    numpages: number;
    numrender: number;
    info: unknown;
    metadata: unknown;
    text: string;
    version: string;
  }
  interface PdfOptions {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    pagerender?: (pageData: any) => string | Promise<string>;
    max?: number;
    version?: string;
  }
  function pdf(dataBuffer: Buffer | Uint8Array, options?: PdfOptions): Promise<PdfData>;
  export default pdf;
}
