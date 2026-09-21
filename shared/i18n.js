/* Language selection and interface strings shared by both prototypes.
 *
 * The language index (data/languages.yaml) lists the available languages.
 * The active language is chosen from, in order: the `lang` query parameter,
 * the last choice stored in the browser, the browser's preferred languages,
 * and finally the index default. */
(function () {
  'use strict';

  const STORAGE_KEY = 'adhd-map-language';

  async function loadIndex(url) {
    const index = await AdhdMapData.loadYaml(url);
    return { defaultCode: index.default, languages: index.languages || [] };
  }

  function readStoredCode() {
    try {
      return window.localStorage.getItem(STORAGE_KEY);
    } catch (error) {
      return null;
    }
  }

  function storeCode(code) {
    try {
      window.localStorage.setItem(STORAGE_KEY, code);
    } catch (error) {
      /* Storage is unavailable in this context; the URL still carries the choice. */
    }
  }

  function pickLanguage(index) {
    const known = new Set(index.languages.map((language) => language.code));
    const fromUrl = new URLSearchParams(window.location.search).get('lang');
    if (fromUrl && known.has(fromUrl)) {
      return fromUrl;
    }
    const stored = readStoredCode();
    if (stored && known.has(stored)) {
      return stored;
    }
    const browserCodes = (navigator.languages || [navigator.language || '']).map((tag) =>
      String(tag).toLowerCase().split('-')[0],
    );
    const fromBrowser = browserCodes.find((code) => known.has(code));
    if (fromBrowser) {
      return fromBrowser;
    }
    return index.defaultCode || (index.languages[0] ? index.languages[0].code : null);
  }

  function fileFor(index, code) {
    const language = index.languages.find((entry) => entry.code === code);
    return language ? language.file : null;
  }

  /* Remember the choice in storage and in the URL so links can be shared. */
  function remember(code) {
    storeCode(code);
    const url = new URL(window.location.href);
    url.searchParams.set('lang', code);
    window.history.replaceState(null, '', url);
  }

  function format(template, values) {
    return String(template).replace(/\{(\w+)\}/g, (match, key) =>
      Object.prototype.hasOwnProperty.call(values, key) ? values[key] : match,
    );
  }

  /* Elements opt in with data-ui="<key>" (text), data-ui-placeholder="<key>"
   * (placeholder) and data-keep-lang (links that should carry ?lang=). */
  function applyUiStrings(ui, code) {
    document.querySelectorAll('[data-ui]').forEach((element) => {
      const value = ui[element.dataset.ui];
      if (value) {
        element.textContent = value;
      }
    });
    document.querySelectorAll('[data-ui-placeholder]').forEach((element) => {
      const value = ui[element.dataset.uiPlaceholder];
      if (value) {
        element.placeholder = value;
      }
    });
    document.querySelectorAll('a[data-keep-lang]').forEach((link) => {
      const url = new URL(link.getAttribute('href'), window.location.href);
      url.searchParams.set('lang', code);
      link.href = url.pathname + url.search;
    });
    if (ui.title) {
      document.title = ui.title;
    }
    document.documentElement.lang = code;
  }

  function fillLanguageSelect(selectElement, index, currentCode) {
    selectElement.replaceChildren();
    index.languages.forEach((language) => {
      const option = document.createElement('option');
      option.value = language.code;
      option.textContent = language.name;
      option.selected = language.code === currentCode;
      selectElement.append(option);
    });
  }

  window.AdhdMapI18n = {
    loadIndex,
    pickLanguage,
    fileFor,
    remember,
    format,
    applyUiStrings,
    fillLanguageSelect,
  };
})();
