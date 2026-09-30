'use strict';
const playwright = require('playwright');
const guard = require('./network-guard.cjs');
const { startProxy } = require('./loopback-proxy.cjs');

async function cleanly(steps) {
  const errors = [];
  for (const step of steps) { try { await step(); } catch (error) { errors.push(error); } }
  if (errors.length === 1) throw errors[0];
  if (errors.length) throw new AggregateError(errors, 'Contained lifecycle cleanup failed');
}

async function containContext(context) {
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (guard.isAllowedEndpoint(url.hostname, Number(url.port || (url.protocol === 'https:' ? 443 : 80)))) {
      return route.continue();
    }
    guard.poison('Unexpected browser request');
    await route.abort('blockedbyclient');
  });
  return context;
}
async function launch(options = {}) {
  guard.assertActive();
  if (options.proxy || options.executablePath || options.channel || options.ignoreDefaultArgs ||
      (options.args || []).some(arg => /proxy|quic|webrtc|remote-debugging|host-resolver/i.test(arg))) {
    guard.poison('browser-launch-override-denied');
    throw new Error('Containment forbids browser network/launcher overrides');
  }
  const proxy = await startProxy();
  let diagnosticPrinted = false;
  async function lifecycle(steps) {
    try { await cleanly(steps); } catch (error) {
      if (!diagnosticPrinted) {
        diagnosticPrinted = true;
        try { console.error(JSON.stringify({ proxyLifecycle: proxy.diagnostics() })); } catch {}
      }
      throw error;
    }
  }
  let browser;
  try {
    browser = await playwright.chromium.launch({ ...options,
      proxy: { server: proxy.url, bypass: '<-loopback>' },
      args: [...(options.args || []), '--disable-quic', '--force-webrtc-ip-handling-policy=disable_non_proxied_udp'] });
  } catch (error) {
    // Preserve the launch failure; the guard's sticky ledger still fails exit.
    try { await proxy.close(); } catch {}
    throw error;
  }
  const originalContext = browser.newContext.bind(browser);
  browser.newContext = async (configuration = {}) => {
    if (configuration.proxy) {
      guard.poison('browser-context-proxy-override-denied');
      throw new Error('Containment forbids context proxy overrides');
    }
    const context = await containContext(await originalContext(configuration));
    const closeContext = context.close.bind(context);
    context.close = (...args) => lifecycle([() => proxy.drain(), () => closeContext(...args)]);
    return context;
  };
  browser.newPage = async (configuration = {}) => {
    const context = await browser.newContext(configuration);
    const page = await context.newPage();
    const close = page.close.bind(page);
    page.close = (...args) => lifecycle([() => close(...args), () => context.close()]);
    return page;
  };
  const close = browser.close.bind(browser);
  browser.close = async (...args) => {
    proxy.beginBrowserClose();
    await lifecycle([() => proxy.drain(), () => close(...args), () => proxy.close(),
      () => proxy.assertClean(), () => guard.assertClean()]);
  };
  return browser;
}
function forbidden() {
  guard.assertActive();
  guard.poison('browser-uncontained-entrypoint-denied');
  throw new Error('Use the contained Chromium launch fixture');
}
const chromium = Object.freeze({ launch, executablePath: playwright.chromium.executablePath.bind(playwright.chromium),
  launchPersistentContext: forbidden, connect: forbidden, connectOverCDP: forbidden });
module.exports = { chromium };
