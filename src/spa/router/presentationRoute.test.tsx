import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Guards the C-58 PresentationStudio route registration. The desktop router
 * configs must stay in sync — desktopRouter.sync.test.tsx only asserts parity,
 * this one asserts the presentation route actually exists in both.
 */
const readRouterSources = () =>
  Promise.all([
    readFileSync(join(process.cwd(), 'src/spa/router/desktopRouter.config.tsx'), 'utf8'),
    readFileSync(join(process.cwd(), 'src/spa/router/desktopRouter.config.desktop.tsx'), 'utf8'),
  ]);

describe('presentation route registration', () => {
  it('registers the /presentation route in the web (async) router config', async () => {
    const [asyncSource] = await readRouterSources();

    expect(asyncSource).toContain("path: 'presentation'");
    expect(asyncSource).toContain("import('@/routes/(main)/presentation')");
  });

  it('registers the /presentation route in the desktop (Electron sync) router config', async () => {
    const [, syncSource] = await readRouterSources();

    expect(syncSource).toContain("path: 'presentation'");
    expect(syncSource).toContain("from '@/routes/(main)/presentation'");
  });
});
