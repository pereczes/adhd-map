#!/usr/bin/env node
/* Drives the map in headless Chrome over the DevTools Protocol: loads the
 * page, clicks real nodes, checks that neighbours appear, switches the
 * language, and writes screenshots to tmp/. Requires google-chrome and a
 * static server.
 *
 *   python3 -m http.server 8765 --bind 127.0.0.1 &
 *   node tools/smoke-test.mjs http://127.0.0.1:8765
 */

import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';

const baseUrl = process.argv[2] || 'http://127.0.0.1:8765';
const debugPort = 9333;
const settleMs = 3500;

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForDebugger() {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${debugPort}/json`);
      const targets = await response.json();
      const page = targets.find((target) => target.type === 'page');
      if (page) {
        return page.webSocketDebuggerUrl;
      }
    } catch (error) {
      /* Chrome is still starting. */
    }
    await sleep(200);
  }
  throw new Error('Chrome debugger did not come up');
}

function connect(webSocketUrl) {
  const socket = new WebSocket(webSocketUrl);
  const pending = new Map();
  const listeners = [];
  let nextId = 1;

  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) {
        reject(new Error(message.error.message));
      } else {
        resolve(message.result);
      }
      return;
    }
    listeners.forEach((listener) => listener(message));
  });

  function send(method, params = {}) {
    const id = nextId;
    nextId += 1;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      socket.send(JSON.stringify({ id, method, params }));
    });
  }

  function onEvent(listener) {
    listeners.push(listener);
  }

  return new Promise((resolve, reject) => {
    socket.addEventListener('open', () => resolve({ send, onEvent, close: () => socket.close() }));
    socket.addEventListener('error', (event) => reject(new Error(`websocket error: ${event.message}`)));
  });
}

async function evaluate(session, expression) {
  const result = await session.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (result.exceptionDetails) {
    throw new Error(`evaluate failed: ${result.exceptionDetails.text} ${expression}`);
  }
  return result.result.value;
}

/* Bring everything into view first, so the target is never off-screen after
 * an earlier zoom or pan, then click at the node's current screen position. */
async function clickNode(session, nodeId) {
  await evaluate(session, 'document.getElementById("fit").click(); true');
  await sleep(900);
  const position = await evaluate(session, `adhdMapDebug.nodeScreenPosition(${JSON.stringify(nodeId)})`);
  const common = { x: position.x, y: position.y, button: 'left', clickCount: 1 };
  await session.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: position.x, y: position.y });
  /* A short pause between moving and pressing, like a real hand. */
  await sleep(150);
  await session.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...common });
  await session.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...common });
  return position;
}

async function screenshot(session, fileName) {
  const result = await session.send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(`tmp/${fileName}`, Buffer.from(result.data, 'base64'));
}

async function visibleCount(session) {
  return evaluate(session, 'adhdMapDebug.explorer.visibleIds().length');
}

async function runScenario(session, prototype, problems) {
  const url = `${baseUrl}/?lang=en`;
  const loaded = new Promise((resolve) => {
    session.onEvent((message) => {
      if (message.method === 'Page.loadEventFired') {
        resolve();
      }
    });
  });
  await session.send('Page.navigate', { url });
  await loaded;
  await sleep(settleMs);

  const initial = await visibleCount(session);
  const expectedInitial = await evaluate(
    session,
    'adhdMapDebug.graph.neighboursOf(adhdMapDebug.graph.start).length + 1',
  );
  console.log(`${prototype}: initial visible nodes = ${initial} (expected ${expectedInitial})`);
  if (initial !== expectedInitial) {
    problems.push(`${prototype}: expected ${expectedInitial} initial nodes, got ${initial}`);
  }
  await screenshot(session, `smoke-${prototype}-1-initial.png`);

  await clickNode(session, 'inattention');
  await sleep(settleMs);
  const afterFirst = await visibleCount(session);
  console.log(`${prototype}: after clicking Inattention = ${afterFirst}`);
  if (afterFirst <= initial) {
    problems.push(`${prototype}: clicking Inattention did not reveal neighbours`);
  }
  await screenshot(session, `smoke-${prototype}-2-inattention.png`);

  await clickNode(session, 'distractibility');
  await sleep(settleMs);
  const afterSecond = await visibleCount(session);
  console.log(`${prototype}: after clicking Distractibility = ${afterSecond}`);
  if (afterSecond <= afterFirst) {
    problems.push(`${prototype}: clicking Distractibility did not reveal neighbours`);
  }
  await screenshot(session, `smoke-${prototype}-3-distractibility.png`);

  await clickNode(session, 'distractibility');
  await sleep(settleMs);
  const afterCollapse = await visibleCount(session);
  console.log(`${prototype}: after clicking Distractibility again = ${afterCollapse}`);
  if (afterCollapse >= afterSecond) {
    problems.push(`${prototype}: second click on Distractibility did not collapse its leaves`);
  }
  await screenshot(session, `smoke-${prototype}-4-collapsed.png`);

  const panelTitle = await evaluate(session, 'document.querySelector("#panel h2").textContent');
  console.log(`${prototype}: panel shows "${panelTitle}"`);
  if (panelTitle !== 'Distractibility') {
    problems.push(`${prototype}: panel title is "${panelTitle}", expected "Distractibility"`);
  }

  await clickNode(session, 'dreaded-task');
  await sleep(settleMs);
  const loopButtonFound = await evaluate(session, `(() => {
    const button = document.querySelector('#panel button.action-loop');
    if (!button) return false;
    button.click();
    return true;
  })()`);
  await sleep(settleMs);
  const loopVisible = await evaluate(
    session,
    `['rumination', 'anticipatory-anxiety', 'avoidance', 'energy-drain', 'burnout'].every((id) => adhdMapDebug.explorer.isVisible(id))`,
  );
  console.log(`${prototype}: loop button ${loopButtonFound ? 'found' : 'missing'}, whole loop visible = ${loopVisible}`);
  if (!loopButtonFound || !loopVisible) {
    problems.push(`${prototype}: "Show the whole loop" did not reveal the rumination loop`);
  }
  await screenshot(session, `smoke-${prototype}-6-loop.png`);

  const optionInputs = await evaluate(session, `(() => {
    document.getElementById('options-toggle').click();
    const box = document.getElementById('options');
    if (box.hidden) return -1;
    const labels = box.querySelector('input[type=checkbox]');
    labels.checked = true;
    labels.dispatchEvent(new Event('change'));
    return box.querySelectorAll('input').length;
  })()`);
  console.log(`${prototype}: options box open with ${optionInputs} controls`);
  if (optionInputs < 8) {
    problems.push(`${prototype}: options box did not open or is missing controls (${optionInputs})`);
  }
  await sleep(500);
  await screenshot(session, `smoke-${prototype}-7-options.png`);
  await evaluate(session, 'document.getElementById("options-toggle").click(); true');

  await clickNode(session, 'distractibility');
  await sleep(1000);
  await evaluate(
    session,
    `(() => {
      const select = document.getElementById('language');
      select.value = 'de';
      select.dispatchEvent(new Event('change'));
      return true;
    })()`,
  );
  await sleep(1500);
  const germanTitle = await evaluate(session, 'document.querySelector("#panel h2").textContent');
  const germanButton = await evaluate(session, 'document.getElementById("reset").textContent');
  const languageInUrl = await evaluate(session, 'new URLSearchParams(window.location.search).get("lang")');
  console.log(`${prototype}: after switching to German the panel shows "${germanTitle}", reset button "${germanButton}", url lang=${languageInUrl}`);
  if (germanTitle !== 'Ablenkbarkeit') {
    problems.push(`${prototype}: German panel title is "${germanTitle}", expected "Ablenkbarkeit"`);
  }
  if (germanButton !== 'Zurücksetzen') {
    problems.push(`${prototype}: German reset button is "${germanButton}"`);
  }
  if (languageInUrl !== 'de') {
    problems.push(`${prototype}: url does not carry lang=de after switching`);
  }
  await screenshot(session, `smoke-${prototype}-5-german.png`);
}

async function main() {
  mkdirSync('tmp', { recursive: true });
  const chrome = spawn(
    'google-chrome',
    [
      '--headless=new',
      '--disable-gpu',
      '--no-sandbox',
      '--hide-scrollbars',
      '--window-size=1400,900',
      `--remote-debugging-port=${debugPort}`,
      '--user-data-dir=tmp/chrome-profile',
      'about:blank',
    ],
    { stdio: 'ignore' },
  );
  const problems = [];
  try {
    const session = await connect(await waitForDebugger());
    await session.send('Page.enable');
    await session.send('Runtime.enable');
    session.onEvent((message) => {
      if (message.method === 'Runtime.exceptionThrown') {
        const details = message.params.exceptionDetails;
        problems.push(`page exception: ${details.text} ${details.exception?.description || ''}`);
      }
      if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') {
        problems.push(`console.error: ${message.params.args.map((argument) => argument.value || argument.description).join(' ')}`);
      }
    });
    await runScenario(session, 'map', problems);
    session.close();
  } finally {
    chrome.kill();
  }
  if (problems.length > 0) {
    console.log(`\n${problems.length} problem(s):`);
    problems.forEach((problem) => console.log(`  - ${problem}`));
    process.exit(1);
  }
  console.log('\nsmoke test passed');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
