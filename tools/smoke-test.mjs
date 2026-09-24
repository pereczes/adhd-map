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

  function whenLoaded() {
    return new Promise((resolve) => {
      session.onEvent((message) => {
        if (message.method === 'Page.loadEventFired') {
          resolve();
        }
      });
    });
  }

  let loaded = whenLoaded();
  await session.send('Page.navigate', { url });
  await loaded;

  /* The browser profile is reused between runs, so start from stored-nothing:
   * the options box must be at its defaults for the checks below. */
  await evaluate(session, 'localStorage.clear(); true');
  loaded = whenLoaded();
  await session.send('Page.reload', { ignoreCache: true });
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

  /* The taxonomy badges and the evidence context must reach the panel. */
  const scopeBadge = await evaluate(session, `(() => {
    const badge = document.querySelector('#panel .scope-badge');
    return badge ? badge.textContent : '';
  })()`);
  console.log(`${prototype}: scope badge reads "${scopeBadge}"`);
  if (!scopeBadge) {
    problems.push(`${prototype}: no scope badge on a symptom node`);
  }

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

  /* A strategy shows its evidence context. The search box reveals it, which
   * covers that path too. */
  await evaluate(session, `(() => {
    const search = document.getElementById('search');
    search.value = 'Regular exercise';
    search.dispatchEvent(new Event('change'));
    return true;
  })()`);
  await sleep(settleMs);
  const evidenceLevel = await evaluate(session, `(() => {
    const level = document.querySelector('#panel .context-level');
    return level ? level.textContent : '';
  })()`);
  console.log(`${prototype}: exercise evidence context reads "${evidenceLevel}"`);
  if (!evidenceLevel) {
    problems.push(`${prototype}: no evidence context on a strategy node`);
  }

  /* Sourced facts reach the panel. Reached through search, because clicking
   * an already-open node would fold the map away instead. */
  await evaluate(session, `(() => {
    const search = document.getElementById('search');
    search.value = 'ADHD';
    search.dispatchEvent(new Event('change'));
    return true;
  })()`);
  await sleep(settleMs);
  const factCount = await evaluate(session, 'document.querySelectorAll("#panel .facts li").length');
  const firstFact = await evaluate(session, `(() => {
    const fact = document.querySelector('#panel .facts li');
    return fact ? fact.textContent.slice(0, 50) : '';
  })()`);
  const factSource = await evaluate(session, `(() => {
    const link = document.querySelector('#panel .facts .source-line a');
    return link ? link.getAttribute('href') : '';
  })()`);
  console.log(`${prototype}: ADHD node shows ${factCount} facts, first "${firstFact}", source ${factSource}`);
  if (factCount < 5 || !factSource.startsWith('http')) {
    problems.push(`${prototype}: facts section missing or unsourced on the ADHD node`);
  }
  await screenshot(session, `smoke-${prototype}-10-facts.png`);

  /* A guideline-level treatment names the guidance behind it, and an
   * association edge names its study. */
  await evaluate(session, `(() => {
    const search = document.getElementById('search');
    search.value = 'Medication';
    search.dispatchEvent(new Event('change'));
    return true;
  })()`);
  await sleep(settleMs);
  const evidenceSource = await evaluate(session, `(() => {
    const link = document.querySelector('#panel .context .source-line a');
    return link ? link.textContent : '';
  })()`);
  await evaluate(session, `(() => {
    const search = document.getElementById('search');
    search.value = 'Driving and accident risk';
    search.dispatchEvent(new Event('change'));
    return true;
  })()`);
  await sleep(settleMs);
  const associationSource = await evaluate(session, `(() => {
    const link = document.querySelector('#panel .chip-item .source-line a');
    return link ? link.textContent : '';
  })()`);
  console.log(`${prototype}: medication evidence cites "${evidenceSource}", driving association cites "${associationSource}"`);
  if (!evidenceSource || !associationSource) {
    problems.push(`${prototype}: evidence or association sources are not shown in the panel`);
  }

  /* An alias finds a node the label alone would not. */
  await evaluate(session, `(() => {
    const search = document.getElementById('search');
    search.value = 'RSD';
    search.dispatchEvent(new Event('change'));
    return true;
  })()`);
  await sleep(settleMs);
  const aliasTitle = await evaluate(session, 'document.querySelector("#panel h2").textContent');
  console.log(`${prototype}: searching "RSD" opened "${aliasTitle}"`);
  if (aliasTitle !== 'Rejection sensitivity') {
    problems.push(`${prototype}: alias search opened "${aliasTitle}", expected "Rejection sensitivity"`);
  }

  /* The popup works with the default settings, in the map's own language. */
  await evaluate(session, 'document.getElementById("fit").click(); true');
  await sleep(900);
  const defaultHover = await evaluate(session, 'adhdMapDebug.nodeScreenPosition("inattention")');
  await session.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: defaultHover.x, y: defaultHover.y });
  await sleep(1200);
  const defaultPopup = await evaluate(session, `(() => {
    const popup = document.getElementById('popup');
    return popup.hidden ? '' : popup.textContent;
  })()`);
  console.log(`${prototype}: default hover popup reads "${defaultPopup.slice(0, 40)}"`);
  if (!defaultPopup.includes('Inattention')) {
    problems.push(`${prototype}: hover popup did not appear with default settings (got "${defaultPopup.slice(0, 60)}")`);
  }
  await session.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 20, y: 400 });
  await sleep(400);

  /* Pick a second language, hover again, read the popup. */
  await evaluate(session, `(() => {
    document.getElementById('options-toggle').click();
    const select = document.querySelector('#options select');
    select.value = 'de';
    select.dispatchEvent(new Event('change'));
    document.getElementById('options-toggle').click();
    return true;
  })()`);
  await sleep(1200);
  await evaluate(session, 'document.getElementById("fit").click(); true');
  await sleep(900);
  const hoverPosition = await evaluate(session, 'adhdMapDebug.nodeScreenPosition("inattention")');
  await session.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: hoverPosition.x, y: hoverPosition.y });
  await sleep(1200);
  const popupText = await evaluate(session, `(() => {
    const popup = document.getElementById('popup');
    return popup.hidden ? '' : popup.textContent;
  })()`);
  console.log(`${prototype}: hover popup reads "${popupText.slice(0, 40)}"`);
  if (!popupText.includes('Unaufmerksamkeit')) {
    problems.push(`${prototype}: hover popup did not show the German translation (got "${popupText.slice(0, 60)}")`);
  }
  await screenshot(session, `smoke-${prototype}-8-popup.png`);
  await session.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 20, y: 400 });
  await sleep(400);

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
  if (optionInputs < 7) {
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

  /* The sources page renders, in the language carried by the link. */
  loaded = whenLoaded();
  await session.send('Page.navigate', { url: `${baseUrl}/sources.html?lang=de` });
  await loaded;
  await sleep(1500);
  const sourcesHeading = await evaluate(session, 'document.querySelector("h1").textContent');
  const sourceCount = await evaluate(session, 'document.querySelectorAll(".page li").length');
  console.log(`${prototype}: sources page heading "${sourcesHeading}" with ${sourceCount} sources`);
  if (sourcesHeading !== 'Quellen und Vorgehen' || sourceCount < 13) {
    problems.push(`${prototype}: sources page did not render in German with its source list`);
  }
  const toolkitNodes = await evaluate(session, `(() => {
    const item = Array.from(document.querySelectorAll('.page li'))
      .find((entry) => entry.textContent.includes('Tool Kit'));
    return item ? item.querySelectorAll('.used-by a').length : 0;
  })()`);
  console.log(`${prototype}: the toolkit source lists ${toolkitNodes} nodes on the map`);
  if (toolkitNodes < 30) {
    problems.push(`${prototype}: the toolkit source lists only ${toolkitNodes} nodes`);
  }
  await screenshot(session, `smoke-${prototype}-9-sources.png`);

  /* A node link from the sources page opens the map on that node. */
  loaded = whenLoaded();
  await session.send('Page.navigate', { url: `${baseUrl}/index.html?lang=en&node=if-then-plans` });
  await loaded;
  await sleep(settleMs);
  const deepLinked = await evaluate(session, 'document.querySelector("#panel h2").textContent');
  const describedIn = await evaluate(session, `(() => {
    const described = document.querySelector('#panel .described');
    return described ? described.textContent : '';
  })()`);
  console.log(`${prototype}: node link opened "${deepLinked}", ${describedIn}`);
  if (deepLinked !== 'If-then plans' || !describedIn.includes('Ramsay')) {
    problems.push(`${prototype}: node link or the described-in line did not work`);
  }
  await screenshot(session, `smoke-${prototype}-11-toolkit.png`);
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
