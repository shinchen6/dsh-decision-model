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

## Where each piece sits in the agent loop

This harness runs a turn like this, and the plugin already listens at four of
these points:

```
user message
  �agent/inbox/claimed          ← plugin: turn bookkeeping
system prompt assembled
  system-prompt/assemble        ← plugin: describes the routing state
each step of the turn
  agent/pre-step                ← plugin: asks the judge (today: difficulty only)
  agent/request                 ← plugin: swaps provider/model
model replies
  session/event
    'assistant/message'         ← plugin: already counts tokens here
  ├─ has tool calls → run tools → next step
  └─ no tool calls → turn ends
```

Against that, the three ideas land in three different places, at three
different costs.

### ② Asking a substantive question — free, same call, same place

**Where:** inside `agent/pre-step`, exactly where the judge is asked today.

There is no new round trip. The plugin already sends one request to the
decision model per turn. This changes *which question that request carries*,
when the turn looks like a review:

```
today:   { tier: <fast|balanced|deep>, effort: <low|medium|high> }
proposed:{ severity: <none|minor|major>, tier: ..., effort: ... }
```

**What the user sees:** nothing new. The turn simply gets a tier that accounts
for "there is a real defect in here, so the answer will need work".

**What it costs:** nothing. Same call, same 250 ms.

**What it needs:** the artifact under review must reach the judge. Today the
judge gets the user's words (6000 characters) plus a small digest of recent
activity — not the diff or the file. Extracting it is the actual work in this
option, and is why it is not first.

### ① A review tool — one extra tool call, entirely under the model's control

**Where:** the tool registry (`ctx.tools.register`). The tool becomes visible
to the model like `bash` or `read_file`.

**When it fires:** mid-turn, when the model decides to call it. The model writes
a `critique(text)` call, the tool runs one judge request, and the verdict comes
back as a normal tool result on the next step.

**What the user sees:** a tool call in the transcript, indistinguishable in
shape from any other.

**What it costs:** one judge call *per use*, and only when the model asks. An
agent that never calls it costs nothing.

This is the smallest change: no routing logic, no new failure path, no new
timing. It is also the one that produces the labelled data the other two need.

### ③ Verifying the answer — the interesting one, and not a re-run

**Where:** `session/event` → `assistant/message`, which the plugin already
listens to for token accounting. When a message arrives **with no tool calls**,
the turn is about to end, and that is the moment to ask the judge about it.

**How it acts — and this is the part worth being precise about.** Verifying
after the fact is useless if the only response is "too late". The harness has
`agent.inject(message)`, which queues model-facing context for the next step.
So instead of re-running the turn:

```
answer arrives with no tool calls
  → judge: { verdict: defect, kind: incomplete, margin: 0.72 }
  → inject a note: "A reviewer flagged this answer as incomplete: <kind>.
                   Address it, or state why it is already answered."
  → the turn continues for one more step, on the same or a stronger model
  → bounded by review.maxReviews (default 1)
```

**What the user sees:** the answer, then a short visible note that a review pass
ran, then the corrected answer. No duplicate work, no second copy of the turn.

**What it costs:** one judge call per completed turn, plus one extra model step
only when a defect is found.

**Why this is the design to aim at:** it closes the "no cascade" gap without
needing the harness to re-issue a turn, which is the blocker that made `retry`
look expensive. The escalation happens by continuing, which the loop already
supports.

**Three things to check before trusting it:** whether `inject` lands before the
turn is torn down on a single-step turn (it claims at the *next* step
boundary, so a turn with no further steps may never read it); whether a
self-injected review note can make a model loop; and whether the note itself
becomes part of the transcript in a way the user finds noisy.

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
