import { describe, expect, it, expectTypeOf } from 'vitest';

import {
  PRESENTATION_OPERATIONS,
  type PresentationCapabilityCommand,
  type PresentationCapabilityResult,
  type PresentationOperation,
} from './index';

describe('presentation capability contracts', () => {
  it('exports the six strategy operations', () => {
    expect(PRESENTATION_OPERATIONS).toEqual([
      'create',
      'inspect',
      'edit',
      'preview',
      'export',
      'retry',
      'cancel',
    ]);
    expectTypeOf<PresentationOperation>().toEqualTypeOf<
      PresentationCapabilityCommand['operation']
    >();
    expectTypeOf<PresentationCapabilityResult>().toBeObject();
  });
});
