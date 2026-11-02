# Tool selection: what the evidence says

Status: **research note, no code.** Written to answer "should the decision model
also pick tools?" The answer is no, not in the shape that sounds obvious, and
the reason is worth recording before anyone builds it.

## The tempting idea, and why it does not hold up

The decision model already classifies a turn in ~250 ms. Tools cost context: 50
tool definitions are 10–20K tokens, and Anthropic has seen definitions consume
134K tokens. So "ask the judge which tools this turn needs, then show only
those" looks free.

Three findings argue against it.

**1. Nobody senior ships it that way.** Anthropic and OpenAI both put tool
selection *inside the main model's forward pass*: definitions are sent but
marked deferred, and the model emits a search call when it wants one (Anthropic
`tool_search_tool_*` + `defer_loading`; OpenAI `ToolSearchTool` +
`tool_namespace`). Neither ships an out-of-band fast model that decides the tool
set before the main model sees the turn. When two vendors independently choose
in-band discovery over pre-computed selection, that is a signal.

**2. The closest measured success needed a trained classifier, and the naive
version made things worse.** TinyAgent (EMNLP 2024 demo, arXiv:2409.00608)
fine-tunes DeBERTa-v3-small as a 16-way multi-label classifier over 16 tools and
gets tool recall 0.998, prompt tokens 2762 → 1397, success 78.89 → 80.06. In the
same paper, plain embedding-similarity retrieval *hurt*: 78.89 → 74.88. The
reason matters — a task often needs an auxiliary tool that is not semantically
similar to the request. Our judge has no training data for our tool set, so it
would be the weak version.

**3. The risk is asymmetric in the wrong direction.** A bad tier choice costs
money and tokens; the turn still completes. A bad tool-set choice can make the
task unsolvable, and the main model cannot recover, because it cannot see the
tool it needed. Every documented fallback in the literature is "when unsure,
show everything" — hiding capability is the one failure the model cannot repair.
That inverts this plugin's routing stance: there, holding the route is safe;
here, holding back tools is not.

## What the numbers actually are

| Finding | Number | Source |
|---|---|---|
| Accuracy degrades past 30–50 tools | stated | Claude Code Agent SDK docs |
| A 8B model succeeds at 19 tools, fails at 46 | controlled | "Less is More", DATE 2025, arXiv:2411.15399 |
| 58 tools ≈ 55K tokens | 5 MCP servers | Anthropic, advanced tool use |
| Curating 47 tools to 14 at equal pass rate | 4.98x fewer input tokens | practitioner A/B, 40 prompts |
| Tool Search on internal evals | 49%→74% (Opus 4), 79.5%→88.1% (Opus 4.5) | Anthropic, methodology unpublished |

The one row that matters most for a small install: Claude Code's own guidance is
that tool search is **not** worth it below ~10 tools or with compact
definitions. Most Harness profiles are in that range.

## If it is built anyway, the shape to copy

Claude Code ships exactly the policy that avoids the trap, and it is worth
copying rather than inventing:

1. **Off by default**, and off automatically when the tool set is small.
2. **Gate on measurement, not on every turn**: `ENABLE_TOOL_SEARCH=auto[:N]`
   loads everything upfront until deferrable definitions exceed N% of context,
   then switches to search. That is a measurement, not a judgement.
3. **Always keep the core tools loaded.** Claude Code exempts Bash/Read/Edit;
   Anthropic advises keeping the 3–5 most-used tools always present.
4. **Expose search as a tool the main model can call**, so it can retry, rather
   than pre-filtering what it is allowed to see.
5. **On any failure — low confidence, no match, timeout — fall back to the full
   set.** Never to a smaller one.

The mechanics exist in this Harness: `ctx.tools.register(defineTool(...))` adds a
tool, and `ctx.tools.restrict({ allow, deny })` narrows the visible set per agent
scope. So a search tool is buildable; the open question is whether it is worth it
at the tool counts this plugin actually sees.

## The measurement to run first

Mirror the tier work: [`test/threshold-eval.mjs`](../test/threshold-eval.mjs)
already sends a labelled task set through the real decision endpoint and reports
a harm table. The same design applies here, with "usable floor" meaning *the task
is solvable with the exposed tool set*:

- Log, per turn, what share of the context the tool definitions occupy.
- A/B: always show everything, versus gate at `auto:N`.
- Report: end-to-end task success, input tokens, and how often the exposed set
  was missing a tool the task needed.

Until that shows a real problem, showing all tools is the evidence-backed
default, and the expensive part of tool use is not selection at all — it is
getting the arguments right.

## Honest gaps

- No published A/B of a general fast judge versus simply showing every tool.
  Nobody has measured the thing we were considering.
- Vendor percentages come from internal, unpublished evals.
- No widely used benchmark scores *multi-step* tool exposure quality; BFCL-style
  accuracy is a different construct.
- Tool descriptions are steerable: edited descriptions got >10x more usage
  (arXiv:2505.18135), so any selector inherits a supply-chain risk from whoever
  writes the descriptions.
