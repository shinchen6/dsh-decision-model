# Design notes

A Host + Web Client DeepSeek Harness bundle that picks a provider/model **and** a
reasoning effort for every turn and every subagent. It combines a configurable
decision model with local heuristics, applies the choice to the live request,
and falls back to the session's own route whenever anything is uncertain.

The goal is the usual cost/latency trade-off without silently lowering quality:

- easy, short, localized turns go to the fast tier;
- ordinary coding goes to the balanced tier;
- design, debugging, review, migration, security, or failure-affected turns go
  to the deep tier;
- tool failures, failed requests, images that the candidate cannot read, and
  context that will not fit force a safer route.

## Tiers and candidates

Tiers are ordered `fast < balanced < deep`. Every candidate names an exact
provider/model route:

```yaml
candidates:
  - label: flash                 # shown in notices and diagnostics
    provider: minimax-cn         # registered LLM provider route
    model: MiniMax-M3.1-Flash
    tier: fast
    cost: 1                      # relative; the cheapest fitting route wins
    supportsTools: true
    supportsImages: true
    maxContext: 1000000          # optional; adapter metadata is preferred
    efforts: [low, medium, high] # optional; otherwise adapter metadata is read
    effortByTier:                # optional; usually left empty
      balanced: high
```

The tier-to-model mapping is the user's own choice: the composer control edits
it directly, listing the providers and models this Host can reach. The file
below is only the starting point.

Thinking level is automatic: the router uses the candidate's `effortByTier`
entry when one is set, then the global `effortByTier`, then the decision
model's hint, and finally the model's own default. Leave both maps empty to
let the decision model and the adapter choose.

A candidate is usable only when it passes all of these checks:

1. it is not marked unhealthy after a failed request;
2. `llm.resolveModelInfo()` succeeds;
3. it accepts images when the conversation contains an image;
4. its context window fits the estimated request;
5. `llm.prepareCall()` succeeds for the exact route and effort.

The router also reconciles output caps: if the session's configured `maxTokens`
exceeds the target adapter's advertised default, the request is clamped to the
adapter's value; switching back to a roomier route restores the Agent's own
cap. This prevents a route change from failing on an otherwise valid request.

If no candidate fits, the router **keeps the route the session already had**.
It never invents a provider/model and never falls back to a *weaker* tier than
the one it decided on.

## Decision model

Several decision models can be configured and one is used at a time:

```yaml
decision:
  enabled: true
  models:
    - id: jev
      label: jev
      protocol: systemone
      endpoint: ''
      model: decision-model-preview
      timeoutMs: 900
      tierQuestion: tier
      effortQuestion: effort
  activeId: jev
```

Each entry is a complete profile. The panel's **配置 / Configure** modal lists
them: pick a row to switch to it, edit it to change its fields, or remove it.
The settings tab also offers them as a dropdown, so switching does not need the
modal.

**The judgement criteria are shared.** A profile that carries none uses the
plugin's built-in standard, which the panel displays read-only; **自定义 /
Customise** gives that one profile its own copy, and **用统一标准 / Use the
standard** drops it again. Nothing has to be typed for a new profile to work.
Criteria that say nothing — an empty or half-filled object — are treated as the
standard, so a partially filled editor cannot leave the judge with no
instructions.
**快速配置 / Quick setups** adds a ready-made profile in one click. Every
profile carries its own failure breaker, so one judge that stops answering
does not silence the others.

A configuration written before the list existed — a flat `endpoint` and `model`
directly under `decision` — is read as a single profile, so it keeps working.

Two inputs produce the desired tier:

- **Local heuristics** inspect the last user message (length, intent keywords,
  image presence, recent tool errors, recent request errors, estimated tokens).
- **The decision model** classifies the same task. Its answer can raise the
  tier; with `policy.decisionTrust: max` (the default) it cannot lower it.
  `safe` allows a measured downgrade when the gap between the judge's first and
  second choice clears `policy.downgradeConfidence`; `decision` lets the model
  decide outright.

The built-in `systemone` protocol matches this deployment's endpoint:

```http
POST /v1/chat/completions
Content-Type: application/json

{
  "model": "decision-model-preview",
  "state": {
    "ticket_id": "<session-id>",
    "content": "TASK: ...\n\nRECENT: ...",
    "metadata": { "turn": 3, "subagent": false, "baseline_tier": "fast", "...": "..." }
  },
  "questions": {
    "tier":   { "type": "choice", "criteria": { "fast": "...", "balanced": "...", "deep": "..." } },
    "effort": { "type": "choice", "criteria": { "low": "...", "medium": "...", "high": "..." } }
  }
}
```

The response is read from `answers.<tierQuestion>.choice` (with
`confidence` and `probabilities` for the confidence guard), or from a JSON
object / OpenAI `choices[0].message.content` when `protocol: openai` is used.
`protocol: custom` renders `requestTemplate` with `{{model}}`, `{{content}}`,
`{{state}}`, `{{questions}}`, and `{{endpoint}}`.

The decision call has a hard timeout (default 900 ms) and a circuit breaker
(default 3 failures for 60 s) per profile. A judge that is slow or down has no
effect on the request: heuristics alone then choose the tier.

The decision endpoint receives a bounded task digest: the first text block of
the current user request plus short recent-activity snippets. Set
`decision.enabled: false` to keep routing entirely local (heuristics only).

## Why the local rule is shaped the way it is

The keyword rule is deliberately limited, and the limits come from published
evidence rather than taste.

**A cheap local classifier is a normal design, not a compromise.** LiteLLM
ships a keyword/pattern scorer as its *default* router classifier, with seven
weighted dimensions (`codePresence`, `reasoningMarkers`, `technicalTerms`,
`tokenCount`, …) and tier boundaries at 0.15 / 0.35 / 0.60, and reports it makes
no classifier LLM call at all. A local rule costs nothing, adds no latency, and
keeps the prompt on the machine.

**But a router of this class barely beats the obvious baseline.** RouterBench
(Hu et al., arXiv:2403.12031) measures seven routing algorithms across seven
tasks and finds: "none of the routing algorithms significantly outperform the
baseline Zero router" — where the Zero router is a cost-optimal random mix over
the models' quality/cost hull. Learned routers with real training data
(AutoMix, arXiv:2310.12963) reduce cost by 50%+; a keyword list is not that.
So the local rule here is treated as a *cheap signal*, not an oracle.

**Predicting up front needs data we do not have.** RouteLLM (Ong et al.,
arXiv:2406.18665) trains binary win-prediction routers on preference data and
reports that high-capacity routers "perform close to random" without in-domain
labels — BERT scored an APGR of 0.391 against a random baseline of 0.500, i.e.
*worse than random*. Adding ~1500 in-domain samples flipped it to 0.572. This
plugin ships no training data, so it does not pretend to be a trained router.

**Cascades need a reliable verifier, and we have one for free.** FrugalGPT
(Chen, Zaharia, Zou, arXiv:2305.05176) is a cascade: a cheap scoring function
accepts or defers each answer against a per-model threshold. RouterBench
simulates the same design and finds the cascade "quickly approximates the
performance of the Oracle" at zero verifier error, but degrades "rapidly" once
the verifier errs more than 20% of the time. A tool call that returned an error
is close to a zero-error verifier, which is why tool-error escalation is the one
cascade trigger this plugin trusts — and why it is deliberately narrow.

**What the rule is therefore allowed to do:** supply facts the judge cannot see
(token estimate, image presence, subagent depth, step count) and escalate on
unambiguous failure. It is not allowed to *lower* a tier on the strength of
keywords while the judge is unavailable, because a missing forecast is not
evidence that the task is easy. NVIDIA's Switchyard documents the same
asymmetry: when its judge times out, errors, or returns an unparseable verdict,
it routes to the *capable* tier and names `judge_failure`.

**The judge is not told what the local rule concluded.** Switchyard's judge
deliberately never sees candidate prices, provider names, or tool definitions.
An LLM asked to agree or disagree with a stated prior tends to agree with it,
which would make the second opinion worthless. The judge receives the task, a
compressed activity digest, and factual metadata only.

**The downgrade threshold is a measurement, not a constant to trust.**
`policy.downgradeConfidence` is compared against the gap between the judge's
first and second choice. The judge's own `confidence` field is not used for this
because it does not track its own probabilities (0.59/0.32/0.09 reported 0.39,
while 0.41/0.29/0.29 reported 0.12). Both numbers are recorded, and the panel
shows the observed percentiles beside the setting, which is the only way to pick
it honestly — the same reason RouteLLM ships a `calibrate_threshold` tool rather
than a default.

### What this deliberately does not do

- **No post-hoc cascade** (run cheap, inspect the answer, re-run strong). No
  documented commercial router ships this except NeMo Switchyard's `escalation`
  mode, which needs a session id, buffers each reply, and requires two
  consecutive fresh-evidence verdicts before latching. Re-running a completed
  turn is a much larger change than this plugin makes today.
- **No answer-quality verifier.** Scoring a free-text answer reliably is the
  hard part of a cascade, and a bad verifier is worse than none: RouterBench
  shows the cascade collapsing past a 20% verifier error rate.
- **No trained classifier.** It would need labelled in-domain data that this
  project does not collect.

### Known gap worth stating

Truncation (`finish_reason=length`) and empty or suspiciously short output are
not used as escalation triggers. No commercial router documented in this
research uses them either, so this is an open area rather than an oversight.

## Who decides

The decision model is the judge. A local rule also scores the turn, but only
as a fallback: it decides when the decision endpoint is unavailable, and it
carries the risk signals (a request that failed, a tool that failed) that
raise the tier. The trust setting decides how far the judge may go:

| Setting | Effect |
|---|---|
| Quality first | The judge may only pick a stronger model. |
| Allow it to downgrade | The judge may pick a cheaper model when it is confident. |
| Follow it exactly | The judge's answer is used as is. |

## Safety rails

- **Turn stickiness:** a route is chosen on the first step of a turn and held
  for the rest of it. It is re-evaluated next turn.
- **Escalation:** a failed tool result raises the tier by one; a failed model
  request forces the deep tier for the rest of that turn and the configured
  follow-up turns, and marks the failed route unhealthy.
- **External selections win:** if a request arrives with a provider/model the
  router did not choose (for example a UI model switch), the router adopts it
  as the new baseline and stands down for that request.
- **Durable notice:** when the provider/model changes, a normal user-role
  notice is appended to the step, so the new model knows the earlier turns
  came from a different model. Effort-only changes add no notice.
- **No new event types:** the router only changes `agent/request` config,
  `system-prompt` variables, and an ordinary user message.
- **Fail closed:** `mode: off` registers no listeners; `mode: observe` computes
  and records decisions without touching any request.

## Configuration

The full default lives in `cordis.patch.yml`. The important switches:

| Key | Default | Meaning |
| --- | --- | --- |
| `mode` | `auto` | `off`, `observe`, or `auto` |
| `policy.main` | `true` | Route the main session |
| `policy.subagents` | `true` | Route subagents |
| `policy.maxDepth` | `2` | Skip deeper delegation levels |
| `policy.qualityFloor` | `fast` | Lowest tier ever selected |
| `policy.maxTier` | `deep` | Highest tier for a main session |
| `policy.maxFastSteps` | `8` | Raise a fast route after this many steps in one turn |
| `policy.subagentMaxTier` | `""` | Per-subagent ceiling; empty follows `maxTier` |
| `policy.decisionTrust` | `max` | `max`, `safe`, or `decision` |
| `policy.downgradeConfidence` | `0.75` | Top-two gap the judge needs to lower a tier. 0.75 is strict; ~0.3 lets it act. |
| `policy.onJudgeUnavailable` | `hold` | `hold` keeps the current route when the judge is silent; `heuristic` lets the local rule decide. |
| `policy.allowDowngrade` | `true` | Permit switching to a cheaper tier |
| `notices` | `true` | Append the durable route notice |
| `debug` | `false` | Log every decision |

A candidate's `effortByTier` wins over the global `effortByTier`. Effort is
always validated against the adapter; unsupported efforts are omitted rather
than guessed.

## Composer controls

The Client half adds a compact `Router · <tier>` control to
`conversation.input.right`, immediately before the Send action. The panel has
two tabs: **Settings** and **Records**.

**Working mode comes first**, because the mode decides which settings matter.
The bundle starts in `off`.

| Mode | What it does | What you configure |
|---|---|---|
| **Off** | Nothing is judged and no model is switched. | Nothing yet. |
| **Watch only** | Every turn is judged and written to the records, but no request is changed. | The models each tier points at, and how difficulty is judged. |
| **Auto** | The judgement is applied for real. | The same settings; auto also applies them. |

The settings tab then shows only what the current mode needs:

- **Models per tier** — one flat picker per difficulty level (Cheapest /
  Middle / Strongest), grouped by provider, so a route is two clicks rather
  than a provider choice followed by a model choice. The picker lists the
  providers and models this Host can actually reach. The thinking level is
  **chosen automatically** — the decision model's hint when it offers one,
  otherwise the model's own default — so there is nothing to configure for it.
- **Applies to** — the main chat and subagents.
- **How much to trust the judge** — Quality first (it may only pick a stronger
  model), Allow it to downgrade, or Follow it exactly.

The decision model has its own **Configure** button beside the panel title,
which opens a modal listing every configured decision model. Several can be
configured and one is used at a time: pick a row to switch to it, edit it to
change its endpoint, model, protocol, timeout, the names of the tier and
effort questions and the criteria text it reads to judge a turn, or remove it.
**Quick setups** offers a ready-made profile — the bundled `jev` setup points
at the intranet decision service — that is added with one click. There is no
separate enable switch: configuring a decision model turns it on, and **Done**
applies and closes in one step.

The panel's settings tab names the decision model in use, so it is visible
without opening the modal. Each decision model carries its own failure
breaker, so one judge that stops answering does not silence the others.

A turn that carries an image only ever runs on a model that accepts images: the
router checks each candidate's advertised input modalities before switching,
and keeps the current route when no candidate can take the picture. Models
that cannot read images are marked in the picker.

A **statistics** block sits at the top of the panel: today's token totals,
one row per tier and model, with the day's total on the right. The numbers
come from the provider's own accounting, taken from the durable session
events, so they are what was actually billed rather than an estimate. The
totals survive a settings change, which rebuilds the plugin.

The **Records** tab lists every routing decision with the reason behind it:
the time, the tier and model it chose, the thinking level, and where the
decision came from (the decision model, your manual choice, a failure
escalation). Tap a row to expand it: the **verdict the decision model gave
for this turn** — its tier, its confidence and the thinking level it asked for
— the answer probabilities when the endpoint returns them, the provider,
model, thinking level, turn, step and the full agent id, and the **verbatim
judgement payload** the decision model returned, so a surprising choice can be
read against what the model actually said. Each row also reports how long the
judge took to answer and how many tokens that answer consumed. The log
survives settings changes, which rebuild the plugin.

The judge answers once per turn, and every later step of that turn reports
the same verdict. A turn with many tool calls therefore shows one judgement,
not one per step.

While routing is in `auto`, the composer's own model selector is hidden: the
router owns the model choice, so a second selector would contradict it. The
rule targets the slot outlet (`data-slot="conversation.input.model"`) and needs
`!important`, because the renderer gives that outlet an inline
`display: contents`. In its place the composer chip reports what is actually
running (`模型路由 · MiniMax-M3.1-Flash · 低`), with the tier and mode in its
tooltip. In `observe` the request is untouched, so the selector stays
available.

**There is no save button, by design.** Every change is written to the profile
immediately, through the same configuration-editor call the Harness' own model
configuration makes when it saves a selection — so a change is live and
durable in one step. If the profile cannot be written, the change still applies
to the running process and the panel says so.

The panel uses the Web host's theme tokens, closes on Escape or an outside
click, and follows the interface language (English/Chinese). If the page is
opened from another host, the control shows that the router status is
unavailable because the Host routes are loopback-only by default.

After installing or replacing the bundle, refresh the page once if the chip
does not appear; the Host registers the Client bundle immediately, and the
browser loads it on its next boot or HMR pass.

## Tests

```
node test/vision.test.mjs        # the vision guard and the effort hold
node test/client-render.test.mjs  # the control renders in every mode
```

`client-render.test.mjs` loads the real client module into a stub DOM and
renders the control in each working mode with a live session. It exists
because a `const` used before its declaration throws only when that branch
runs — a syntax check passes, and the control silently disappears from the
composer. When such a reference error hits, the renderer abandons the slot
entry, so the control vanishes rather than showing an error.

## Diagnostics

Loopback-only JSON routes on the Web GUI server:

- `GET /plugins/model-router/status` — mode, candidates, policy, live
  per-session decisions, recent routing entries, and the last request errors.
- `GET /plugins/model-router/models` — resolved context window, reasoning
  efforts, and input modalities for every candidate.
- `POST /plugins/model-router/decide` with `{"content":"..."}` (or
  `GET .../decide?text=...`) — ask the configured decision model directly,
  without touching an agent. Useful for tuning question criteria. This
  diagnostic also requires `x-model-router-control: 1`.
- `POST /plugins/model-router/config` — apply a settings patch immediately;
  add `"save": true` to persist it to the profile. `GET` returns the effective
  configuration.
- `POST /plugins/model-router/session` — set a per-session override:
  `{"sessionId":"...","tier":"auto|off|fast|balanced|deep"}`.
- `GET /plugins/model-router/providers` — the provider routes this Host can
  reach and the models each one advertises, with their thinking levels. The
  control uses it to fill the tier-to-model dropdowns.

The two POST control routes require `x-model-router-control: 1`; the custom
header forces a CORS preflight for cross-origin callers, which this loopback
surface never answers, so a random website cannot toggle routing settings.

Set `statusRoute: off` to disable them, or `all` to allow non-loopback peers.

## Notes

- Switching route mid-session loses the target's prompt cache for that turn;
  this is why routing happens at turn boundaries rather than every step.
- The router stores no session data. Everything it needs is read from the
  current session's durable request header and derived messages.
- `effortByTier` and candidate `efforts` are advisory: a route that cannot
  honor an effort still works at the adapter's default effort.
