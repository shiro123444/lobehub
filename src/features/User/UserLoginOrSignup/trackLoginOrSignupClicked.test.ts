import * as analyticsModule from '@lobehub/analytics';
import { describe, expect, it, vi } from 'vitest';

import { trackLoginOrSignupClicked } from './trackLoginOrSignupClicked';

describe('authentication analytics', () => {
  it('does not block authentication while analytics initialization is pending', async () => {
    const initialize = vi.fn(() => new Promise<void>(() => {}));
    const spy = vi.spyOn(analyticsModule, 'getSingletonAnalyticsOptional').mockReturnValue({
      getStatus: () => ({ initialized: false }),
      initialize,
      track: vi.fn(),
    } as never);
    try {
      await expect(
        trackLoginOrSignupClicked({ spm: 'signin.password_step.submit' }),
      ).resolves.toBeUndefined();
      expect(initialize).toHaveBeenCalledOnce();
    } finally {
      spy.mockRestore();
    }
  });
});
