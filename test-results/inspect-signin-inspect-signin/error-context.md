# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: inspect-signin.spec.ts >> inspect signin
- Location: ../../../../tmp/lobe-inspect/inspect-signin.spec.ts:3:5

# Error details

```
Error: expect(locator).toContainText(expected) failed

Locator: locator('body')
Expected pattern: /./
Received string:  ""
Timeout: 5000ms

Call log:
  - Expect "toContainText" with timeout 5000ms
  - waiting for locator('body')
    14 × locator resolved to <body data-insp-path="src/app/layout.tsx:11:7:body">…</body>
       - unexpected value ""

```

# Test source

```ts
  1  | import { expect, test } from '@playwright/test';
  2  | 
  3  | test('inspect signin', async ({ page }) => {
  4  |   page.on('console', (msg) => {
  5  |     console.log(`console:${msg.type()}: ${msg.text()}`);
  6  |   });
  7  |   page.on('pageerror', (error) => {
  8  |     console.log(`pageerror:${error.message}`);
  9  |   });
  10 |   page.on('requestfailed', (request) => {
  11 |     console.log(`requestfailed:${request.url()}: ${request.failure()?.errorText}`);
  12 |   });
  13 | 
  14 |   await page.goto('http://127.0.0.1:3010/signin?callbackUrl=http%3A%2F%2F127.0.0.1%3A9876%2F', {
  15 |     waitUntil: 'networkidle',
  16 |     timeout: 30000,
  17 |   });
  18 | 
  19 |   console.log(`title:${await page.title()}`);
  20 |   console.log(`body:${await page.locator('body').innerText().catch((e) => `ERR:${e.message}`)}`);
> 21 |   await expect(page.locator('body')).toContainText(/./);
     |                                      ^ Error: expect(locator).toContainText(expected) failed
  22 | });
  23 | 
```