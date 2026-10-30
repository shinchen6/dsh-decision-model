# dsh-decision-model

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) bundle that
picks the **model** and the **reasoning effort** for every turn and every
subagent, instead of using one model for everything.

A configurable **decision model** reads each turn and answers two questions:
how hard is this task (`fast` / `balanced` / `deep`), and how much thinking does
it need (`low` / `medium` / `high`). The bundle applies that answer to the live
request, so a typo goes to a cheap fast model while an architecture question
goes to a strong deep one.

## What you get

- **A control in the composer.** A chip next to the input box shows the model
  and effort in use, and opens the panel.
- **Three tiers.** Map each tier to any model your Harness can reach — a fast
  one, a balanced one, and a strong one.
- **A decision model of your own.** Point the bundle at your own judge service.
  Several can be configured, and you switch between them.
- **A record of every choice.** Which model ran, how long the judge took, how
  many tokens it used, and the judge's own answer.
- **Today's token totals per model**, so you can see what the routing saved.

The judge is asked **once per turn**. The rest of the turn keeps that answer, so
a turn with many tool calls does not ask again.

## Install

Clone the repository, then add the directory to your profile as a bundle:

```bash
git clone https://github.com/shinchen6/dsh-decision-model.git
```

From the Harness, use the plugin manager to install the bundle from that
directory (`install-bundle`, with the clone path as the target). The bundle is
registered in the profile and enabled straight away.

The bundle starts switched off, so nothing changes until you turn it on.

## Set up

1. Open the panel: click the **模型路由 / Model Router** chip next to the input
   box.
2. Choose a working mode: **off**, **observe** (record the choices without
   applying them), or **auto**.
3. Map each tier to a model under **设置 / Settings**.
4. Click **配置 / Configure** beside the panel title to add a decision model.
   **快速配置 / Quick setups** adds a ready-made `jev` profile — fill in the
   address of your own decision service, then edit it to match your setup.

A decision service answers a tier and an effort. The bundle talks to it in the
`systemone` shape, or the plain OpenAI chat-completions shape:

```json
{
  "answers": {
    "tier":   { "choice": "balanced", "confidence": 0.86, "probabilities": { "fast": 0.01, "balanced": 0.91, "deep": 0.08 } },
    "effort": { "choice": "high",     "confidence": 0.62 }
  }
}
```

Any service that answers in that shape works — the bundle does not require a
particular one.

## Documentation

[docs/DESIGN.md](docs/DESIGN.md) covers the configuration in detail: the tiers,
how much to trust the judge, the safety rails, the records, and the tests.

## License

Apache License 2.0 — see [LICENSE](LICENSE).
