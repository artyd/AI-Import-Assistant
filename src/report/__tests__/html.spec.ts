import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { buildFacts } from '../facts.js';
import { renderReportHtml } from '../html.js';
import { base } from './fixture.js';

describe('report html', () => {
  it('renders the Метопрен facts with key figures and escapes text', () => {
    const html = renderReportHtml(buildFacts(base), 'Резюме <тест>');
    expect(html).toContain('$8');
    expect(html).toContain('Розмитнено 31.07.2026');
    expect(html).toContain('Резюме &lt;тест&gt;');
    expect(html).toContain('Bila Tserkva');
    if (process.env.REPORT_OUT) fs.writeFileSync(process.env.REPORT_OUT, html);
  });
});

import { shortName } from '../html.js';
describe('shortName', () => {
  it('strips legal forms and the bilingual tail', () => {
    expect(shortName('«TEKHINFORM PLUS» LLC / ТОВ «ТЕХІНФОРМ ПЛЮС»')).toBe('TEKHINFORM PLUS');
    expect(shortName('PRIME FORCE UK BUSINESS LIMITED')).toBe('PRIME FORCE UK');
    expect(shortName('NGL Fine-Chem Limited')).toBe('NGL Fine-Chem');
  });
});
