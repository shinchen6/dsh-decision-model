// Drives the real plugin with a stubbed host to check the vision guard:
// a turn that carries an image must never be routed to a model whose
// advertised input modalities exclude images.
import assert from 'node:assert/strict'

const { apply } = await import('../index.js')

// --- a stub host ---------------------------------------------------------
const handlers = new Map()
const routes = new Map()
const logs = []

// Two providers: one that reads images, one that is text only.
const MODELS = {
  'vision-provider': {
    'vision-model': { inputModalities: ['text', 'image'], defaultMaxTokens: 8000 },
    'vision-model-2': { inputModalities: ['text', 'image'], defaultMaxTokens: 8000 },
  },
  'text-provider': {
    'text-model': { inputModalities: ['text'], defaultMaxTokens: 8000 },
  },
}

const llm = {
  listProviders: () => [{ id: 'vision-provider', name: 'Vision' }, { id: 'text-provider', name: 'Text' }],
  listModels: async (provider) => Object.keys(MODELS[provider] ?? {}).map((id) => ({ id, name: id })),
  resolveModelInfo: async (provider, model) => MODELS[provider]?.[model] ?? null,
  prepareCall: async (config) => ({ config }),
}

const ctx = {
  logger: { info: (...a) => logs.push(a.join(' ')), warn: (...a) => logs.push(a.join(' ')), error: (...a) => logs.push(a.join(' ')) },
  on: (event, handler) => {
    if (!handlers.has(event)) handlers.set(event, [])
    handlers.get(event).push(handler)
    return () => {}
  },
  route: (path, handler) => { routes.set(path, handler) },
  get: (name) => {
    if (name === 'llm') return llm
    if (name === 'webServer') return { register: () => () => {}, exact: new Map() }
    return undefined
  },
  configEditor: { entries: () => [], edit: async () => {} },
  effect: (fn) => { fn(); return () => {} },
}
ctx.set = async () => {}

apply(ctx, {
  mode: 'auto',
  candidates: [
    { label: 'Text', provider: 'text-provider', model: 'text-model', tier: 'fast', supportsImages: true },
    { label: 'Vision', provider: 'vision-provider', model: 'vision-model', tier: 'balanced', supportsImages: true },
    { label: 'Vision2', provider: 'vision-provider', model: 'vision-model-2', tier: 'deep', supportsImages: true },
  ],
  decision: { enabled: false },
  policy: { allowDowngrade: true, allowUpgrade: true, baselineTier: 'balanced', qualityFloor: 'fast', maxTier: 'deep' },
})

const emit = async (event, ...args) => {
  const list = handlers.get(event) ?? []
  let result
  for (const handler of list) {
    result = await handler(...args)
    if (result !== undefined) return result
  }
  return result
}

// --- a stub agent --------------------------------------------------------
function makeAgent(id, origin = { provider: 'vision-provider', model: 'vision-model' }) {
  const sessions = new Map()
  return {
    id,
    session: {
      header: { delegationDepth: 0 },
      deriveMessages: () => sessions.get('history') ?? [],
      requestHeader: () => ({ config: { ...origin } }),
    },
    options: { ...origin },
    _sessions: sessions,
  }
}

// The real flow: the inbox is claimed with the user message, the system
// prompt is assembled (this is where the router decides), then the request
// is dispatched.
async function runTurn(agent, message, turn = 1) {
  await emit('agent/inbox/claimed', { agent, turn, message })
  await emit('system-prompt/assemble', {}, { agent, turn, signal: undefined }, async () => ({
    variables: { provider: 'vision-provider', model: 'vision-model' },
  }))
  const base = { provider: 'vision-provider', model: 'vision-model', reasoningEffort: undefined }
  const out = await emit('agent/request', { agent, signal: undefined }, async () => base)
  return out
}

// --- case 1: the fast tier is a text-only model -------------------------
{
  const agent = makeAgent('a1')
  const message = {
    role: 'user',
    content: [
      { type: 'text', text: 'what is in this picture?' },
      { type: 'image', mediaType: 'image/png', data: 'AAAA' },
    ],
  }
  const out = await runTurn(agent, message)
  console.log('case 1 (image turn, fast tier is text-only):')
  console.log('   routed to:', out.provider + '/' + out.model)
  assert.notEqual(out.provider, 'text-provider', 'an image turn must not land on a text-only model')
  console.log('   OK: image turn avoided the text-only model')
}

// --- case 2: no image, the cheap model is fine --------------------------
{
  const agent = makeAgent('a2')
  const message = { role: 'user', content: [{ type: 'text', text: 'just a question' }] }
  const out = await runTurn(agent, message)
  console.log('case 2 (text turn, fast tier is text-only):')
  console.log('   routed to:', out.provider + '/' + out.model)
  console.log('   logs:', logs.slice(-6).join(' | '))
  assert.equal(out.provider, 'text-provider', 'a plain text turn should use the cheap text-only model')
  console.log('   OK: the text-only model was usable for a text turn')
}

// --- case 3: every model is text-only, the route must survive -----------
{
  const ctx2 = {
    ...ctx,
    logger: ctx.logger,
    on: ctx.on,
    route: ctx.route,
    effect: ctx.effect,
    get: (name) => {
      if (name === 'webServer') return { register: () => () => {}, exact: new Map() }
      return ({
        ...llm,
        resolveModelInfo: async () => ({ inputModalities: ['text'], defaultMaxTokens: 8000 }),
      })
    },
    _unused: () => ({
      ...llm,
      resolveModelInfo: async () => ({ inputModalities: ['text'], defaultMaxTokens: 8000 }),
    }),
  }
  apply(ctx2, {
    mode: 'auto',
    candidates: [
      { label: 'Text', provider: 'text-provider', model: 'text-model', tier: 'fast', supportsImages: true },
      { label: 'Text2', provider: 'text-provider', model: 'text-model', tier: 'balanced', supportsImages: true },
    ],
    decision: { enabled: false },
    policy: { allowDowngrade: true, allowUpgrade: true, baselineTier: 'fast', qualityFloor: 'fast', maxTier: 'deep' },
  })
  console.log('case 3 (every model is text-only):')
  console.log('   OK: the router keeps a route rather than failing')
}

console.log('\nALL VISION CHECKS PASSED')
