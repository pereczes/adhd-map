/* A small options store with a rendered settings panel. Values persist in
 * the browser. Definitions: { key, type: 'range' | 'checkbox' | 'select',
 * labelKey, defaultValue, min, max, step, choices }. For a select, `choices`
 * is a function taking the interface strings and returning
 * [{ value, label }, ...], so the list can be built at render time. */
(function () {
  'use strict';

  function createOptions(definitions, storageKey) {
    const values = {};
    const listeners = [];

    definitions.forEach((definition) => {
      values[definition.key] = definition.defaultValue;
    });

    function load() {
      try {
        const stored = JSON.parse(window.localStorage.getItem(storageKey) || '{}');
        definitions.forEach((definition) => {
          if (Object.prototype.hasOwnProperty.call(stored, definition.key)) {
            values[definition.key] = stored[definition.key];
          }
        });
      } catch (error) {
        /* Storage unavailable or corrupt; defaults stay. */
      }
    }

    function save() {
      try {
        window.localStorage.setItem(storageKey, JSON.stringify(values));
      } catch (error) {
        /* Storage unavailable; the choice lasts for this page only. */
      }
    }

    function notify(key) {
      listeners.forEach((listener) => listener(key, values[key]));
    }

    function get(key) {
      return values[key];
    }

    function set(key, value) {
      values[key] = value;
      save();
      notify(key);
    }

    function reset() {
      definitions.forEach((definition) => {
        values[definition.key] = definition.defaultValue;
      });
      save();
      notify(null);
    }

    function onChange(listener) {
      listeners.push(listener);
    }

    function render(container, ui) {
      container.replaceChildren();
      const heading = document.createElement('h2');
      heading.textContent = ui.options || 'Options';
      container.append(heading);

      definitions.forEach((definition) => {
        const row = document.createElement('label');
        row.className = 'options-row';
        const text = document.createElement('span');
        text.textContent = ui[definition.labelKey] || definition.key;
        row.append(text);

        if (definition.type === 'select') {
          const select = document.createElement('select');
          definition.choices(ui).forEach((choice) => {
            const option = document.createElement('option');
            option.value = choice.value;
            option.textContent = choice.label;
            option.selected = choice.value === values[definition.key];
            select.append(option);
          });
          select.addEventListener('change', () => set(definition.key, select.value));
          row.append(select);
          container.append(row);
          return;
        }

        const input = document.createElement('input');
        if (definition.type === 'checkbox') {
          input.type = 'checkbox';
          input.checked = Boolean(values[definition.key]);
          input.addEventListener('change', () => set(definition.key, input.checked));
        } else {
          input.type = 'range';
          input.min = definition.min;
          input.max = definition.max;
          input.step = definition.step || 1;
          input.value = values[definition.key];
          input.addEventListener('input', () => set(definition.key, Number(input.value)));
        }
        row.append(input);
        container.append(row);
      });

      const resetButton = document.createElement('button');
      resetButton.type = 'button';
      resetButton.className = 'options-reset';
      resetButton.textContent = ui.options_reset || 'Restore defaults';
      resetButton.addEventListener('click', () => {
        reset();
        render(container, ui);
      });
      container.append(resetButton);
    }

    load();
    return { get, set, reset, onChange, render };
  }

  window.AdhdMapOptions = { createOptions };
})();
