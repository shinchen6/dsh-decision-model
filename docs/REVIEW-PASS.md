# Design: use the decision model as a reviewer

Status: **design only, nothing here is implemented.** Written after the routing
research summarised in [DESIGN.md](DESIGN.md#why-the-local-rule-is-shaped-the-way-it-is).

## The opportunity

The decision model is a judge. It reads a task and answers structured questions
in roughly 250 ms for a few hundred tokens. Today the plugin asks it one
question — "how hard is this?" — and throws the answer away as soon as a tier is
picked.

Evaluation work is exactly what a judge is good at. And the plugin currently
handles evaluation requests badly: in the threshold evaluation
([`test/threshold-eval.mjs`](../test/threshold-eval.mjs)) the four tasks the
judge got wrong were all review or assessment work —

```
margin 0.09  chose fast, needs balanced  — include the user avatar URL in the API response
margin 0.11  chose fast, needs balanced  — write a migration that adds an index on orders.created_at
margin 0.11  chose fast, needs balanced  — the build fails with 'cannot find module ./config'
margin 0.10  chose fast, needs balanced  — 评估一下这个接口设计是否合理
```

Every one looked small from the outside and needed work across files. That is
the failure mode nobody's difficulty classifier fixes, because difficulty is not
visible in the wording.

There is also a gap worth naming: **no documented commercial router verifies the
answer it produced.** Research into OpenRouter, AWS Bedrock, Azure Foundry,
Cloudflare, LiteLLM, RouteLLM, Not Diamond, Martian and NeMo Switchyard found
routers that predict difficulty, forecast success, index by market share, and
cascade on tool results — and none that check the finished answer. LiteLLM's
shadow evaluation judges answers, but offline, on sampled traffic, as a
measurement rather than a runtime control.

## What makes this hard

A verifier is only worth having if it is usually right, and a bad one is worse
than none.

RouterBench (Hu et al., arXiv:2403.12031) simulates exactly this design and
reports the boundary: a cascade "quickly approximates the performance of the
Oracle" at zero verifier error, stays useful while the error rate is up to
0.10, and then "may deteriorate rapidly, particularly when the error rate
exceeds 0.20". A verifier that is wrong one time in five actively makes the
product worse.

So the design is organised around one requirement: **measure the verifier's
error rate on real turns before letting it change anything.**

The second constraint comes from NVIDIA's Switchyard, the only production
cascade found: it requires two consecutive verdicts citing *fresh* evidence for
the *same* failure category before escalating, bounds escalation with a hard cap
and a cool-down, and never treats a failed forecast as evidence the task was
easy. Those rules exist because a single noisy signal wastes money and makes the
route oscillate.

## Three things this could be, cheapest first

### 1. A reviewer tool the agent can call (recommended first)

A tool, not a routing change. The agent decides when it wants a second opinion.

```
critique(text, question?) -> {
  verdict: "ok" | "defect",
  kind?: "missing_requirement" | "wrong_fact" | "incomplete" | "contradiction" | "unsound",
  confidence: number,
  notes: string,          // one or two sentences, clipped
}
```

- **Cost:** one judge call, ~250 ms, on demand. No behaviour change when unused.
- **Risk:** low. It cannot damage a turn, because an agent that ignores it loses
  nothing.
- **Why it fits the request:** "review this", "评估一下", "is this correct" are
  the tasks where a fast second reader is most useful, and the agent knows when
  it is doing one.
- **Open question:** whether a small judge reads enough context to be useful on
  a large diff. The judge currently sees a 6000-character task clip and a tiny
  activity digest; a tool call would need explicit text from the agent.

This is the smallest thing that uses the judge's strength, and it produces the
labelled data the later phases need.

### 2. Substantive pre-routing for evaluation turns

When the turn *is* a review, ask a substantive question instead of a difficulty
question:

```
questions: {
  severity: { type: "choice", criteria: {
    none:  "The artifact has no problem that needs a code change.",
    minor: "Problems exist but are cosmetic or local.",
    major: "The artifact has a problem that requires a change across more than one place.",
  }},
  tier: { ...the usual tier question... }
}
```

- `major` → the turn will need careful fixing after the review, so route `deep`
  regardless of how easy the question reads.
- `none` → the review can run on a cheaper tier.

**This needs something the plugin does not have: the artifact.** The engine sends
a compressed digest, not the diff or file under review. So this phase requires an
*artifact selection* step — pick what to include, bounded at some character
budget, from what the turn actually references. That is the real work, and it is
why this is phase two rather than phase one.

### 3. Verify the finished answer, and escalate

The cascade the plugin does not have:

```
after the assistant message:
  ask -> { verdict: ok|defect, kind, confidence }
  if defect and margin >= review.verify.minMargin:
    count it; a second consecutive defect of the same kind acts
```

What "act" can mean, in increasing ambition:

| Action | Behaviour | Cost | Risk |
|---|---|---|---|
| `report` | record it, and tell the panel; no route change | 1 judge call | lowest |
| `escalate-rest` | raise the tier for the remaining steps of this turn | 1 judge call | low |
| `retry` | re-answer the turn on a stronger model | 2x the turn | highest, needs harness support |

`escalate-rest` is the honest default for a multi-step turn: it fixes the rest of
the work without pretending the finished answer can be un-said. `retry` needs the
Harness to re-issue a turn, which this plugin has not verified it can do; until
that is established, `retry` is out of scope.

Note what verification cannot do: on a single-step turn it arrives after the
work is done, so its value is concentrated in agentic turns with many steps —
which is exactly where a cascade pays off.

## Configuration

```yaml
review:
  enabled: false            # master switch
  # 1. reviewer tool
  tool: false               # expose critique() to the agent
  # 2. substantive pre-routing
  route: false              # ask the severity question on evaluation turns
  artifactChars: 4000       # budget for the artifact included in the question
  # 3. answer verification
  verify: 'off'             # off | observe | enforce
  onDefect: 'report'        # report | escalate-rest - (retry is out of scope)
  minMargin: 0.5            # higher than the routing gate: see below
  confirmations: 2          # consecutive defect verdicts of the same kind
  maxPerTurn: 1             # hard budget, so a stuck loop cannot burn calls
  timeoutMs: 900            # same budget as the routing call
  answerChars: 4000         # how much of the answer the verifier reads
```

`minMargin` for verification is deliberately higher than
`policy.downgradeConfidence`. Missing a defect costs one bad answer; a false
positive escalates work that was fine, spends a call, and teaches the user to
ignore the signal. The asymmetry favours caution. It is still a starting value:
the whole point of phase one is to replace it with a measured one.

## Records and diagnostics

Each record gains, when review is on:

```
review: {
  mode: 'route' | 'verify' | 'tool',
  verdict: 'ok' | 'defect',
  kind: string | null,
  margin: number | null,
  latencyMs: number | null,
  acted: boolean,          // did it change anything
  action: 'report' | 'escalate-rest' | null,
  streak: number,          // how many consecutive corroborating verdicts
}
```

The panel's records tab shows it as its own line, next to the judge verdict, so
"what did the reviewer say and what did we do about it" is readable without
looking at raw JSON.

Aggregate counters in `/status`:

```
review: {
  calls, verdicts: { ok, defect },
  byKind: { missing_requirement, wrong_fact, ... },
  acted, falsePositiveReports   // user-marked, see below
}
```

## Rollout, with gates

**Phase 0 — measure the verifier before trusting it.**

Ship the reviewer tool with `review.tool: true` and `review.verify: 'off'`. Build
a labelled set the same shape as `test/threshold-eval.mjs`: turns with a known
good answer and a knowingly defective one, and report the verifier's error rate.
Gate: **verifier error below 0.10** before phase 2, and abandon or rework above
0.20, per RouterBench's boundary. A verifier that cannot clear this is not worth
shipping, and finding that out is a success, not a failure.

**Phase 1 — the tool.** Let it be used, keep it observable. It carries its own
value and produces the data for the next gate.

**Phase 2 — observe-only verification.** `verify: 'observe'` records verdicts
without acting. Compare against what actually happened: did the user re-ask the
same thing, did a later step hit a tool error, did the turn get abandoned. That
gives a weak label at zero risk, and a second estimate of the error rate on real
traffic rather than the synthetic set.

**Phase 3 — enforce `report`.** Still no route change, but the panel says what
the reviewer saw. Cheap, honest, reversible.

**Phase 4 — enforce `escalate-rest`**, only if phases 0–3 agree the verifier is
right. This is the only phase that spends money on the strength of a verdict.

Each phase has a kill criterion: if the measured defect rate on healthy turns
(a false-positive proxy) exceeds roughly 10%, stop and treat the verifier as
unreliable rather than tuning around it.

## What we would need to answer before phase 1

1. **Does the judge read the answer well enough?** It answered routing questions
   from a task digest. A 4000-character answer plus the task is a different
   shape of input, and its accuracy on it is unmeasured.
2. **Is `kind` worth classifying?** It exists so corroboration can require the
   *same* kind twice (Switchyard's rule). If kinds are noisy, requiring
   same-kind agreement is stricter than intended and may suppress real defects.
3. **What does the agent do with a tool verdict?** A reviewer that says
   "defect: incomplete" in one sentence is only useful if the agent can act on
   it. That needs a trial, and possibly a follow-up question format.
4. **Latency budget.** 250 ms is fine on demand; it is not fine twice per turn on
   every turn. Phase 2 must not add a second call per turn for turns that do not
   need one.

## Non-goals

- **Letting the judge write the answer.** It is a classifier, and its answers
  would be short and shallow. The plugin routes work; it does not replace it.
- **Replacing the difficulty judgement.** Review is additive. A verifier cannot
  tell you what a turn will cost before it starts.
- **Scoring style.** "Is this well written" is subjective, and a small judge is
  easily swayed by length and formatting. Only defects that can be pointed at
  are in scope.
- **Measuring quality to report a number.** The verdict is a routing input, not a
  benchmark. Any "quality score" shown to a user from this would be over-claiming
  what the evidence supports.

## Why not just lower the routing threshold instead

Because the two solve different problems. The threshold decides whether to act on
a judgement that is already made; a reviewer makes a *new* judgement about
something the router never sees. The evaluation above shows the threshold is
already near its useful limit: harm disappears by 0.20 and nothing improves past
it, so tuning further gains nothing. The remaining error is not uncertainty, it
is the question being wrong — and that needs a different question, which is what
this design adds.
