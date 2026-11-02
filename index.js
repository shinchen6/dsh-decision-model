/**
 * Model Router — a Host plugin that picks a provider/model and reasoning
 * effort for each turn (and for every subagent) from a configurable decision
 * model plus local heuristics.
 *
 * Design constraints:
 * - The session log remains the only source of truth. Routing decisions are
 *   derived from durable request headers and logged as ordinary model-route
 *   changes, so fork/resume keep working.
 * - Quality first: the router may downgrade only when local heuristics and the
 *   decision model agree, and hard risk signals (tool errors, request errors,
 *   images, context pressure) force a stronger tier.
 * - Fail safe: an unreachable decision endpoint or an unusable candidate route
 *   falls back to the model the session would have used anyway.
 *
 * @module @local/dsh-model-router-web
 */
import { randomUUID } from 'node:crypto'

const TIERS = ['fast', 'balanced', 'deep']
const TIER_RANK = { fast: 0, balanced: 1, deep: 2 }

const DEFAULT_QUESTIONS = {
  tier: {
    type: 'choice',
    criteria: {
      fast: 'Simple, localized, low-risk work: a lookup, rename, formatting, small edit, single command, or summarizing one file.',
      balanced:
        'Normal multi-step coding: implement a small feature, fix a bug with investigation, refactor one module, or write tests.',
      deep: 'Complex, ambiguous, cross-cutting, or high-risk work: architecture, distributed systems, unknown root cause, security review, large migration, or performance analysis.',
    },
  },
  effort: {
    type: 'choice',
    criteria: {
      low: 'Little or no deliberation is needed; the answer is known or the change is mechanical.',
      medium: 'Some reasoning is useful, but there is no long proof or design search.',
      high: 'Careful multi-step reasoning, planning, or verification is required.',
    },
  },
}

/**
 * The decision model profiles the panel offers as one-click setups.
 *
 * Each entry is a complete profile: where to ask, which model, how to read
 * the answer, and the criteria the judge reads. A setup fills a new profile;
 * it never overwrites one the user already configured.
 */
const BUILTIN_DECISION_MODELS = [
  {
    id: 'jev',
    label: 'jev',
    // The endpoint is left empty on purpose: a quick setup has to be pointed
    // at the reader's own decision service before it can answer.
    endpoint: '',
    model: 'decision-model-preview',
    protocol: 'systemone',
    apiKeyEnv: 'DECISION_MODEL_API_KEY',
    timeoutMs: 900,
    tierQuestion: 'tier',
    effortQuestion: 'effort',
    questions: null,
  },
]


const DEFAULT_CONFIG = {
  /**
   * off:     no listeners, no work.
   * observe: decide and record, but never change a request (safe rollout).
   * auto:    apply the decision to prompt variables and request config.
   *
   * The plugin starts off: routing a live session is a decision the user
   * makes from the control surface, not one the bundle makes for them.
   */
  mode: 'off',
  candidates: [],
  policy: {
    /** Tier assumed for a baseline route that is not listed in candidates. */
    baselineTier: 'balanced',
    /** Never route below this tier. */
    qualityFloor: 'fast',
    /** Never route above this tier for a main agent. */
    maxTier: 'deep',
    /** Per-subagent ceiling; defaults to maxTier. */
    subagentMaxTier: '',
    /**
     * What to do when the decision model is asked but does not answer.
     * hold:      keep the route the session is already on (default). A failed
     *            forecast is not evidence that the task is easy, so the tier is
     *            not lowered on the strength of a missing answer.
     * heuristic: let the local rule decide, which keeps the cost saving but can
     *            downgrade a hard turn while the judge is unavailable.
     */
    onJudgeUnavailable: 'hold',
    allowDowngrade: true,
    allowUpgrade: true,
    /**
     * max:      final tier = max(heuristic, decision). The decision model can
     *           only raise the tier, which is the quality-safest mode.
     * safe:     the decision model may lower the tier when the separation
     *           between its first and second choice is above the threshold and
     *           no risk signal fired.
     * decision: the decision model decides; heuristics are only a fallback.
     */
    decisionTrust: 'max',
    /**
     * The separation the judge needs before it may lower the tier, measured as
     * the gap between its first and second choice (0 = a tie, 1 = certain).
     *
     * This is NOT the judge's own `confidence` field, which does not track the
     * probabilities it reports (one turn returned probabilities 0.59/0.32/0.09
     * with `confidence` 0.39, another 0.41/0.29/0.29 with 0.12). The gap is
     * computed from the distribution, so it means the same thing every turn.
     *
     * 0.75 is deliberately strict: with three tiers it asks the winner to lead
     * by three quarters of the probability mass, which the observed answers
     * (typically 0.12–0.94) often do not reach, so downgrades stay rare. The
     * panel shows the observed range next to this setting; lower it to ~0.3 to
     * let the judge actually move a turn down a tier.
     */
    downgradeConfidence: 0.75,
    main: true,
    subagents: true,
    maxDepth: 2,
    escalateOnToolError: true,
    escalateOnRequestError: true,
    escalateTurns: 1,
    /** A fast tier that survives more than this many model steps is raised. */
    maxFastSteps: 8,
    /** How long a candidate route that failed a request stays unusable. */
    unhealthyMs: 600000,
  },
  /** Global effort mapping; a candidate's own effortByTier wins. */
  effortByTier: {},
  heuristics: {
    fastMaxChars: 420,
    longRequestChars: 5000,
    deepAboveTokens: 150000,
    subagentBias: 0,
    mediumKeywords: [
      'fix', 'fixing', 'fixed', 'bug', 'bugs', 'buggy', 'test', 'tests', 'testing', 'update', 'updating', 'change*', 'add', 'adding', 'write', 'writing', 'edit', 'editing',
      'move', 'moving', 'extract', 'rename', 'renaming', 'script', 'config', 'configuration', 'function', 'functions', 'component', 'components',
      'endpoint', 'endpoints', 'page', 'pages', 'example', 'examples', 'doc',
    ],
    deepKeywords: [
      'architect', 'architecture', 'design', 'redesign', 'distributed', 'concurrency',
      'race condition', 'deadlock', 'security', 'vulnerabilit*', 'threat model',
      'migrat*', 'refactor*', 'optimi*', 'performance', 'profiling', 'root cause',
      'debug*', 'investigat*', 'diagnos*', 'prove', 'proof', 'tradeoff', 'trade-off',
      'review*', 'plan*', 'implement*', 'build', 'create', 'feature', 'complex*',
      'ambiguous', 'multi-file', 'cross-cutting', 'protocol*', 'compiler', 'parser',
      '架构', '设计', '分布式', '并发', '死锁', '安全', '漏洞', '迁移', '重构',
      '优化', '性能', '根因', '调试', '排查', '审查', '规划', '方案', '实现',
      '开发', '复杂', '深入', '多文件',
    ],
    fastKeywords: [
      'rename', 'typo', 'format', 'lint', 'list', 'show', 'cat', 'read', 'open',
      'find', 'grep', 'search', 'lookup', 'translate', 'summarize', 'summary',
      'what is', 'where is', 'how many', 'version', 'status', 'diff',
      'readme', 'docs', 'comment',
      '重命名', '拼写', '格式', '列出', '查看', '读取', '搜索', '翻译', '总结',
      '是什么', '在哪', '多少个', '版本', '状态', '差异', '文档', '注释',
    ],
  },
  decision: {
    enabled: true,
    /** The decision model profiles the user can switch between. */
    models: [],
    /** Which profile is in use. Empty means the first configured one. */
    activeId: '',
    /** systemone (this deployment), openai (chat completions JSON), custom. */
    protocol: 'systemone',
    endpoint: '',
    model: '',
    apiKey: '',
    apiKeyEnv: 'DECISION_MODEL_API_KEY',
    headers: {},
    timeoutMs: 900,
    maxContentChars: 6000,
    tierQuestion: 'tier',
    effortQuestion: 'effort',
    questions: null,
    stateExtra: {},
    extraBody: {},
    requestTemplate: null,
    /** Optional dot path for an answer object in the response body. */
    responsePath: '',
    maxFailures: 3,
    cooldownMs: 60000,
  },
  notices: true,
  debug: false,
  /** local: loopback only; all: any peer; off: no routes. */
  statusRoute: 'local',
}

/** Register the plugin. */
export function apply(ctx, rawConfig = {}) {
  const config = normalizeConfig(rawConfig)
  const logger = ctx.logger ?? console
  const states = new Map()
  const knownAgents = new Map()
  const overrides = sharedStore('overrides', () => new Map())
  const infoCache = new Map()
  const preflightCache = new Map()
  const unhealthy = new Map()
  // The switch log outlives a plugin generation: saving the settings reloads
  // this bundle, and a log that empties on every save would defeat the point
  // of keeping records. The store hangs off a global symbol so the next
  // generation finds the entries the previous one wrote.
  const recent = sharedHistory()
  // Token accounting also outlives a rebuild: the daily totals are the whole
  // point of the statistics panel, and a settings change must not zero them.
  const usage = sharedStore('usage', () => ({ entries: [], days: new Map() }))
  const requestErrors = []
  const controllers = new Set()
  // One breaker per decision model profile, so a judge that stops answering
  // only silences itself.
  const decisionCircuits = new Map()
  let disposed = false
  let lastSave = null

  if (config.mode === 'off') log('info', 'model-router: disabled (diagnostics and controls remain available)')

  const disposers = []
  const add = (disposer) => {
    if (typeof disposer === 'function') disposers.push(disposer)
  }

  // ---------------------------------------------------------------------
  // Event wiring
  // ---------------------------------------------------------------------

  add(ctx.on('agent/created', ({ agent }) => {
    knownAgents.set(String(agent.id), agent)
    stateFor(agent)
  }))

  add(ctx.on('agent/disposed', ({ agent }) => {
    states.delete(agent.id)
    knownAgents.delete(String(agent.id))
  }))

  // Token accounting arrives with the session's durable events: the assistant
  // message carries the provider's own usage for the step it closed. The
  // route that produced it is the one the router had active for that step.
  add(ctx.on('session/event', (session, event) => {
    if (!event || event.type !== 'assistant/message') return
    const usage = event.data?.usage
    if (!usage || typeof usage.totalTokens !== 'number' && typeof usage.inputTokens !== 'number') return
    const agent = agentForSession(session)
    if (!agent) return
    const st = stateFor(agent)
    const route = st.active ?? st.decision
    if (!route) return
    const total = typeof usage.totalTokens === 'number'
      ? usage.totalTokens
      : (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0)
    const entry = {
      at: new Date().toISOString(),
      agent: String(agent.id),
      sessionId: String(session.id ?? ''),
      turn: event.data?.turn ?? st.currentTurn ?? 0,
      step: event.data?.step ?? 0,
      tier: route.tier ?? null,
      provider: route.provider ?? null,
      model: route.model ?? null,
      inputTokens: usage.inputTokens ?? null,
      outputTokens: usage.outputTokens ?? null,
      totalTokens: total,
    }
    recordUsage(entry)
    // The route record was written before the model answered, so the token
    // count is attached to it now that the provider has reported it.
    for (const row of recent) {
      if (row.agent !== entry.agent) continue
      if (row.turn !== entry.turn || row.step !== entry.step) continue
      row.inputTokens = entry.inputTokens
      row.outputTokens = entry.outputTokens
      row.totalTokens = entry.totalTokens
      break
    }
  }))

  add(ctx.on('agent/inbox/claimed', (payload) => {
    const agent = payload.agent
    if (!allowedAgent(agent)) return
    const st = stateFor(agent)
    if (st.currentTurn !== payload.turn) {
      st.currentTurn = payload.turn
      st.stepsThisTurn = 0
      st.noticeKey = null
      st.claimedMessages = []
      st.turnPrompt = null
      st.turnVerdict = null
      st.lastToolErrorId = null
    }
    st.claimedTurn = payload.turn
    if (payload.message) {
      st.claimedMessages.push(payload.message)
      if (!st.turnPrompt) {
        const text = promptTextOf(payload.message)
        if (text) st.turnPrompt = text
      }
    }
  }))

  add(ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
    const result = await next()
    if (disposed || config.mode === 'off') return result
    const agent = context?.agent
    if (!agent || !allowedAgent(agent)) return result
    const st = stateFor(agent)
    initOrigin(agent, st)
    if (!st.origin) return result
    const turn = st.claimedTurn || st.currentTurn || 0
    if (turn === 0) return result
    const firstStep = st.assembledTurn !== turn
    let decision
    try {
      decision = await buildDecision(agent, st, {
        turn,
        firstStep,
        messages: st.claimedMessages ?? [],
        signal: context?.signal,
      })
    } catch (error) {
      log('warn', `model-router: decision failed: ${messageOf(error)}`)
      return result
    }
    if (!decision) return result

    st.decision = decision
    st.assembledTurn = turn
    st.stepsThisTurn = (st.stepsThisTurn ?? 0) + 1
    record(agent, st, decision, turn, st.stepsThisTurn)

    if (config.mode !== 'auto') return result
    return {
      ...result,
      variables: {
        ...(result.variables ?? {}),
        provider: decision.provider,
        model: decision.model,
      },
    }
  }))

  add(ctx.on('agent/request', async (payload, next) => {
    const base = await next()
    if (disposed || config.mode !== 'auto') return base
    const agent = payload.agent
    if (!agent || !allowedAgent(agent)) return base
    const st = stateFor(agent)
    const target = st.decision
    if (!target) return base

    // A route that was not chosen by this plugin (for example a model the user
    // selected in the UI) becomes the new baseline; do not fight it.
    if (st.lastApplied && !sameRoute(base, st.lastApplied)) {
      st.origin = {
        provider: base.provider,
        model: base.model,
        ...(base.reasoningEffort === undefined ? {} : { reasoningEffort: base.reasoningEffort }),
        tier: tierForRoute(base) ?? config.policy.baselineTier,
      }
      st.active = null
      st.decision = null
      st.lastApplied = null
      log('info', `model-router: external route change adopted (${base.provider}/${base.model})`)
      return base
    }

    const out = applyRoute(base, target)
    // The loop reuses the Agent's configured output cap even after a route
    // change. A larger cap than the new adapter accepts fails before dispatch,
    // so clamp it to the candidate's advertised default; switching back to a
    // roomier route restores the Agent's own configured value.
    try {
      const info = await resolveInfo(target.provider, target.model, payload.signal)
      const cap = info?.defaultMaxTokens
      const configured = typeof agent.options?.maxTokens === 'number' ? agent.options.maxTokens : undefined
      if (typeof cap === 'number' && cap > 0) {
        if (configured !== undefined && configured <= cap) out.maxTokens = configured
        else if (typeof out.maxTokens === 'number' && out.maxTokens > cap) out.maxTokens = cap
      }
    } catch {
      // A failed metadata lookup leaves the cap untouched; the adapter's own
      // validation remains the final authority.
    }
    st.active = {
      provider: target.provider,
      model: target.model,
      tier: target.tier,
      effort: out.reasoningEffort,
      label: target.label,
    }
    st.lastApplied = { provider: target.provider, model: target.model }
    if (config.debug) {
      log('info', `model-router: ${target.provider}/${target.model} tier=${target.tier} effort=${out.reasoningEffort ?? '-'} source=${target.source}`)
    }
    return out
  }))

  add(ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    if (disposed || config.mode !== 'auto' || !config.notices) return decision
    if (!decision || decision.kind === 'reject') return decision
    const agent = payload.agent
    if (!agent || !allowedAgent(agent)) return decision
    const st = stateFor(agent)
    const chosen = st.decision
    if (!chosen) return decision
    const previous = agent.session?.requestHeader?.()?.config
    if (!previous || sameRoute(previous, chosen)) return decision
    const key = `${payload.turn}:${chosen.provider}/${chosen.model}`
    if (st.noticeKey === key) return decision
    st.noticeKey = key
    return { ...decision, messages: [...decision.messages, createNotice(previous, chosen)] }
  }))

  add(ctx.on('agent/request-error', async (payload, next) => {
    if (!disposed && config.mode === 'auto' && payload?.agent && allowedAgent(payload.agent)) {
      const st = stateFor(payload.agent)
      const turn = payload.turn ?? st.currentTurn ?? 0
      if (!payload.signal?.aborted) {
        st.lastFailureTurn = turn
        requestErrors.push({
          at: new Date().toISOString(),
          agent: String(payload.agent.id),
          turn,
          provider: payload.provider ?? st.active?.provider ?? null,
          model: st.active?.model ?? null,
          code: payload.failure?.code ?? null,
          message: clip(messageOf(payload.failure), 300),
        })
        if (requestErrors.length > 30) requestErrors.splice(0, requestErrors.length - 30)
        if (config.policy.escalateOnRequestError) {
          st.forceDeepUntilTurn = Math.max(st.forceDeepUntilTurn, turn + config.policy.escalateTurns)
        }
        if (st.active) {
          unhealthy.set(routeKey(st.active), {
            until: Date.now() + config.policy.unhealthyMs,
            reason: payload.failure?.code ?? 'REQUEST_FAILED',
          })
        }
        // Retry within the same step must fall back to the session's own route.
        if (st.origin) {
          st.decision = {
            provider: st.origin.provider,
            model: st.origin.model,
            tier: tierForRoute(st.origin) ?? config.policy.baselineTier,
            label: st.origin.model,
            effort: undefined,
            source: 'request-error-fallback',
            rationale: messageOf(payload.failure),
          }
        } else {
          st.decision = null
        }
        st.active = null
        st.lastApplied = null
      }
    }
    return next()
  }))

  // ---------------------------------------------------------------------
  // Local diagnostics and the composer control API (loopback by default)
  // ---------------------------------------------------------------------

  const web = ctx.get?.('webServer')
  if (web && config.statusRoute !== 'off') {
    const routePaths = [
      ['/plugins/model-router/status', handleStatus],
      ['/plugins/model-router/models', handleModels],
      ['/plugins/model-router/providers', handleProviders],
      ['/plugins/model-router/decide', handleDecide],
      ['/plugins/model-router/config', handleConfig],
      ['/plugins/model-router/session', handleSession],
    ]
    for (const [path, handler] of routePaths) {
      add(ctx.effect(
        () => registerOwnedRoute(web, path, handler),
        `model-router.route(${path})`,
      ))
    }
  }

  // ---------------------------------------------------------------------
  // Implementation
  // ---------------------------------------------------------------------

  function log(level, message) {
    const fn = logger?.[level]
    if (typeof fn === 'function') fn.call(logger, message)
    else if (level === 'warn' || level === 'error') console.error(message)
  }

  // The session events carry the session, not the agent; the router's own
  // state is keyed by agent id.
  function agentForSession(session) {
    if (!session) return null
    const id = String(session.id ?? '')
    for (const [agentId, st] of states) {
      if (st.sessionId === id) return st.agent ?? null
    }
    for (const agent of knownAgents.values()) {
      if (String(agent.session?.id ?? '') === id) return agent
    }
    return null
  }

  // One usage entry, kept per day. The day is the local calendar day, so
  // "today" matches what the user sees on their own clock.
  function recordUsage(entry) {
    const day = entry.at.slice(0, 10)
    let bucket = usage.days.get(day)
    if (!bucket) {
      bucket = new Map()
      usage.days.set(day, bucket)
    }
    const key = `${entry.tier ?? 'unknown'}|${entry.provider ?? '?'}|${entry.model ?? '?'}`
    let row = bucket.get(key)
    if (!row) {
      row = {
        tier: entry.tier ?? null,
        provider: entry.provider ?? null,
        model: entry.model ?? null,
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        calls: 0,
      }
      bucket.set(key, row)
    }
    row.inputTokens += entry.inputTokens ?? 0
    row.outputTokens += entry.outputTokens ?? 0
    row.totalTokens += entry.totalTokens ?? 0
    row.calls += 1
    usage.entries.push(entry)
    if (usage.entries.length > 500) usage.entries.splice(0, usage.entries.length - 500)
    // Keep a bounded number of days.
    if (usage.days.size > 30) {
      const oldest = [...usage.days.keys()].sort()[0]
      usage.days.delete(oldest)
    }
  }

  // Today's totals, grouped by tier and model, most used first.
  function usageSummary(day) {
    const key = day ?? new Date().toISOString().slice(0, 10)
    const bucket = usage.days.get(key)
    const rows = []
    if (bucket) {
      for (const row of bucket.values()) rows.push({ ...row })
    }
    rows.sort((a, b) => b.totalTokens - a.totalTokens)
    return {
      day: key,
      totalTokens: rows.reduce((sum, row) => sum + row.totalTokens, 0),
      inputTokens: rows.reduce((sum, row) => sum + row.inputTokens, 0),
      outputTokens: rows.reduce((sum, row) => sum + row.outputTokens, 0),
      calls: rows.reduce((sum, row) => sum + row.calls, 0),
      rows,
    }
  }

  function stateFor(agent) {
    let st = states.get(agent.id)
    if (!st) {
      st = {
        agent,
        sessionId: String(agent.session?.id ?? ''),
        origin: null,
        active: null,
        lastApplied: null,
        decision: null,
        claimedTurn: 0,
        claimedMessages: [],
        turnPrompt: null,
        currentTurn: 0,
        assembledTurn: -1,
        // The verdict the judge gave for the current turn. A turn asks the
        // judge once; every later step of that turn reports the same verdict.
        turnVerdict: null,
        stepsThisTurn: 0,
        forceDeepUntilTurn: 0,
        lastFailureTurn: -10,
        lastToolErrorId: null,
        overrideTier: overrides.get(agent.id) ?? null,
        noticeKey: null,
      }
      states.set(agent.id, st)
    }
    return st
  }

  function isSubagent(agent) {
    const header = agent?.session?.header
    if (!header) return false
    return header.origin === 'subagent' || (header.delegationDepth ?? 0) > 0
  }

  function allowedAgent(agent) {
    if (!agent?.session) return false
    const sub = isSubagent(agent)
    if (sub && !config.policy.subagents) return false
    if (!sub && !config.policy.main) return false
    const depth = agent.session.header?.delegationDepth ?? 0
    if (depth > config.policy.maxDepth) return false
    return true
  }

  function initOrigin(agent, st) {
    if (st.origin) return
    const header = agent.session?.requestHeader?.()?.config
    if (header?.provider && header?.model) {
      st.origin = {
        provider: header.provider,
        model: header.model,
        ...(header.reasoningEffort === undefined ? {} : { reasoningEffort: header.reasoningEffort }),
        tier: tierForRoute(header) ?? config.policy.baselineTier,
      }
      return
    }
    const options = agent.options
    if (options?.provider && options?.model) {
      st.origin = {
        provider: options.provider,
        model: options.model,
        ...(options.reasoningEffort === undefined ? {} : { reasoningEffort: options.reasoningEffort }),
        tier: tierForRoute(options) ?? config.policy.baselineTier,
      }
    }
  }

  function tierForRoute(route) {
    if (!route) return null
    const candidate = findCandidate(route.provider, route.model)
    return candidate?.tier ?? null
  }

  function findCandidate(provider, model) {
    return config.candidates.find((c) => c.provider === provider && c.model === model)
  }

  /**
   * Bound an automatic tier to the policy floor and ceiling.
   *
   * An explicit session override is a deliberate user instruction for that
   * session, so it is not bounded by the global policy; the policy bounds
   * shape automatic decisions.
   */
  function clampTier(tier, agent, explicit = false) {
    if (explicit) return tier
    let min = config.policy.qualityFloor
    let max = isSubagent(agent) && config.policy.subagentMaxTier
      ? config.policy.subagentMaxTier
      : config.policy.maxTier
    if (TIER_RANK[tier] < TIER_RANK[min]) tier = min
    if (TIER_RANK[tier] > TIER_RANK[max]) tier = max
    return tier
  }

  function escalate(tier) {
    if (tier === 'fast') return 'balanced'
    return 'deep'
  }

  async function buildDecision(agent, st, { turn, firstStep, messages, signal }) {
    const origin = st.origin
    const originTier = tierForRoute(origin) ?? config.policy.baselineTier
    let heuristic = null
    let decisionModel = null
    let tier
    let source
    let rationale

    if (st.overrideTier) {
      if (st.overrideTier === 'off') {
        tier = originTier
        source = 'session-off'
        rationale = 'session override: hold the baseline route'
      } else {
        tier = st.overrideTier
        source = 'session-override'
        rationale = `session override: ${tier}`
      }
    } else if (turn <= st.forceDeepUntilTurn) {
      tier = 'deep'
      source = 'escalation'
      rationale = 'a recent request failed; quality tier held'
    } else if (!firstStep) {
      tier = st.active?.tier ?? st.decision?.tier ?? originTier
      source = 'continuation'
      rationale = 'the route from this turn was kept'
      const errorId = config.policy.escalateOnToolError ? latestToolErrorId(agent) : null
      if (errorId && errorId !== st.lastToolErrorId) {
        // Escalate once per distinct failure, not on every following step that
        // can still see the same tool result in recent history.
        st.lastToolErrorId = errorId
        tier = escalate(tier)
        source = 'tool-error'
        rationale = 'a new tool failure escalated the route'
      } else if (st.stepsThisTurn >= config.policy.maxFastSteps && tier === 'fast') {
        tier = 'balanced'
        source = 'long-turn'
        rationale = `fast tier survived ${st.stepsThisTurn} steps`
      }
    } else {
      heuristic = computeHeuristic(agent, st, messages, turn, origin, originTier)
      tier = heuristic.tier
      source = 'heuristic'
      rationale = heuristic.rationale
      if (decisionEnabled() && !decisionCircuitOpen()) {
        const content = buildTaskContent(agent, messages, st)
        decisionModel = await askDecision(content, {
          agentId: String(agent.id),
          turn,
          subagent: isSubagent(agent),
          depth: agent.session.header?.delegationDepth ?? 0,
          origin,
          active: st.active,
          tier,
          tokens: heuristic.tokens,
        }, signal)
        if (decisionModel?.tier) {
          tier = combineTiers(heuristic.tier, decisionModel, heuristic.risk)
          source = 'heuristic+decision'
          // The verdict belongs to the whole turn, so later steps of this turn
          // report it too instead of looking like the judge never spoke.
          st.turnVerdict = {
            tier: decisionModel.tier,
            effort: decisionModel.effort ?? null,
            confidence: decisionModel.confidence ?? null,
            confidenceMargin: decisionModel.confidenceMargin ?? null,
            reportedConfidence: decisionModel.reportedConfidence ?? null,
            probabilities: decisionModel.probabilities ?? null,
            latencyMs: decisionModel.latencyMs ?? null,
            raw: decisionModel.raw ?? null,
          }
          rationale = `the decision model chose ${decisionModel.tier}${decisionModel.confidence === null ? '' : ` with ${decisionModel.confidence.toFixed(2)} confidence`}`
        } else {
          // The judge was asked and did not answer. A failed forecast is not
          // evidence that the task is easy, so by default the route is held
          // rather than handed to the keyword rule, which would quietly
          // downgrade exactly when the second opinion went missing.
          if (config.policy.onJudgeUnavailable === 'hold') {
            tier = st.active?.tier ?? originTier
            source = 'judge-unavailable'
            rationale = 'the decision model did not answer; the route was held'
          } else {
            source = 'judge-unavailable'
            rationale = 'the decision model did not answer; the local rule decided'
          }
        }
      }
    }

    tier = clampTier(tier, agent, Boolean(st.overrideTier))
    // The judge's effort applies to the tier it actually chose. A later step
    // that keeps the same tier keeps that effort too: recomputing it with no
    // hint would silently drop back to the adapter default mid-turn.
    const carriedEffort = !firstStep && st.active?.tier === tier ? (st.active.effort ?? null) : null
    const hintedEffort = decisionModel && decisionModel.tier === tier
      ? decisionModel.effort
      : carriedEffort
    const route = await chooseRoute(agent, st, tier, origin, originTier, messages, signal, hintedEffort)
    if (!route) return null
    const verdict = decisionModel ?? st.turnVerdict ?? null
    return {
      provider: route.provider,
      model: route.model,
      label: route.label ?? route.model,
      tier,
      effort: route.effort,
      source,
      rationale,
      heuristic,
      decisionModel,
      // The judge answers once per turn; every step of that turn reports it.
      decisionTier: verdict?.tier ?? null,
      decisionEffort: verdict?.effort ?? null,
      confidence: verdict?.confidence ?? null,
      confidenceMargin: verdict?.confidenceMargin ?? null,
      reportedConfidence: verdict?.reportedConfidence ?? null,
      probabilities: verdict?.probabilities ?? null,
      decisionLatencyMs: verdict?.latencyMs ?? null,
      decisionVerdict: verdict?.raw ?? null,
      at: Date.now(),
      turn,
    }
  }

  function computeHeuristic(agent, st, messages, turn, origin, originTier) {
    const claimed = Array.isArray(messages) ? messages : []
    const history = agent.session?.deriveMessages?.() ?? []
    const lastUser = st.turnPrompt || firstUserText(claimed) || lastUserText(history)
    const text = (lastUser || textOfMessages(claimed)).slice(0, 12000)
    const risk = []
    let score = 0
    const deepHits = matchKeywords(text, config.heuristics.deepKeywords)
    const mediumHits = matchKeywords(text, config.heuristics.mediumKeywords)
    const fastHits = matchKeywords(text, config.heuristics.fastKeywords)
    if (deepHits.length > 0) score += 2 + Math.min(2, deepHits.length - 1)
    if (mediumHits.length > 0) score += 1
    if (fastHits.length > 0) score -= 1
    if (text.length > 0 && text.length <= config.heuristics.fastMaxChars && deepHits.length === 0) score -= 1
    if (text.length > config.heuristics.longRequestChars) score += 1
    const tokens = estimateTokens(agent, claimed)
    if (tokens > config.heuristics.deepAboveTokens) score += 1
    if (hasImages(claimed, history)) risk.push('image')
    if (st.lastFailureTurn >= turn - 1) {
      score += 3
      risk.push('request-error')
    }
    if (isSubagent(agent) && config.heuristics.subagentBias) score += config.heuristics.subagentBias

    let tier
    if (score >= 2) tier = 'deep'
    else if (score <= -1) tier = 'fast'
    else tier = 'balanced'
    if (risk.includes('request-error')) tier = 'deep'

    return {
      tier,
      score,
      risk,
      tokens,
      deepHits: deepHits.slice(0, 5),
      mediumHits: mediumHits.slice(0, 5),
      fastHits: fastHits.slice(0, 5),
      baselineTier: originTier,
      rationale: `score=${score}${deepHits.length ? ` deep=${deepHits.slice(0, 3).join(',')}` : ''}${mediumHits.length ? ` medium=${mediumHits.slice(0, 3).join(',')}` : ''}${fastHits.length ? ` fast=${fastHits.slice(0, 3).join(',')}` : ''}${risk.length ? ` risk=${risk.join(',')}` : ''}`,
    }
  }

  function combineTiers(heuristicTier, decision, risk) {
    const chosen = decision.tier
    if (!chosen) return heuristicTier
    if (config.policy.decisionTrust === 'decision') return chosen
    if (config.policy.decisionTrust === 'safe') {
      if (TIER_RANK[chosen] >= TIER_RANK[heuristicTier]) return chosen
      if (risk.length > 0) return heuristicTier
      if ((decision.confidence ?? 0) >= config.policy.downgradeConfidence) return chosen
      return heuristicTier
    }
    // max (default): the decision model may only raise the tier.
    return TIER_RANK[chosen] > TIER_RANK[heuristicTier] ? chosen : heuristicTier
  }

  async function chooseRoute(agent, st, tier, origin, originTier, messages, signal, hintedEffort) {
    const active = st.active
    const current = active ?? {
      provider: origin.provider,
      model: origin.model,
      tier: originTier,
      label: origin.model,
    }
    const currentTier = active?.tier ?? originTier

    // A turn that carries images can only run on a model that accepts them.
    // This is checked even when the tier does not change: the route may have
    // been picked before the image arrived, and a request that cannot carry
    // its own image fails outright.
    const constraints = {
      images: hasImages(messages, agent.session?.deriveMessages?.() ?? []),
      tokens: estimateTokens(agent, messages),
    }
    if (constraints.images) {
      const holds = await routeAcceptsImages(current, signal)
      if (!holds) {
        const candidates = await pickCandidates(tier, constraints, signal)
        for (const candidate of candidates) {
          const routed = await withEffort(candidate, tier, hintedEffort, signal)
          if (routed) return routed
        }
      }
    }

    if (tier === currentTier) {
      return (await withEffort(current, tier, hintedEffort, signal)) ?? stripEffort(current, tier)
    }
    if (tier === originTier) {
      return (await withEffort(origin, tier, hintedEffort, signal)) ?? stripEffort(origin, tier)
    }

    if (TIER_RANK[tier] < TIER_RANK[currentTier] && !config.policy.allowDowngrade) {
      return stripEffort(current, currentTier)
    }
    if (TIER_RANK[tier] > TIER_RANK[currentTier] && !config.policy.allowUpgrade) {
      return stripEffort(current, currentTier)
    }

    const candidates = await pickCandidates(tier, constraints, signal)
    for (const candidate of candidates) {
      const routed = await withEffort(candidate, tier, hintedEffort, signal)
      if (routed) return routed
    }
    // No usable candidate: keep the route the session already has.
    return stripEffort(current, currentTier)
  }

  async function pickCandidates(tier, constraints, signal) {
    const start = TIER_RANK[tier]
    for (let rank = start; rank < TIERS.length; rank += 1) {
      const pool = config.candidates.filter((candidate) => TIER_RANK[candidate.tier] === rank)
      if (pool.length === 0) continue
      const checked = await Promise.all(pool.map(async (candidate) => {
        const fits = await candidateFits(candidate, constraints, signal)
        return fits ? candidate : null
      }))
      const usable = checked.filter(Boolean)
      if (usable.length > 0) {
        usable.sort((a, b) => (a.cost ?? 1) - (b.cost ?? 1) || a.label.localeCompare(b.label))
        return usable
      }
    }
    return []
  }

  // Does this exact route accept an image? The adapter's advertised modalities
  // are the truth; the config flag only covers a route with no metadata.
  async function routeAcceptsImages(route, signal) {
    const candidate = findCandidate(route.provider, route.model)
    let info = null
    try {
      info = await resolveInfo(route.provider, route.model, signal)
    } catch {
      info = null
    }
    if (info && Array.isArray(info.inputModalities) && info.inputModalities.length > 0) {
      return info.inputModalities.includes('image')
    }
    return candidate?.supportsImages === true
  }

  async function candidateFits(candidate, constraints, signal) {
    if (candidate.supportsTools === false) return false
    const unhealthyUntil = unhealthy.get(routeKey(candidate))
    if (unhealthyUntil && unhealthyUntil.until > Date.now()) return false
    let info = null
    try {
      info = await resolveInfo(candidate.provider, candidate.model, signal)
    } catch {
      return false
    }
    if (!info) return true
    if (constraints.images) {
      // The adapter's advertised modalities are the truth; the config flag is
      // only a fallback for a route whose capability metadata is unavailable.
      const modalities = Array.isArray(info.inputModalities) ? info.inputModalities : null
      const acceptsImages = modalities !== null && modalities.length > 0
        ? modalities.includes('image')
        : candidate.supportsImages === true
      if (!acceptsImages) return false
    }
    const window = info.context?.contextWindow ?? candidate.maxContext
    if (window && constraints.tokens > window * 0.85) return false
    return true
  }

  async function withEffort(route, tier, hintedEffort, signal) {
    const candidate = findCandidate(route.provider, route.model)
    // Explicit tier mappings are policy; the decision model's effort is only a
    // hint used when neither the candidate nor the global config pins one.
    let effort = candidate?.effortByTier?.[tier]
      ?? config.effortByTier?.[tier]
      ?? hintedEffort
      ?? null
    if (typeof effort === 'string') effort = effort.trim().toLowerCase() || null
    else if (effort !== null && effort !== undefined) effort = null

    let info = null
    try {
      info = await resolveInfo(route.provider, route.model, signal)
    } catch {
      info = null
    }

    if (effort) {
      effort = validateEffort(effort, info, candidate)
    }
    if (!effort && candidate?.effortByTier?.[tier]) {
      effort = validateEffort(String(candidate.effortByTier[tier]).toLowerCase(), info, candidate)
    }

    let prepared = null
    try {
      prepared = await preflight(route.provider, route.model, effort, signal)
    } catch (error) {
      unhealthy.set(routeKey(route), {
        until: Date.now() + config.policy.unhealthyMs,
        reason: messageOf(error),
      })
      log('warn', `model-router: candidate ${route.provider}/${route.model} unusable: ${messageOf(error)}`)
      return null
    }

    if (prepared?.config) {
      effort = prepared.config.reasoningEffort === undefined
        ? undefined
        : String(prepared.config.reasoningEffort)
    }

    return {
      provider: route.provider,
      model: route.model,
      label: route.label ?? candidate?.label ?? route.model,
      tier,
      ...(effort ? { effort } : {}),
    }
  }

  function stripEffort(route, tier) {
    return {
      provider: route.provider,
      model: route.model,
      label: route.label ?? findCandidate(route.provider, route.model)?.label ?? route.model,
      tier,
    }
  }

  function validateEffort(effort, info, candidate) {
    const supported = candidate?.efforts
      ?? (info?.reasoning?.efforts ?? []).map((entry) => String(entry.id))
    if (!Array.isArray(supported) || supported.length === 0) return null
    const exact = supported.find((entry) => String(entry).toLowerCase() === effort)
    if (exact) return String(exact).toLowerCase()
    const aliases = {
      low: ['low', 'minimal', 'light', 'off'],
      medium: ['medium', 'mid', 'balanced', 'default', 'normal', 'high'],
      high: ['high', 'max', 'xhigh', 'deep', 'extra-high'],
    }
    for (const alias of aliases[effort] ?? [effort]) {
      const hit = supported.find((entry) => String(entry).toLowerCase() === alias)
      if (hit) return String(hit).toLowerCase()
    }
    return null
  }

  async function resolveInfo(provider, model, signal) {
    const key = `${provider}/${model}`
    const cached = infoCache.get(key)
    const now = Date.now()
    if (cached && cached.until > now) {
      if (cached.error) throw cached.error
      return cached.info
    }
    const llm = getLlm()
    if (!llm?.resolveModelInfo) return null
    try {
      const info = await llm.resolveModelInfo(provider, model, signal)
      infoCache.set(key, { info, until: now + 300000 })
      return info
    } catch (error) {
      infoCache.set(key, { error, until: now + 60000 })
      throw error
    }
  }

  async function preflight(provider, model, effort, signal) {
    const key = `${provider}/${model}@${effort ?? ''}`
    const cached = preflightCache.get(key)
    const now = Date.now()
    if (cached && cached.until > now) {
      if (cached.error) throw cached.error
      return cached.prepared
    }
    const llm = getLlm()
    if (!llm?.prepareCall) return null
    try {
      const prepared = await llm.prepareCall({
        provider,
        model,
        ...(effort ? { reasoningEffort: effort } : {}),
      }, signal)
      preflightCache.set(key, { prepared, until: now + 300000 })
      return prepared
    } catch (error) {
      preflightCache.set(key, { error, until: now + 60000 })
      throw error
    }
  }

  function getLlm() {
    try {
      return ctx.get?.('llm') ?? ctx.llm
    } catch {
      return null
    }
  }

  // The decision model profile in use. The list is the source of truth; the
  // older flat fields are kept in step so the profile they describe stays
  // available as a single-profile fallback.
  function activeDecisionModel() {
    const models = config.decision.models ?? []
    if (models.length === 0) return null
    const active = models.find((entry) => entry.id === config.decision.activeId)
    return active ?? models[0]
  }

  function decisionEnabled() {
    const active = activeDecisionModel()
    return Boolean(
      config.decision.enabled
      && active
      && active.endpoint
      && active.model
      && active.protocol !== 'off',
    )
  }

  // Each profile carries its own breaker, so one unreachable judge does not
  // silence the others.
  function circuitFor(id) {
    const key = String(id ?? 'default')
    let circuit = decisionCircuits.get(key)
    if (!circuit) {
      circuit = { failures: 0, openUntil: 0 }
      decisionCircuits.set(key, circuit)
    }
    return circuit
  }

  function decisionCircuitOpen(id) {
    return Date.now() < circuitFor(id).openUntil
  }

  async function askDecision(content, meta, signal) {
    const profile = activeDecisionModel()
    if (!decisionEnabled() || !profile) return null
    if (decisionCircuitOpen(profile.id)) return null
    const decisionCircuit = circuitFor(profile.id)
    const startedAt = Date.now()
    const timeout = abortableTimeout(profile.timeoutMs, signal)
    controllers.add(timeout.controller)
    try {
      const body = decisionBody(content, meta, profile)
      const headers = {
        'content-type': 'application/json',
        ...config.decision.headers,
      }
      const key = config.decision.apiKey || (profile.apiKeyEnv ? process.env[profile.apiKeyEnv] : '')
      if (key && !headers.authorization) headers.authorization = `Bearer ${key}`
      const response = await fetch(profile.endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: timeout.signal,
      })
      const text = await response.text()
      if (!response.ok) {
        throw new Error(`decision endpoint HTTP ${response.status}: ${clip(text, 300)}`)
      }
      let parsed
      try {
        parsed = JSON.parse(text)
      } catch {
        throw new Error('decision endpoint returned non-JSON')
      }
      const answers = selectAnswers(parsed)
      const tierAnswer = readAnswer(answers, profile.tierQuestion)
        ?? readAnswer(answers, 'tier')
        ?? readAnswer(answers, 'recommended_tier')
        ?? readAnswer(answers, 'complexity')
      const effortAnswer = profile.effortQuestion
        ? readAnswer(answers, profile.effortQuestion)
        : null
      const tier = tierAnswer ? normalizeTier(tierAnswer.value) : null
      if (!tier) return null
      const effort = effortAnswer ? normalizeEffort(effortAnswer.value) : null
      decisionCircuit.failures = 0
      return {
        tier,
        effort,
        // How long the judge took to answer, in milliseconds.
        latencyMs: Date.now() - startedAt,
        confidence: confidenceOf(tierAnswer),
        confidenceMargin: marginOf(tierAnswer),
        reportedConfidence: typeof tierAnswer?.confidence === 'number'
          ? clamp01(tierAnswer.confidence)
          : null,
        probabilities: tierAnswer?.probabilities ?? null,
        // The verbatim answer, kept small: the records tab shows it so the
        // judgement can be read without guessing what the model said.
        raw: clip(JSON.stringify(parsed), 2000),
        rawBody: clip(typeof body === 'string' ? body : JSON.stringify(body), 1200),
      }
    } catch (error) {
      decisionCircuit.failures += 1
      if (decisionCircuit.failures >= config.decision.maxFailures) {
        decisionCircuit.openUntil = Date.now() + config.decision.cooldownMs
      }
      log('warn', `model-router: decision model unavailable: ${messageOf(error)}`)
      return null
    } finally {
      timeout.dispose()
      controllers.delete(timeout.controller)
    }
  }

  function decisionBody(content, meta, profile) {
    const source = profile ?? activeDecisionModel()
    const questions = usableQuestions(source?.questions)
      ?? usableQuestions(config.decision.questions)
      ?? DEFAULT_QUESTIONS
    const state = {
      ...(config.decision.stateExtra ?? {}),
      content,
      ...(meta.rootPreview ? {} : { ticket_id: String(meta.ticketId ?? meta.agentId ?? 'dsh-session') }),
      metadata: {
        source: 'dsh-model-router',
        turn: meta.turn,
        subagent: Boolean(meta.subagent),
        depth: meta.depth,
        baseline_provider: meta.origin?.provider,
        baseline_model: meta.origin?.model,
        baseline_tier: meta.origin?.tier,
        active_tier: meta.active?.tier,
        // The local rule's guess is deliberately NOT sent. A judge that is told
        // what the cheap rule already concluded tends to agree with it, which
        // makes asking a second opinion pointless. Only facts travel: what the
        // task costs to carry, and where the request started from.
        estimated_tokens: meta.tokens,
        candidates: config.candidates.map((candidate) => `${candidate.tier}:${candidate.label}`),
      },
    }

    if (source.protocol === 'openai') {
      const criteria = questions?.tier?.criteria ?? {}
      const criteriaText = Object.entries(criteria).map(([key, value]) => `- ${key}: ${value}`).join('\n')
      return {
        model: source.model,
        temperature: 0,
        stream: false,
        messages: [
          {
            role: 'system',
            content: 'You are a model-routing classifier. Choose the cheapest tier that can still do the task well. Answer with one JSON object only: {"tier":"fast|balanced|deep","effort":"low|medium|high","confidence":0..1}. Tiers:\n' + criteriaText,
          },
          { role: 'user', content },
        ],
        ...config.decision.extraBody,
      }
    }

    if (source.protocol === 'custom') {
      const template = config.decision.requestTemplate
      if (!template) throw new Error('custom protocol requires requestTemplate')
      return renderTemplate(template, {
        model: source.model,
        content,
        state: JSON.stringify(state),
        questions: JSON.stringify(questions),
        endpoint: source.endpoint,
      })
    }

    // systemone (the deployment's /v1/chat/completions decision API)
    return {
      model: source.model,
      state,
      questions,
      ...config.decision.extraBody,
    }
  }

  function selectAnswers(parsed) {
    if (!parsed || typeof parsed !== 'object') return null
    if (config.decision.responsePath) {
      const found = getPath(parsed, config.decision.responsePath)
      if (found && typeof found === 'object') return found
    }
    if (parsed.answers && typeof parsed.answers === 'object') return parsed.answers
    const choiceText = parsed.choices?.[0]?.message?.content
    if (typeof choiceText === 'string') {
      const inner = parseJsonLoose(choiceText)
      if (inner) {
        if (inner.answers && typeof inner.answers === 'object') return inner.answers
        return inner
      }
    }
    return parsed
  }

  function readAnswer(answers, question) {
    if (!answers || typeof answers !== 'object' || !question) return null
    const value = answers[question]
    if (value === undefined || value === null) return null
    if (typeof value === 'string' || typeof value === 'number') {
      return { value, confidence: null, probabilities: null }
    }
    if (typeof value !== 'object') return null
    let picked = value.choice ?? value.answer ?? value.label ?? value.value ?? value.tier ?? value.recommended_tier
    if (picked === undefined && typeof value.score === 'number') {
      const legend = value.legend && typeof value.legend === 'object' ? value.legend : null
      if (legend && Object.keys(legend).length > 1) {
        picked = ratioToTier(value.score / (Object.keys(legend).length - 1))
      } else if (value.score >= 0 && value.score <= 1) {
        picked = ratioToTier(value.score)
      }
    }
    return {
      value: picked,
      confidence: typeof value.confidence === 'number' ? value.confidence : null,
      probabilities: value.probabilities ?? null,
    }
  }

  /**
   * How clearly the judge's first choice beat its second.
   *
   * The judge also reports a `confidence`, but that number is its own opinion
   * and it does not track the probabilities it returns alongside (a turn with
   * probabilities 0.59/0.32/0.09 reported 0.39, while one with 0.41/0.29/0.29
   * reported 0.12). The margin is computed from the reported distribution, so
   * it means the same thing on every turn, and a threshold on it can be
   * calibrated by reading the records.
   *
   * @param answer one answer from the judge.
   * @returns the top-two separation in [0,1], or null when there is none.
   */
  function marginOf(answer) {
    if (!answer) return null
    const probabilities = answer.probabilities
    if (!probabilities || typeof probabilities !== 'object') return null
    const values = Object.values(probabilities).filter((v) => typeof v === 'number').sort((a, b) => b - a)
    if (values.length < 2) return null
    return clamp01(values[0] - values[1])
  }

  function confidenceOf(answer) {
    if (!answer) return null
    const margin = marginOf(answer)
    if (margin !== null) return margin
    if (typeof answer.confidence === 'number') return clamp01(answer.confidence)
    return null
  }

  function buildTaskContent(agent, messages, st) {
    const claimed = Array.isArray(messages) ? messages : []
    const history = agent.session?.deriveMessages?.() ?? []
    const lastUser = st.turnPrompt || firstUserText(claimed) || lastUserText(history)
    const parts = []
    parts.push(lastUser ? `TASK:\n${clip(lastUser, config.decision.maxContentChars)}` : 'TASK:\n(no user text)')
    const digest = []
    for (const message of history.slice(-10)) {
      if (message.role === 'assistant') {
        const text = textOf(message)
        if (text) digest.push(`assistant: ${clip(text, 220)}`)
        const calls = (message.content ?? []).filter((block) => block.type === 'tool-call')
        if (calls.length) digest.push(`tool calls: ${calls.map((call) => call.name).join(', ')}`)
      } else if (message.role === 'tool') {
        digest.push(`tool ${message.isError ? 'ERROR' : 'ok'}: ${clip(textOf(message), 180)}`)
      }
    }
    if (digest.length) parts.push(`RECENT:\n${digest.slice(-8).join('\n')}`)
    return parts.join('\n\n')
  }

  /**
   * What the judge's separation actually looks like in this session.
   *
   * `downgradeConfidence` is compared against the top-two margin, and that
   * margin is not on the scale people assume: three tiers make 0.75 a demand
   * that the winner lead by three quarters of the probability mass. Publishing
   * the observed range lets the threshold be set from evidence instead of a
   * guess, which is the one thing the routing literature agrees on.
   *
   * @returns percentiles of the observed margins, or null before any judgement.
   */
  function marginStats() {
    const values = recent
      .map((entry) => entry.confidenceMargin)
      .filter((value) => typeof value === 'number')
      .sort((a, b) => a - b)
    if (values.length === 0) return null
    const at = (quantile) => values[Math.min(values.length - 1, Math.floor(quantile * values.length))]
    const threshold = config.policy.downgradeConfidence
    return {
      samples: values.length,
      min: values[0],
      p50: at(0.5),
      p90: at(0.9),
      max: values[values.length - 1],
      threshold,
      passing: values.filter((value) => value >= threshold).length,
    }
  }

  function record(agent, st, decision, turn, step) {
    const entry = {
      at: new Date().toISOString(),
      agent: String(agent.id),
      subagent: isSubagent(agent),
      turn,
      step,
      tier: decision.tier,
      provider: decision.provider,
      model: decision.model,
      effort: decision.effort ?? null,
      source: decision.source,
      rationale: decision.rationale,
      // The verdict the judge gave for this turn. A later step of the same
      // turn carries the same verdict, so the record always says who decided.
      decisionTier: decision.decisionTier ?? null,
      decisionEffort: decision.decisionEffort ?? null,
      confidence: decision.confidence ?? null,
      confidenceMargin: decision.confidenceMargin ?? null,
      reportedConfidence: decision.reportedConfidence ?? null,
      probabilities: decision.probabilities ?? null,
      decisionLatencyMs: decision.decisionLatencyMs ?? null,
      heuristicTier: decision.heuristic?.tier ?? null,
      heuristicScore: decision.heuristic?.score ?? null,
      // What the keyword rule actually saw, so its part in a decision can be
      // audited instead of guessed at.
      heuristicHits: decision.heuristic?.deepHits?.length || decision.heuristic?.mediumHits?.length || decision.heuristic?.fastHits?.length
        ? {
          deep: decision.heuristic?.deepHits ?? [],
          medium: decision.heuristic?.mediumHits ?? [],
          fast: decision.heuristic?.fastHits ?? [],
        }
        : null,
      decisionVerdict: decision.decisionVerdict ?? null,
    }
    recent.push(entry)
    if (recent.length > 100) recent.splice(0, recent.length - 100)
    if (config.debug) log('info', `model-router: ${entry.agent} -> ${entry.provider}/${entry.model} (${entry.tier}) ${entry.source}`)
  }

  // ---------------------------------------------------------------------
  // HTTP diagnostics
  // ---------------------------------------------------------------------

  function routeAllowed(req) {
    if (config.statusRoute === 'all') return true
    const address = req.socket?.remoteAddress ?? ''
    return address === '127.0.0.1'
      || address === '::1'
      || address === '::ffff:127.0.0.1'
      || address.startsWith('::ffff:127.')
  }

  function guardRoute(handler, req, res) {
    return Promise.resolve(handler(req, res)).catch((error) => {
      log('warn', `model-router: status route failed: ${messageOf(error)}`)
      if (res.headersSent) return res.end()
      return sendJson(res, 500, { error: messageOf(error) })
    })
  }

  /**
   * Register one diagnostic route and reclaim our own path when a previous
   * plugin generation leaked it (for example after a package replacement that
   * unloaded listeners but not their HTTP registrations).
   */
  function registerOwnedRoute(web, path, handler) {
    const route = { kind: 'exact', path, handler: (req, res) => guardRoute(handler, req, res) }
    try {
      return web.register(route)
    } catch (error) {
      if (!/duplicate/i.test(messageOf(error)) || !web.exact?.delete) throw error
      web.exact.delete(path)
      log('warn', `model-router: reclaimed stale route ${path}`)
      return web.register(route)
    }
  }

  /**
   * The configuration the control surface may read and edit.
   *
   * `decision.apiKey` is deliberately absent: a literal key never leaves the
   * Host. The environment variable name that holds it is editable instead.
   */
  function publicConfig() {
    return {
      mode: config.mode,
      notices: config.notices,
      debug: config.debug,
      policy: {
        main: config.policy.main,
        subagents: config.policy.subagents,
        decisionTrust: config.policy.decisionTrust,
        downgradeConfidence: config.policy.downgradeConfidence,
        onJudgeUnavailable: config.policy.onJudgeUnavailable,
        qualityFloor: config.policy.qualityFloor,
        maxTier: config.policy.maxTier,
        maxFastSteps: config.policy.maxFastSteps,
        allowDowngrade: config.policy.allowDowngrade,
        allowUpgrade: config.policy.allowUpgrade,
        escalateOnToolError: config.policy.escalateOnToolError,
        escalateOnRequestError: config.policy.escalateOnRequestError,
      },
      decision: {
        enabled: config.decision.enabled,
        activeId: config.decision.activeId,
        models: (config.decision.models ?? []).map((entry) => ({
          id: entry.id,
          label: entry.label,
          endpoint: entry.endpoint,
          model: entry.model,
          protocol: entry.protocol,
          timeoutMs: entry.timeoutMs,
          tierQuestion: entry.tierQuestion,
          effortQuestion: entry.effortQuestion,
          apiKeyEnv: entry.apiKeyEnv,
          questions: entry.questions,
        })),
        protocol: config.decision.protocol,
        endpoint: config.decision.endpoint,
        model: config.decision.model,
        timeoutMs: config.decision.timeoutMs,
        tierQuestion: config.decision.tierQuestion,
        effortQuestion: config.decision.effortQuestion,
        maxFailures: config.decision.maxFailures,
        cooldownMs: config.decision.cooldownMs,
        apiKeyEnv: config.decision.apiKeyEnv,
        questions: config.decision.questions,
        // The profile list, so several decision models survive a restart.
        models: (config.decision.models ?? []).map((entry) => ({
          id: entry.id,
          label: entry.label,
          endpoint: entry.endpoint,
          model: entry.model,
          protocol: entry.protocol,
          apiKeyEnv: entry.apiKeyEnv,
          timeoutMs: entry.timeoutMs,
          tierQuestion: entry.tierQuestion,
          effortQuestion: entry.effortQuestion,
          ...(usableQuestions(entry.questions) ? { questions: entry.questions } : {}),
        })),
        activeId: config.decision.activeId,
      },
    }
  }

  function profileEntry() {
    const editor = ctx.get?.('configEditor')
    if (!editor?.entries) return null
    let entries
    try {
      entries = editor.entries()
    } catch {
      return null
    }
    const own = ctx.fiber?.entry
    if (own && entries.includes(own)) return { editor, entry: own }
    const matched = entries.find((entry) => entry.options.id === 'model-router'
      && entry.options.name === '@local/dsh-model-router-web')
    return matched ? { editor, entry: matched } : null
  }

  function statusPayload() {
    const sessions = []
    for (const [id, st] of states) {
      sessions.push({
        id,
        overrideTier: st.overrideTier,
        origin: st.origin && { provider: st.origin.provider, model: st.origin.model, tier: st.origin.tier },
        active: st.active,
        turn: st.currentTurn,
        stepsThisTurn: st.stepsThisTurn,
        forceDeepUntilTurn: st.forceDeepUntilTurn,
        decision: st.decision && {
          provider: st.decision.provider,
          model: st.decision.model,
          tier: st.decision.tier,
          effort: st.decision.effort ?? null,
          source: st.decision.source,
          rationale: st.decision.rationale,
          confidence: st.decision.confidence ?? null,
          turn: st.decision.turn,
        },
      })
    }
    // Tier -> concrete candidate, so the control can show which model each
    // tier actually means instead of an internal label.
    const candidateByTier = {}
    for (const candidate of config.candidates) {
      if (!candidate.tier || candidateByTier[candidate.tier]) continue
      candidateByTier[candidate.tier] = {
        label: candidate.label,
        provider: candidate.provider,
        model: candidate.model,
      }
    }
    let clientBundle = null
    let clientUrls = []
    try {
      const modules = ctx.get?.('clientModules')
      clientBundle = modules?.clientPath?.('@local/dsh-model-router-web') ?? null
      const graph = modules?.graph?.()
      const batches = Array.isArray(graph?.batches) ? graph.batches : []
      for (const batch of batches) {
        for (const entry of batch.entries ?? []) {
          if (String(entry).includes('model-router')) clientUrls.push(batch.url)
        }
      }
    } catch {
      clientBundle = null
    }
    return {
      mode: config.mode,
      config: publicConfig(),
      candidateByTier,
      candidates: config.candidates,
      decision: {
        enabled: decisionEnabled(),
        activeId: config.decision.activeId,
        protocol: config.decision.protocol,
        endpoint: config.decision.endpoint,
        model: config.decision.model,
        open: decisionCircuitOpen(config.decision.activeId),
        failures: circuitFor(config.decision.activeId).failures,
      },
      policy: config.policy,
      // How much separation the judge's answers actually show.
      confidenceStats: marginStats(),
      // The judgement criteria every profile shares until it is given its own.
      // The panel shows these, so a new decision model needs no typing.
      defaultDecisionQuestions: DEFAULT_QUESTIONS,
      // The one-click decision model setups the panel offers.
      builtinDecisionModels: BUILTIN_DECISION_MODELS.map((entry) => ({
        id: entry.id,
        label: entry.label,
        endpoint: entry.endpoint,
        model: entry.model,
        protocol: entry.protocol,
        apiKeyEnv: entry.apiKeyEnv,
        timeoutMs: entry.timeoutMs,
        tierQuestion: entry.tierQuestion,
        effortQuestion: entry.effortQuestion,
      })),
      // Today's token totals per tier and model.
      usage: usageSummary(),
      usageDays: [...usage.days.keys()].sort(),
      // Whether an edit can be written to the profile entry, which is what
      // makes a change durable without a save action.
      saveAvailable: profileEntry() !== null,
      lastSave,
      clientBundle,
      clientUrls,
      overrides: [...overrides].map(([sessionId, tier]) => ({ sessionId, tier })),
      sessions: sessions.slice(-30),
      // The switch log: every recorded decision with the reason behind it.
      history: recent.slice(-200),
      recent: recent.slice(-50),
      requestErrors: requestErrors.slice(-20),
    }
  }

  /**
   * Keep one usable candidate per tier entry, dropping malformed rows.
   *
   * A candidate names the provider route and the exact model id; the tier is
   * the difficulty bucket the router assigns to it.
   */
  function normalizeCandidates(list) {
    if (!Array.isArray(list)) return null
    const out = []
    for (const [index, candidate] of list.entries()) {
      if (!candidate || typeof candidate !== 'object') continue
      const provider = String(candidate.provider ?? '').trim()
      const model = String(candidate.model ?? '').trim()
      if (!provider || !model) continue
      const tier = normalizeTier(candidate.tier) ?? 'balanced'
      out.push({
        label: String(candidate.label ?? model),
        provider,
        model,
        tier,
        cost: typeof candidate.cost === 'number' && Number.isFinite(candidate.cost) ? candidate.cost : index + 1,
        supportsTools: candidate.supportsTools !== false,
        supportsImages: candidate.supportsImages === true,
        maxContext: typeof candidate.maxContext === 'number' ? candidate.maxContext : undefined,
        efforts: Array.isArray(candidate.efforts) ? candidate.efforts.map((effort) => String(effort).toLowerCase()) : undefined,
        effortByTier: candidate.effortByTier && typeof candidate.effortByTier === 'object'
          ? Object.fromEntries(Object.entries(candidate.effortByTier)
            .filter(([, effort]) => effort !== undefined && effort !== null)
            .map(([key, effort]) => [key, String(effort).toLowerCase()]))
          : undefined,
      })
    }
    return out
  }

  function applyConfigPatch(patch) {
    if (!patch || typeof patch !== 'object') return
    if (['off', 'observe', 'auto'].includes(patch.mode)) config.mode = patch.mode
    if (typeof patch.notices === 'boolean') config.notices = patch.notices
    if (typeof patch.debug === 'boolean') config.debug = patch.debug
    const policy = patch.policy
    if (policy && typeof policy === 'object') {
      for (const key of ['main', 'subagents', 'allowDowngrade', 'allowUpgrade', 'escalateOnToolError', 'escalateOnRequestError']) {
        if (typeof policy[key] === 'boolean') config.policy[key] = policy[key]
      }
      if (['max', 'safe', 'decision'].includes(policy.decisionTrust)) config.policy.decisionTrust = policy.decisionTrust
      if (Number.isFinite(policy.downgradeConfidence) && policy.downgradeConfidence >= 0 && policy.downgradeConfidence <= 1) {
        config.policy.downgradeConfidence = policy.downgradeConfidence
      }
      const floor = normalizeTier(policy.qualityFloor)
      if (floor) config.policy.qualityFloor = floor
      const max = normalizeTier(policy.maxTier)
      if (max) config.policy.maxTier = max
      if (Number.isFinite(policy.maxFastSteps) && policy.maxFastSteps >= 1) {
        config.policy.maxFastSteps = Math.floor(policy.maxFastSteps)
      }
      normalizePolicyTiers(config.policy)
    }
    // The tier -> model mapping is the user's own choice; replace it whole.
    if (Array.isArray(patch.candidates)) {
      const next = normalizeCandidates(patch.candidates)
      if (next && next.length > 0) {
        config.candidates = next
        infoCache.clear()
      }
    }
    const decision = patch.decision
    if (decision && typeof decision === 'object') {
      if (typeof decision.enabled === 'boolean') config.decision.enabled = decision.enabled
      if (Number.isFinite(decision.maxFailures) && decision.maxFailures >= 1) {
        config.decision.maxFailures = Math.floor(decision.maxFailures)
      }
      if (Number.isFinite(decision.cooldownMs) && decision.cooldownMs >= 0) {
        config.decision.cooldownMs = Math.floor(decision.cooldownMs)
      }

      // The profile list. A patch carries the whole list, so adding,
      // removing and switching happen in one write.
      if (Array.isArray(decision.models)) {
        config.decision.models = normalizeDecisionModels({
          models: decision.models,
          apiKeyEnv: config.decision.apiKeyEnv,
        })
      }
      if (typeof decision.activeId === 'string') {
        const wanted = decision.activeId.trim()
        if (!wanted || config.decision.models.some((entry) => entry.id === wanted)) {
          config.decision.activeId = wanted
        }
      }
      if (!config.decision.models.some((entry) => entry.id === config.decision.activeId)) {
        config.decision.activeId = config.decision.models[0]?.id ?? ''
      }

      // A patch may also edit one profile in place, by id.
      if (decision.profile && typeof decision.profile === 'object') {
        const id = String(decision.profile.id ?? '').trim()
        const row = config.decision.models.find((entry) => entry.id === id)
        if (row) {
          const merged = normalizeDecisionModels({
            models: [{ ...row, ...decision.profile, id: row.id }],
            apiKeyEnv: config.decision.apiKeyEnv,
          })
          const index = config.decision.models.indexOf(row)
          if (merged[0]) config.decision.models.splice(index, 1, merged[0])
        }
      }

      // The flat fields describe the active profile and are kept in step.
      const active = config.decision.models.find((entry) => entry.id === config.decision.activeId)
      if (active) {
        config.decision.protocol = active.protocol
        config.decision.endpoint = active.endpoint
        config.decision.model = active.model
        config.decision.apiKeyEnv = active.apiKeyEnv
        config.decision.timeoutMs = active.timeoutMs
        config.decision.tierQuestion = active.tierQuestion
        config.decision.effortQuestion = active.effortQuestion
        config.decision.questions = active.questions
      }
    }
  }

  /**
   * The entry config this plugin should persist.
   *
   * It is the running configuration, expanded to the shape the bundle patch
   * uses, so a write replaces the entry the same way the Harness' own model
   * configuration replaces its own.
   *
   * @returns the config object to write into the profile patch.
   */
  function persistedConfig() {
    const base = profileEntry()?.entry?.options?.config ?? {}
    return {
      ...base,
      mode: config.mode,
      notices: config.notices,
      debug: config.debug,
      candidates: config.candidates.map((candidate) => ({
        label: candidate.label,
        provider: candidate.provider,
        model: candidate.model,
        tier: candidate.tier,
        cost: candidate.cost,
        supportsTools: candidate.supportsTools,
        supportsImages: candidate.supportsImages,
        ...(candidate.effortByTier ? { effortByTier: candidate.effortByTier } : {}),
      })),
      policy: {
        ...(base.policy ?? {}),
        main: config.policy.main,
        subagents: config.policy.subagents,
        decisionTrust: config.policy.decisionTrust,
      },
      decision: {
        ...(base.decision ?? {}),
        enabled: config.decision.enabled,
        protocol: config.decision.protocol,
        endpoint: config.decision.endpoint,
        model: config.decision.model,
        timeoutMs: config.decision.timeoutMs,
        tierQuestion: config.decision.tierQuestion,
        effortQuestion: config.decision.effortQuestion,
        maxFailures: config.decision.maxFailures,
        cooldownMs: config.decision.cooldownMs,
        apiKeyEnv: config.decision.apiKeyEnv,
        questions: config.decision.questions,
        // The profile list, so several decision models survive a restart.
        models: (config.decision.models ?? []).map((entry) => ({
          id: entry.id,
          label: entry.label,
          endpoint: entry.endpoint,
          model: entry.model,
          protocol: entry.protocol,
          apiKeyEnv: entry.apiKeyEnv,
          timeoutMs: entry.timeoutMs,
          tierQuestion: entry.tierQuestion,
          effortQuestion: entry.effortQuestion,
          ...(usableQuestions(entry.questions) ? { questions: entry.questions } : {}),
        })),
        activeId: config.decision.activeId,
      },
    }
  }

  /**
   * Persist the current configuration.
   *
   * This is the same call the Harness' own model configuration makes when it
   * saves a selection: the profile's configuration editor rewrites the entry.
   * There is therefore no separate save action in the control — a change is
   * durable as soon as it is made.
   *
   * @returns true when the write was accepted.
   */
  async function persistPatch() {
    const found = profileEntry()
    if (!found) {
      lastSave = { ok: false, at: new Date().toISOString(), error: 'profile entry is not directly addressable' }
      return false
    }
    try {
      await found.editor.edit(found.entry, () => persistedConfig())
      lastSave = { ok: true, at: new Date().toISOString() }
      return true
    } catch (error) {
      lastSave = { ok: false, at: new Date().toISOString(), error: messageOf(error) }
      log('warn', `model-router: persisting settings failed: ${messageOf(error)}`)
      return false
    }
  }

  async function handleStatus(req, res) {
    if (!routeAllowed(req)) return sendJson(res, 403, { error: 'forbidden' })
    return sendJson(res, 200, statusPayload())
  }

  async function handleConfig(req, res) {
    if (!routeAllowed(req)) return sendJson(res, 403, { error: 'forbidden' })
    if (req.method === 'GET') return sendJson(res, 200, { ok: true, ...statusPayload() })
    // A custom header forces a CORS preflight for cross-origin callers, which
    // this loopback control surface never answers; it blocks cross-site POSTs.
    if (req.headers['x-model-router-control'] !== '1') {
      return sendJson(res, 403, { error: 'control header required' })
    }
    let body = null
    try {
      body = await readJsonBody(req)
    } catch (error) {
      return sendJson(res, 400, { error: messageOf(error) })
    }
    const patch = body?.patch && typeof body.patch === 'object' ? body.patch : body
    // Apply first so the change is visible in this run even when the profile
    // cannot be written, then persist through the same surface the Harness'
    // own model configuration uses. Every persisted field is volatile, so the
    // Loader commits it into the live references without rebuilding us.
    applyConfigPatch(patch)
    const persisted = await persistPatch()
    return sendJson(res, 200, { ok: true, persisted, ...statusPayload() })
  }

  async function handleSession(req, res) {
    if (!routeAllowed(req)) return sendJson(res, 403, { error: 'forbidden' })
    if (req.headers['x-model-router-control'] !== '1') {
      return sendJson(res, 403, { error: 'control header required' })
    }
    let body = null
    try {
      body = await readJsonBody(req)
    } catch (error) {
      return sendJson(res, 400, { error: messageOf(error) })
    }
    const sessionId = String(body?.sessionId ?? '').trim()
    if (!sessionId) return sendJson(res, 400, { error: 'sessionId is required' })
    const tier = body?.tier
    let value
    if (tier === 'auto') value = null
    else if (tier === 'off' || TIERS.includes(tier)) value = tier
    else return sendJson(res, 400, { error: 'tier must be auto, off, fast, balanced, or deep' })
    if (value === null) overrides.delete(sessionId)
    else overrides.set(sessionId, value)
    const st = states.get(sessionId)
    if (st) st.overrideTier = value
    return sendJson(res, 200, { ok: true, sessionId, overrideTier: value, ...statusPayload() })
  }

  /**
   * The provider routes and the models each one advertises.
   *
   * The control surface offers these as the choices for each tier, so the
   * user picks a route from what this Host can actually reach.
   */
  async function handleProviders(req, res) {
    if (!routeAllowed(req)) return sendJson(res, 403, { error: 'forbidden' })
    const llm = getLlm()
    if (!llm?.listModels) return sendJson(res, 200, { providers: [], models: {} })
    let providers = []
    try {
      providers = llm.listProviders?.() ?? []
    } catch {
      providers = []
    }
    const models = {}
    await Promise.all(providers.map(async (provider) => {
      const id = String(provider?.id ?? '')
      if (!id) return
      const rows = []
      try {
        const listed = await llm.listModels(id)
        for (const model of listed ?? []) {
          let info = null
          try {
            info = await resolveInfo(id, model.id, AbortSignal.timeout(4000))
          } catch {
            info = null
          }
          rows.push({
            id: model.id,
            name: model.name ?? model.id,
            context: info?.context?.contextWindow ?? info?.context ?? null,
            defaultMaxTokens: info?.defaultMaxTokens ?? null,
            efforts: (info?.reasoning?.efforts ?? []).map((effort) => effort.id),
            inputModalities: Array.isArray(info?.inputModalities) ? info.inputModalities : null,
          })
        }
      } catch {
        // A provider that cannot be listed still appears, with no models.
      }
      models[id] = rows
    }))
    return sendJson(res, 200, {
      providers: providers
        .map((provider) => ({ id: String(provider?.id ?? ''), name: String(provider?.name ?? provider?.id ?? '') }))
        .filter((provider) => provider.id),
      models,
    })
  }

  async function handleModels(req, res) {
    if (!routeAllowed(req)) return sendJson(res, 403, { error: 'forbidden' })
    const results = await Promise.all(config.candidates.map(async (candidate) => {
      try {
        const info = await resolveInfo(candidate.provider, candidate.model, AbortSignal.timeout(5000))
        return {
          label: candidate.label,
          tier: candidate.tier,
          provider: candidate.provider,
          model: candidate.model,
          context: info?.context ?? null,
          defaultMaxTokens: info?.defaultMaxTokens ?? null,
          reasoning: info?.reasoning ?? null,
          inputModalities: info?.inputModalities ?? null,
        }
      } catch (error) {
        return {
          label: candidate.label,
          tier: candidate.tier,
          provider: candidate.provider,
          model: candidate.model,
          error: messageOf(error),
        }
      }
    }))
    return sendJson(res, 200, { candidates: results })
  }

  async function handleDecide(req, res) {
    if (!routeAllowed(req)) return sendJson(res, 403, { error: 'forbidden' })
    if (req.headers['x-model-router-control'] !== '1') {
      return sendJson(res, 403, { error: 'control header required' })
    }
    let content = ''
    try {
      if (req.method === 'GET') {
        const url = new URL(req.url ?? '/', 'http://localhost')
        content = url.searchParams.get('text') ?? ''
      } else {
        const body = await readJsonBody(req)
        content = typeof body?.content === 'string' ? body.content : (typeof body?.text === 'string' ? body.text : '')
      }
    } catch (error) {
      return sendJson(res, 400, { error: messageOf(error) })
    }
    if (!content.trim()) return sendJson(res, 400, { error: 'content is required' })
    const started = Date.now()
    const decision = await askDecision(content, {
      rootPreview: true,
      turn: 0,
      subagent: false,
      depth: 0,
      origin: { provider: 'preview', model: 'preview', tier: config.policy.baselineTier },
      active: null,
      tier: 'balanced',
      tokens: Math.ceil(content.length / 4),
    }, AbortSignal.timeout(Math.max(1000, config.decision.timeoutMs)))
    return sendJson(res, 200, {
      elapsedMs: Date.now() - started,
      decision,
      questions: usableQuestions(config.decision.questions) ?? DEFAULT_QUESTIONS,
    })
  }

  // ---------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------

  function abortableTimeout(ms, parent) {
    const controller = new AbortController()
    let timer = null
    const onAbort = () => controller.abort(parent?.reason)
    if (parent) {
      if (parent.aborted) controller.abort(parent.reason)
      else parent.addEventListener('abort', onAbort, { once: true })
    }
    if (ms > 0) {
      timer = setTimeout(() => controller.abort(new Error('decision timeout')), ms)
      timer.unref?.()
    }
    return {
      controller,
      signal: controller.signal,
      dispose() {
        if (timer) clearTimeout(timer)
        if (parent) parent.removeEventListener('abort', onAbort)
      },
    }
  }

  function createNotice(previous, chosen) {
    const from = previous.model
    const to = chosen.label ?? chosen.model
    const summary = clip(`model ${from} → ${to}`, 120)
    return {
      id: randomUUID(),
      role: 'user',
      content: [{
        type: 'text',
        text: `[model-router] This step continues on ${to} (${chosen.tier} tier); earlier assistant turns above were generated by ${from}.`,
      }],
      source: { kind: 'model-router', form: 'notice', summary },
    }
  }
}

// -----------------------------------------------------------------------
// Pure helpers (also used by the HTTP diagnostics above through closure)
// -----------------------------------------------------------------------

function normalizeConfig(rawConfig) {
  const merged = deepMerge(DEFAULT_CONFIG, rawConfig ?? {})
  merged.mode = merged.mode === true ? 'auto' : merged.mode === false ? 'off' : String(merged.mode ?? 'off')
  if (!['off', 'observe', 'auto'].includes(merged.mode)) merged.mode = 'auto'
  merged.policy.qualityFloor = normalizeTier(merged.policy.qualityFloor) ?? 'fast'
  merged.policy.maxTier = normalizeTier(merged.policy.maxTier) ?? 'deep'
  merged.policy.subagentMaxTier = normalizeTier(merged.policy.subagentMaxTier) ?? ''
  merged.policy.baselineTier = normalizeTier(merged.policy.baselineTier) ?? 'balanced'
  normalizePolicyTiers(merged.policy)
  if (['max', 'safe', 'decision'].includes(merged.policy.decisionTrust) === false) {
    merged.policy.decisionTrust = 'max'
  }
  // A profile layer replaces `policy` wholesale, so a value added after that
  // layer was written never reaches the default. Fill it in here instead of
  // relying on the bundle's default object.
  if (['hold', 'heuristic'].includes(merged.policy.onJudgeUnavailable) === false) {
    merged.policy.onJudgeUnavailable = 'hold'
  }
  merged.candidates = (Array.isArray(merged.candidates) ? merged.candidates : [])
    .map((candidate, index) => {
      if (!candidate || typeof candidate !== 'object') return null
      const provider = String(candidate.provider ?? '').trim()
      const model = String(candidate.model ?? '').trim()
      if (!provider || !model) return null
      const tier = normalizeTier(candidate.tier) ?? 'balanced'
      return {
        label: String(candidate.label ?? model),
        provider,
        model,
        tier,
        cost: typeof candidate.cost === 'number' && Number.isFinite(candidate.cost) ? candidate.cost : index + 1,
        supportsTools: candidate.supportsTools !== false,
        supportsImages: candidate.supportsImages === true,
        maxContext: typeof candidate.maxContext === 'number' ? candidate.maxContext : undefined,
        efforts: Array.isArray(candidate.efforts) ? candidate.efforts.map((effort) => String(effort).toLowerCase()) : undefined,
        effortByTier: candidate.effortByTier && typeof candidate.effortByTier === 'object'
          ? Object.fromEntries(Object.entries(candidate.effortByTier)
            .filter(([, effort]) => effort !== undefined && effort !== null)
            .map(([key, effort]) => [key, String(effort).toLowerCase()]))
          : undefined,
      }
    })
    .filter(Boolean)
  if (merged.decision.questions && typeof merged.decision.questions !== 'object') {
    merged.decision.questions = null
  }
  if (merged.decision.questions && Object.keys(merged.decision.questions).length === 0) {
    merged.decision.questions = null
  }
  merged.decision.models = normalizeDecisionModels(merged.decision)
  merged.decision.activeId = String(merged.decision.activeId ?? '').trim()
  if (!merged.decision.models.some((entry) => entry.id === merged.decision.activeId)) {
    merged.decision.activeId = merged.decision.models[0]?.id ?? ''
  }
  // The flat fields describe the active profile, so the rest of the plugin and
  // the older config shape keep working with either one.
  const active = merged.decision.models.find((entry) => entry.id === merged.decision.activeId)
  if (active) {
    merged.decision.protocol = active.protocol
    merged.decision.endpoint = active.endpoint
    merged.decision.model = active.model
    merged.decision.apiKeyEnv = active.apiKeyEnv
    merged.decision.timeoutMs = active.timeoutMs
    merged.decision.tierQuestion = active.tierQuestion
    merged.decision.effortQuestion = active.effortQuestion
    merged.decision.questions = active.questions
  }
  return merged
}

/**
 * The switch log, shared across plugin generations.
 *
 * Saving the configuration makes the Loader rebuild this bundle, which would
 * otherwise drop every recorded decision. The entries live on a global symbol
 * so the rebuilt generation continues the same log.
 */
function sharedHistory() {
  return sharedStore('history', () => [])
}

/**
 * A value that outlives one plugin generation.
 *
 * Writing the configuration makes the Loader rebuild this bundle, so anything
 * the panel should keep showing across a settings change lives here rather
 * than in the fiber.
 *
 * @param name - store name within this plugin's global slot.
 * @param create - builds the value on first use.
 * @returns the shared value.
 */
function sharedStore(name, create) {
  const key = Symbol.for(`dsh.model-router.${name}`)
  const scope = globalThis
  if (!scope[key]) scope[key] = create()
  return scope[key]
}

function deepMerge(base, patch) {
  if (!isPlainObject(patch)) return clone(base)
  const out = clone(base)
  for (const [key, value] of Object.entries(patch)) {
    if (isPlainObject(value) && isPlainObject(out[key])) out[key] = deepMerge(out[key], value)
    else out[key] = clone(value)
  }
  return out
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function clone(value) {
  if (Array.isArray(value)) return value.map(clone)
  if (isPlainObject(value)) {
    const out = {}
    for (const [key, entry] of Object.entries(value)) out[key] = clone(entry)
    return out
  }
  return value
}

function normalizePolicyTiers(policy) {
  if (TIER_RANK[policy.qualityFloor] > TIER_RANK[policy.maxTier]) {
    policy.maxTier = policy.qualityFloor
  }
  if (policy.subagentMaxTier && TIER_RANK[policy.subagentMaxTier] < TIER_RANK[policy.qualityFloor]) {
    policy.subagentMaxTier = policy.qualityFloor
  }
}

/**
 * Normalize the decision model profiles.
 *
 * The list may be absent while the older flat fields still carry one profile;
 * that shape is migrated here so a profile written before the list existed
 * keeps working.
 *
 * @param {object} decision - the decision section of a config.
 * @returns {object[]} the normalized profiles.
 */
function normalizeDecisionModels(decision) {
  const rows = Array.isArray(decision?.models) ? decision.models : []
  const out = []
  const seen = new Set()
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue
    const id = String(row.id ?? '').trim()
    const endpoint = String(row.endpoint ?? '').trim()
    const model = String(row.model ?? '').trim()
    if (!id && !endpoint && !model) continue
    const key = id || `${endpoint}|${model}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({
      id: key,
      label: String(row.label ?? model ?? endpoint ?? key),
      endpoint,
      model,
      protocol: ['systemone', 'openai', 'custom'].includes(row.protocol) ? row.protocol : 'systemone',
      apiKeyEnv: String(row.apiKeyEnv ?? 'DECISION_MODEL_API_KEY').trim(),
      timeoutMs: Number.isFinite(row.timeoutMs) && row.timeoutMs >= 100 ? Math.floor(row.timeoutMs) : 900,
      tierQuestion: String(row.tierQuestion ?? 'tier').trim() || 'tier',
      effortQuestion: String(row.effortQuestion ?? 'effort').trim() || 'effort',
      questions: row.questions && typeof row.questions === 'object' && !Array.isArray(row.questions)
        ? row.questions
        : null,
    })
  }
  // A flat decision block is a single profile written before the list existed.
  if (out.length === 0) {
    const endpoint = String(decision?.endpoint ?? '').trim()
    const model = String(decision?.model ?? '').trim()
    if (endpoint || model) {
      out.push({
        id: model || endpoint,
        label: model || endpoint,
        endpoint,
        model,
        protocol: ['systemone', 'openai', 'custom'].includes(decision?.protocol) ? decision.protocol : 'systemone',
        apiKeyEnv: String(decision?.apiKeyEnv ?? 'DECISION_MODEL_API_KEY').trim(),
        timeoutMs: Number.isFinite(decision?.timeoutMs) && decision.timeoutMs >= 100 ? Math.floor(decision.timeoutMs) : 900,
        tierQuestion: String(decision?.tierQuestion ?? 'tier').trim() || 'tier',
        effortQuestion: String(decision?.effortQuestion ?? 'effort').trim() || 'effort',
        questions: decision?.questions && typeof decision.questions === 'object' && !Array.isArray(decision.questions)
          ? decision.questions
          : null,
      })
    }
  }
  return out
}

function normalizeTier(value) {
  if (value === undefined || value === null) return null
  if (typeof value === 'number') return ratioToTier(value)
  const text = String(value).trim().toLowerCase()
  if (!text) return null
  if (TIER_RANK[text] !== undefined) return text
  if (/(^|[^a-z])(fast|simple|easy|trivial|light|quick|low)([^a-z]|$)/.test(text)) {
    if (/(medium|moderate|balanced|normal|standard|mid)/.test(text)) return 'balanced'
    return 'fast'
  }
  if (/(deep|complex|hard|difficult|heavy|expert)/.test(text)) return 'deep'
  if (/(medium|moderate|balanced|normal|standard|mid)/.test(text)) return 'balanced'
  return null
}

function ratioToTier(ratio) {
  if (ratio <= 0.34) return 'fast'
  if (ratio <= 0.67) return 'balanced'
  return 'deep'
}

function normalizeEffort(value) {
  if (value === undefined || value === null) return null
  if (typeof value === 'number') {
    if (value <= 0.34) return 'low'
    if (value <= 0.67) return 'medium'
    return 'high'
  }
  const text = String(value).trim().toLowerCase()
  if (/(off|none|minimal|low|light)/.test(text)) return 'low'
  if (/(medium|moderate|mid|normal|balanced|default)/.test(text)) return 'medium'
  if (/(high|max|deep|heavy|expert)/.test(text)) return 'high'
  return null
}

/** Criteria that actually say something, or null when they say nothing.
 * An empty object is what a half-filled editor leaves behind; treating it as
 * "no criteria" keeps the built-in standard in force instead of asking the
 * judge to choose with no instructions.
 * @param value candidate criteria.
 * @returns the criteria, or null when it is empty.
 */
function usableQuestions(value) {
  if (!value || typeof value !== 'object') return null
  const tier = value.tier?.criteria
  if (tier && typeof tier === 'object' && Object.keys(tier).length > 0) return value
  const effort = value.effort?.criteria
  if (effort && typeof effort === 'object' && Object.keys(effort).length > 0) return value
  return null
}

function matchKeywords(text, keywords) {
  if (!text) return []
  const lower = text.toLowerCase()
  const hits = []
  for (const keyword of keywords ?? []) {
    const needle = String(keyword).toLowerCase()
    if (!needle) continue
    // CJK has no word boundaries; match it as a substring.
    if (/[\u3400-\u9fff]/.test(needle)) {
      if (lower.includes(needle)) hits.push(needle)
      continue
    }
    // A trailing * marks a deliberate prefix ("migrat*" matches migrate and
    // migration); everything else matches whole words only, so "transcript"
    // does not match "script" and "finding" does not match "find".
    const prefix = needle.endsWith('*')
    const base = prefix ? needle.slice(0, -1) : needle
    if (!base) continue
    const escaped = base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const pattern = prefix
      ? new RegExp(`(?:^|[^a-z0-9])${escaped}`, 'i')
      : new RegExp(`(?:^|[^a-z0-9])${escaped}(?=$|[^a-z0-9])`, 'i')
    if (pattern.test(lower)) hits.push(needle)
  }
  return hits
}

function lastUserText(messages) {
  if (!Array.isArray(messages)) return ''
  let fallback = ''
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (!message || message.role !== 'user') continue
    const text = textOf(message)
    if (!text.trim()) continue
    if (message.source?.kind === 'user') return text
    if (!fallback) fallback = text
  }
  return fallback
}

/**
 * The model-facing prompt of a user message, or '' for injected context
 * (runtime context, subagent relay, notices, compaction material).
 */
function promptTextOf(message) {
  if (!message || message.role !== 'user') return ''
  // The first text block is the user's own request; later blocks are harness
  // guidance appended to child prompts (return instructions, for example).
  const text = firstTextOf(message).trim()
  if (!text) return ''
  const kind = message.source?.kind
  if (kind !== undefined && kind !== 'user') return ''
  return text
}

function firstTextOf(message) {
  for (const block of message?.content ?? []) {
    if (block?.type === 'text' && typeof block.text === 'string' && block.text.trim()) return block.text
  }
  return ''
}

function firstUserText(messages) {
  if (!Array.isArray(messages)) return ''
  let fallback = ''
  for (const message of messages) {
    if (!message || message.role !== 'user') continue
    const text = textOf(message)
    if (!text.trim()) continue
    if (message.source?.kind === 'user') return text
    if (!fallback) fallback = text
  }
  return fallback
}

function textOf(message) {
  if (!message || !Array.isArray(message.content)) return ''
  return message.content
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
}

function textOfMessages(messages) {
  if (!Array.isArray(messages)) return ''
  return messages.map(textOf).filter(Boolean).join('\n')
}

function hasImages(messages, history) {
  for (const message of [...(messages ?? []), ...(history ?? [])].slice(-40)) {
    if (!Array.isArray(message?.content)) continue
    if (message.content.some((block) => block?.type === 'image')) return true
  }
  return false
}

function estimateTokens(agent, messages) {
  const parts = [...(messages ?? []), ...(agent?.session?.deriveMessages?.() ?? []).slice(-60)]
  let chars = 0
  let images = 0
  for (const message of parts) {
    for (const block of message?.content ?? []) {
      if (block?.type === 'text' && typeof block.text === 'string') chars += block.text.length
      else if (block?.type === 'image') images += 1
      else if (block?.type === 'tool-call') chars += 200
    }
  }
  return Math.ceil(chars / 4) + images * 1200
}

function latestToolErrorId(agent) {
  const messages = agent?.session?.deriveMessages?.() ?? []
  for (let index = messages.length - 1; index >= 0 && index >= messages.length - 8; index -= 1) {
    const message = messages[index]
    if (message?.role === 'tool' && message.isError) return String(message.id)
  }
  return null
}

function sameRoute(left, right) {
  return Boolean(left && right && left.provider === right.provider && left.model === right.model)
}

function applyRoute(base, target) {
  const out = { ...base, provider: target.provider, model: target.model }
  if (target.effort) out.reasoningEffort = target.effort
  else if (!sameRoute(base, target) && out.reasoningEffort !== undefined) delete out.reasoningEffort
  return out
}

function routeKey(route) {
  return `${route.provider}/${route.model}`
}

function clamp01(value) {
  if (typeof value !== 'number' || Number.isNaN(value)) return 0
  return Math.min(1, Math.max(0, value))
}

function clip(text, max) {
  const value = String(text ?? '')
  return value.length <= max ? value : `${value.slice(0, Math.max(0, max - 1))}…`
}

function messageOf(error) {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  try {
    return JSON.stringify(error)
  } catch {
    return String(error)
  }
}

function parseJsonLoose(text) {
  if (typeof text !== 'string') return null
  const trimmed = text.trim()
  try {
    return JSON.parse(trimmed)
  } catch {
    const start = trimmed.indexOf('{')
    const end = trimmed.lastIndexOf('}')
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(trimmed.slice(start, end + 1))
      } catch {
        return null
      }
    }
    return null
  }
}

function getPath(value, path) {
  let current = value
  for (const part of String(path).split('.')) {
    if (!current || typeof current !== 'object') return undefined
    current = current[part]
  }
  return current
}

function renderTemplate(template, variables) {
  if (typeof template === 'string') {
    const exact = template.match(/^\{\{(\w+)\}\}$/)
    if (exact) {
      const value = variables[exact[1]]
      if (value !== undefined) {
        try {
          return JSON.parse(value)
        } catch {
          return value
        }
      }
    }
    return template.replace(/\{\{(\w+)\}\}/g, (_, key) => {
      const value = variables[key]
      return value === undefined ? '' : String(value)
    })
  }
  if (Array.isArray(template)) return template.map((entry) => renderTemplate(entry, variables))
  if (isPlainObject(template)) {
    const out = {}
    for (const [key, value] of Object.entries(template)) out[key] = renderTemplate(value, variables)
    return out
  }
  return template
}

async function readJsonBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > 1024 * 1024) throw new Error('body too large')
    chunks.push(chunk)
  }
  if (chunks.length === 0) return null
  return parseJsonLoose(Buffer.concat(chunks).toString('utf8'))
}

function sendJson(res, status, value) {
  const body = JSON.stringify(value, null, 2)
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(body)
}
