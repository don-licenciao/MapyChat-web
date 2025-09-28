import { describe, expect, it } from 'vitest';

import { guardOrThrow } from '../nsfwGuard';

const blockedSamples = [
  'ni' + 'ña',
  '15 yrs',
  'lo' + 'li',
  'in' + 'cest' + 'o',
  'best' + 'ialidad',
  '@persona con por' + 'no explícito',
];

const allowedSamples = [
  '17 años de experiencia en soporte técnico',
  'hace 14 años vi un documental interesante',
  'años después entendimos el problema',
  'antigüedad 15 años en la empresa',
  'tutorial sin contenido sexual ni violencia',
  'consulta técnica sobre despliegues',
];

describe('guardOrThrow', () => {
  it('bloquea frases que deben rechazarse', () => {
    const failures: string[] = [];
    for (const sample of blockedSamples) {
      try {
        guardOrThrow(sample);
        failures.push(sample);
      } catch {
        // Expected path
      }
    }
    expect(failures).toStrictEqual([]);
  });

  it('permite frases inocuas', () => {
    const violations: string[] = [];
    for (const sample of allowedSamples) {
      try {
        guardOrThrow(sample);
      } catch {
        violations.push(sample);
      }
    }
    expect(violations).toStrictEqual([]);
  });
});

