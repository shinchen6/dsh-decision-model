// Renders the client control in a stub DOM so a crash at render time shows up
// here instead of in the browser. A syntax check cannot catch this class of
// bug: a const used before its declaration throws a ReferenceError only when
// the code path runs.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

// --- a very small DOM ----------------------------------------------------
const created = []
function makeElement(tag) {
  const el = {
    tagName: tag.toUpperCase(),
    children: [],
    style: {},
    dataset: {},
    attributes: {},
    _text: '',
    classList: { add() {}, remove() {}, contains: () => false },
    setAttribute(k, v) { this.attributes[k] = v },
    getAttribute(k) { return this.attributes[k] },
    removeAttribute(k) { delete this.attributes[k] },
    appendChild(child) { this.children.push(child); return child },
    removeChild(child) { this.children = this.children.filter((c) => c !== child) },
    remove() {},
    addEventListener() {},
    removeEventListener() {},
    getBoundingClientRect: () => ({ top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0 }),
    querySelector: () => null,
    focus() {},
    set textContent(v) { this._text = String(v) },
    get textContent() { return this._text },
  }
  created.push(el)
  return el
}
const head = makeElement('head')
const body = makeElement('body')
globalThis.document = {
  head,
  body,
  documentElement: makeElement('html'),
  createElement: makeElement,
  getElementById: () => null,
  querySelector: () => null,
  addEventListener() {},
  removeEventListener() {},
}
globalThis.window = {
  __ModuleLoader__: {
    load(spec) { globalThis.__moduleSpec = spec },
  },
  addEventListener() {},
  removeEventListener() {},
  requestAnimationFrame: (fn) => setTimeout(fn, 0),
  setTimeout,
  clearTimeout,
}
globalThis.fetch = async () => { throw new Error('no network in the test') }

// --- load the client module ----------------------------------------------
const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
// The module calls window.__ModuleLoader__.load({ factory }) at load time.
new Function(source)()
const spec = globalThis.__moduleSpec
assert.ok(spec, 'the client module must call __ModuleLoader__.load')
assert.equal(spec.id, '@local/dsh-model-router-web')

// --- React ---------------------------------------------------------------
// The factory asks for react and react-dom. This stub is enough to build the
// element tree the control returns and to run the component body.
const hooks = { state: [], index: 0, effects: [] }
function useState(initial) {
  const i = hooks.index++
  if (hooks.state.length <= i) hooks.state[i] = typeof initial === 'function' ? initial() : initial
  return [hooks.state[i], (next) => {
    hooks.state[i] = typeof next === 'function' ? next(hooks.state[i]) : next
  }]
}
function useRef(initial) {
  const i = hooks.index++
  if (!hooks.refs) hooks.refs = []
  if (hooks.refs.length <= i) hooks.refs[i] = { current: initial }
  return hooks.refs[i]
}
function useCallback(fn) { return fn }
function useMemo(fn) { return fn() }
function useEffect(fn) { hooks.effects.push(fn) }

const React = {
  // Keep a function type as a function: renderTree has to be able to call it.
  createElement: (type, props, ...children) => ({
    type,
    props: { ...(props ?? {}), children: children.length === 1 ? children[0] : children },
  }),
  useState,
  useRef,
  useCallback,
  useMemo,
  useEffect,
  Fragment: 'Fragment',
}
const createPortal = (node) => ({ __portal: true, node })

const require_ = (name) => {
  if (name === 'react') return React
  if (name === 'react-dom') return { createPortal }
  throw new Error(`unexpected require: ${name}`)
}
const plugin = spec.factory(require_)

// --- a host stub ---------------------------------------------------------
const registered = []
const ctx = {
  effect: (fn) => { fn(); return () => {} },
  locale: {
    register: () => {},
    bind: () => (key) => key,
    getLocale: () => ({ active: 'en' }),
    subscribe: () => () => {},
  },
  slots: {
    inject: (key, fn) => { registered.push({ key, fn }) },
    register: (spec_, component) => ({ ...spec_, component }),
  },
}
plugin.apply(ctx)
assert.equal(registered.length, 1, 'the control must register one slot occupant')
assert.equal(registered[0].key, 'conversation.input.right')

// --- render it -----------------------------------------------------------
// Walk the element tree the component returns and invoke every function
// component, so a ReferenceError inside the render path is thrown here.
// Every class name and text the render produced, so a test can assert on
// what actually reached the screen.
const seen = []
function renderTree(node, depth = 0) {
  if (node === null || node === undefined || typeof node === 'boolean') return
  if (Array.isArray(node)) { node.forEach((child) => renderTree(child, depth)); return }
  if (typeof node === 'string' || typeof node === 'number') { seen.push(String(node)); return }
  if (node.__portal) { renderTree(node.node, depth); return }
  if (typeof node.type === 'function') {
    const rendered = node.type(node.props)
    renderTree(rendered, depth + 1)
    return
  }
  if (node.props?.className) seen.push(String(node.props.className))
  const children = node.props?.children
  if (Array.isArray(children)) children.forEach((child) => renderTree(child, depth + 1))
  else renderTree(children, depth + 1)
}

const occupant = registered[0].fn()
const Component = occupant.component ?? occupant

// Render in every mode, with a live session, so each branch of the chip and
// the panel actually runs. A branch that is never taken cannot fail, and a
// reference error in a rarely used branch would stay invisible.
const MODES = ['off', 'observe', 'auto']
const STATUS = {
  mode: 'auto',
  config: {
    mode: 'auto',
    policy: { decisionTrust: 'max', main: true, subagents: true },
    decision: {
      enabled: true,
      activeId: 'jev',
      models: [
        { id: 'jev', label: 'jev', endpoint: 'http://x', model: 'decision-model-preview', protocol: 'systemone', timeoutMs: 900, tierQuestion: 'tier', effortQuestion: 'effort', questions: { tier: { criteria: { fast: 'x' } } } },
        { id: 'other', label: '备用', endpoint: 'http://y', model: 'other-preview', protocol: 'systemone', timeoutMs: 900, tierQuestion: 'tier', effortQuestion: 'effort', questions: null },
      ],
      endpoint: 'http://x',
      model: 'decision-model-preview',
      protocol: 'systemone',
      timeoutMs: 900,
      tierQuestion: 'tier',
      effortQuestion: 'effort',
      questions: { tier: { criteria: { fast: 'x' } } },
    },
  },
  candidates: [
    { tier: 'fast', provider: 'p', model: 'm1', label: 'm1' },
    { tier: 'balanced', provider: 'p', model: 'm2', label: 'm2' },
    { tier: 'deep', provider: 'p', model: 'm3', label: 'm3' },
  ],
  candidateByTier: { fast: { model: 'm1' }, balanced: { model: 'm2' }, deep: { model: 'm3' } },
  sessions: [{ id: 'session-test', active: { provider: 'p', model: 'm2', tier: 'balanced', effort: 'high' }, decision: { provider: 'p', model: 'm2', tier: 'balanced', effort: 'high' } }],
  history: [{
    at: new Date().toISOString(),
    agent: 'agent-1',
    turn: 1,
    step: 2,
    tier: 'balanced',
    provider: 'p',
    model: 'm2',
    effort: 'high',
    source: 'heuristic+decision',
    rationale: 'heuristic=balanced, decision=balanced (0.90)',
    decisionTier: 'balanced',
    decisionEffort: 'high',
    confidence: 0.9,
    probabilities: { fast: 0.1, balanced: 0.9 },
    heuristicTier: 'balanced',
    decisionVerdict: '{"answers":{"tier":{"choice":"balanced"}}}',
  }],
  builtinDecisionModels: [
    { id: 'jev', label: 'jev', endpoint: 'http://x', model: 'decision-model-preview', protocol: 'systemone', timeoutMs: 900, tierQuestion: 'tier', effortQuestion: 'effort' },
  ],
  overrides: [],
  requestErrors: [],
  usage: {
    day: '2026-10-30',
    totalTokens: 123456,
    inputTokens: 100000,
    outputTokens: 23456,
    calls: 12,
    rows: [
      { tier: 'fast', provider: 'minimax-cn', model: 'MiniMax-M3.1-Flash', inputTokens: 80000, outputTokens: 10000, totalTokens: 90000, calls: 9 },
      { tier: 'balanced', provider: 'minimax-cn', model: 'MiniMax-M3', inputTokens: 20000, outputTokens: 13456, totalTokens: 33456, calls: 3 },
    ],
  },
  policy: {},
  decision: {},
}

for (const mode of MODES) {
  const status = { ...STATUS, mode, config: { ...STATUS.config, mode } }
  // The component reads the status through its own fetch; feed it by making
  // the stub return the payload.
  globalThis.fetch = async (url) => {
    const body = String(url).includes('/status') ? status : { providers: [], models: {} }
    const text = JSON.stringify(body)
    console.log('   fetch called:', String(url).slice(0, 60))
    return { ok: true, status: 200, text: async () => text, json: async () => body }
  }
  hooks.index = 0
  hooks.state = []
  hooks.refs = []
  hooks.effects = []

  // Each render starts the hook sequence again, exactly like React does.
  const render = () => {
    hooks.index = 0
    return renderTree(Component({
      sessionId: 'session-test',
      t: (key) => key,
      localeFace: null,
    }))
  }

  // First render: the status has not arrived yet.
  render()
  // Run the effects so the status lands in state, then render again with it.
  // The effect starts an async fetch; let it settle before the second render,
  // otherwise the component renders with an empty status and never takes the
  // branches that a real session would.
  for (const effect of hooks.effects) effect()
  for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setTimeout(resolve, 0))
  render()
  const st = hooks.state[2]
  if (!st || st.config?.mode !== mode) {
    throw new Error(`the status never reached the component (slot 2 = ${JSON.stringify(st)?.slice(0, 60)})`)
  }
  console.log(`rendered in mode: ${mode} | status.mode=${st.config.mode} | effort=${st.sessions?.[0]?.active?.effort}`)
}

// --- the decision modal --------------------------------------------------
// The decision model list lives in its own modal. Opening it exercises the
// list, the built-in setups and the editor, which is where a broken
// reference would hide.
{
  const status = { ...STATUS, mode: 'auto', config: { ...STATUS.config, mode: 'auto' } }
  globalThis.fetch = async (url) => {
    const body = String(url).includes('/status') ? status : { providers: [], models: {} }
    const text = JSON.stringify(body)
    return { ok: true, status: 200, text: async () => text, json: async () => body }
  }
  hooks.index = 0
  hooks.state = []
  hooks.refs = []
  hooks.effects = []

  const render = () => {
    hooks.index = 0
    return renderTree(Component({
      sessionId: 'session-test',
      t: (key) => key,
      localeFace: null,
    }))
  }
  render()
  for (const effect of hooks.effects) effect()
  for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setTimeout(resolve, 0))
  // Open the panel and the decision modal.
  hooks.state[0] = true
  hooks.state[8] = true
  seen.length = 0
  render()
  const tree = seen.join(' ')
  if (!tree.includes('mr-dm-list')) throw new Error(`the decision model list did not render: ${tree.slice(0, 300)}`)
  if (!tree.includes('jev')) throw new Error('the configured decision model did not render')
  if (!tree.includes('mr-modal')) throw new Error('the decision modal itself did not render')
  if (!tree.includes('mr-dm-builtins')) throw new Error('the quick setups did not render')
  console.log('the decision modal rendered with the model list')
}

console.log('the control rendered without throwing in any mode')
console.log('ALL CLIENT RENDER CHECKS PASSED')
// The control polls the status on an interval; do not keep the loop alive.
process.exit(0)
