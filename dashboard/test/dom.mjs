// A hand-written stand-in for the small part of the browser dashboard/app.js
// touches, plus a recording `fetch`. Node's standard library only: this
// project ships no package and installs none to test itself, so the harness
// is the test's own code and every line of it is visible here.
//
// It is deliberately permissive about WHICH element is asked for -- every id,
// selector and template resolves to an element that simply remembers what was
// done to it -- because the page's shape is pinned from index.html by
// html.test.mjs. What this file exists for is the other half: that clicking a
// control sends the request it promises, and that a field in a payload
// reaches the element it is supposed to show or hide.

/// The `classList` of one element.
class ClassList {
  constructor() {
    this.names = new Set();
  }

  add(...names) {
    for (const name of names) this.names.add(name);
  }

  remove(...names) {
    for (const name of names) this.names.delete(name);
  }

  contains(name) {
    return this.names.has(name);
  }
}

/// One element, fragment or template content.
export class El {
  constructor(name = '') {
    this.name = name;
    this.hidden = false;
    this.textContent = '';
    this.title = '';
    this.value = '';
    this.disabled = false;
    this.className = '';
    this.colSpan = 0;
    this.id = '';
    this.classList = new ClassList();
    this.dataset = {};
    this.attributes = new Map();
    this.listeners = new Map();
    this.children = [];
    this.focused = 0;
    this.selected = new Map();
    this.clones = [];
  }

  // `<template>.content`, made on demand and the same one every time.
  get content() {
    if (!this.contentNode) this.contentNode = new El(`${this.name}:content`);
    return this.contentNode;
  }

  cloneNode() {
    const copy = new El(`${this.name}#${this.clones.length}`);
    this.clones.push(copy);
    return copy;
  }

  // Memoised per selector, so the caller and the test reach the same node.
  querySelector(selector) {
    if (!this.selected.has(selector)) {
      this.selected.set(selector, new El(`${this.name} ${selector}`));
    }
    return this.selected.get(selector);
  }

  querySelectorAll(selector) {
    return this.selected.has(selector) ? [this.selected.get(selector)] : [];
  }

  addEventListener(type, handler) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(handler);
  }

  /// Fire an event the way a browser would: only the handlers registered for
  /// exactly this type run.
  dispatchEvent(type, event = {}) {
    for (const handler of this.listeners.get(type) || []) handler(event);
    return (this.listeners.get(type) || []).length;
  }

  click() {
    return this.dispatchEvent('click');
  }

  append(...nodes) {
    this.children.push(...nodes);
  }

  replaceChildren(...nodes) {
    this.children = [...nodes];
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  getAttribute(name) {
    return this.attributes.has(name) ? this.attributes.get(name) : null;
  }

  removeAttribute(name) {
    this.attributes.delete(name);
  }

  focus() {
    this.focused += 1;
  }

  /// The element one `data-f` name away, as app.js's own `field()` reaches it.
  field(name) {
    return this.querySelector(`[data-f="${name}"]`);
  }
}

/// A document: ids and selectors resolve on demand and stay put.
export function makeDocument(cookie = '') {
  const ids = new Map();
  const selected = new Map();
  return {
    cookie,
    title: '',
    getElementById(id) {
      if (!ids.has(id)) {
        const node = new El(id);
        node.id = id;
        ids.set(id, node);
      }
      return ids.get(id);
    },
    querySelector(selector) {
      if (!selected.has(selector)) selected.set(selector, new El(selector));
      return selected.get(selector);
    },
    querySelectorAll(selector) {
      return selected.has(selector) ? [selected.get(selector)] : [];
    },
    createElement(tag) {
      return new El(tag);
    },
    createDocumentFragment() {
      return new El('#fragment');
    },
    /// Every clone app.js made from one `<template>`, in order.
    clonesOf(id) {
      return this.getElementById(id).content.clones;
    },
  };
}

/// One response, as much of it as app.js reads.
export function reply(status, body = null, headers = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (name) => headers[name] ?? null },
    json: async () => {
      if (body === null) throw new Error('no JSON body');
      return body;
    },
  };
}

/// A `fetch` that answers from a table and records every call it took.
/// An unlisted route answers 404, so a request the page should not have made
/// is visible as a call AND as a failure.
export function makeFetch(routes = {}) {
  const calls = [];
  const fetch = async (path, options = {}) => {
    const method = options.method || 'GET';
    calls.push({ method, path, headers: options.headers || {}, body: options.body });
    const answer = routes[`${method} ${path}`];
    if (answer === undefined) return reply(404, { error: 'not_in_this_test' });
    return typeof answer === 'function' ? answer() : answer;
  };
  return { fetch, calls, of: (method, path) => calls.filter((c) => c.method === method && c.path === path) };
}

/// Let every pending promise settle. `setTimeout` is a macrotask, so it runs
/// after the whole microtask queue the click handlers built.
export const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
