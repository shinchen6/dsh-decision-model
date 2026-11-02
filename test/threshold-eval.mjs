/**
 * Measure what a given downgrade threshold would actually do.
 *
 * `policy.downgradeConfidence` decides whether the judge may lower a tier. It
 * is compared against the gap between the judge's first and second choice, and
 * that gap is not on the scale most people assume: with three tiers a 0.75
 * threshold asks the winner to lead by three quarters of the probability mass,
 * which observed answers rarely do.
 *
 * Lowering the threshold is only safe if the turns it newly admits are ones the
 * cheaper tier can still handle. That is a measurable question, so this script
 * measures it instead of guessing: it sends a fixed set of tasks to the real
 * decision endpoint, and for each threshold reports how many turns would be
 * acted on and how many of those land below the tier the task actually needs.
 *
 * The labels are one engineer's judgement, not ground truth. They are the
 * reference for "would this answer still be usable", which is the thing a
 * quality floor is supposed to protect. Treat the numbers as a sanity check on
 * the threshold, not as an accuracy benchmark.
 *
 * Usage:
 *   node test/threshold-eval.mjs                      # against the local host
 *   node test/threshold-eval.mjs --base http://127.0.0.1:3080
 *   node test/threshold-eval.mjs --repeat 3            # average out judge noise
 */

const BASE = argOf('--base') ?? 'http://127.0.0.1:3080'
const REPEAT = Number(argOf('--repeat') ?? 1)
const TIER_RANK = { fast: 0, balanced: 1, deep: 2 }

function argOf(flag) {
  const index = process.argv.indexOf(flag)
  return index >= 0 ? process.argv[index + 1] : undefined
}

/**
 * `floor` is the cheapest tier that still produces a usable answer.
 * `ideal` is what a careful engineer would pick when cost is not the only axis.
 * A decision below `floor` is the harm we are trying to avoid.
 */
const TASKS = [
  // Routine, no investigation needed.
  { text: 'fix a typo in the README', ideal: 'fast', floor: 'fast' },
  { text: 'rename the variable foo to bar in utils.js', ideal: 'fast', floor: 'fast' },
  { text: 'what does the --verbose flag do?', ideal: 'fast', floor: 'fast' },
  { text: '列出 src 目录下的所有文件', ideal: 'fast', floor: 'fast' },
  { text: 'format this JSON so it is readable', ideal: 'fast', floor: 'fast' },
  { text: 'what is the current git branch?', ideal: 'fast', floor: 'fast' },
  { text: 'translate this code comment to English', ideal: 'fast', floor: 'fast' },
  { text: 'show me the last five commits', ideal: 'fast', floor: 'fast' },
  { text: '把这段 CSS 的缩进改成两个空格', ideal: 'fast', floor: 'fast' },
  { text: 'which node version does this project use?', ideal: 'fast', floor: 'fast' },
  { text: 'add a console.log to print the value of x', ideal: 'fast', floor: 'fast' },
  { text: 'update the copyright year in LICENSE', ideal: 'fast', floor: 'fast' },

  // Ordinary engineering: one module, a known shape.
  { text: 'add a unit test for the parseDate function', ideal: 'balanced', floor: 'balanced' },
  { text: 'fix the bug where the list does not refresh after a delete', ideal: 'balanced', floor: 'balanced' },
  { text: 'write a function that validates email addresses', ideal: 'balanced', floor: 'balanced' },
  { text: 'show an error on the login form when the password is wrong', ideal: 'balanced', floor: 'balanced' },
  { text: 'refactor getUser to use async/await', ideal: 'balanced', floor: 'balanced' },
  { text: 'add pagination to the orders endpoint', ideal: 'balanced', floor: 'balanced' },
  { text: '为什么我的 useEffect 每次渲染都会执行？', ideal: 'balanced', floor: 'balanced' },
  { text: 'make the sidebar collapsible', ideal: 'balanced', floor: 'balanced' },
  { text: 'add a loading spinner while the data fetches', ideal: 'balanced', floor: 'balanced' },
  { text: 'include the user avatar URL in the API response', ideal: 'balanced', floor: 'balanced' },
  { text: 'write a migration that adds an index on orders.created_at', ideal: 'balanced', floor: 'balanced' },
  { text: "the build fails with 'cannot find module ./config'", ideal: 'balanced', floor: 'balanced' },
  { text: 'implement retry with exponential backoff in the http client', ideal: 'balanced', floor: 'balanced' },
  { text: 'add role-based access control to the admin routes', ideal: 'balanced', floor: 'balanced' },
  { text: 'make the date picker respect the user timezone', ideal: 'balanced', floor: 'balanced' },
  { text: 'split the settings page into smaller components', ideal: 'balanced', floor: 'balanced' },

  // Needs investigation or judgement, but a strong middle tier can carry it.
  { text: 'design a rate limiter for our public API', ideal: 'deep', floor: 'balanced' },
  { text: 'why does our service leak memory under sustained load?', ideal: 'deep', floor: 'balanced' },
  { text: 'review this pull request for correctness', ideal: 'deep', floor: 'balanced' },
  { text: 'the tests pass locally but fail in CI, find out why', ideal: 'deep', floor: 'balanced' },
  { text: 'migrate our authentication from sessions to JWT', ideal: 'deep', floor: 'balanced' },
  { text: 'our p99 latency doubled last week, investigate', ideal: 'deep', floor: 'balanced' },
  { text: 'refactor the monorepo build so it is incremental', ideal: 'deep', floor: 'balanced' },
  { text: '评估一下这个接口设计是否合理', ideal: 'deep', floor: 'balanced' },
  { text: 'review my error handling strategy across the service', ideal: 'deep', floor: 'balanced' },
  { text: 'is this test actually testing what it claims?', ideal: 'deep', floor: 'balanced' },
  { text: 'check this SQL query for performance problems', ideal: 'deep', floor: 'balanced' },
  { text: 'review this function for unhandled edge cases', ideal: 'deep', floor: 'balanced' },

  // No middle tier can be trusted with these.
  { text: 'design a distributed job scheduler with exactly-once semantics', ideal: 'deep', floor: 'deep' },
  { text: 'audit this code for SQL injection vulnerabilities', ideal: 'deep', floor: 'deep' },
  { text: 'plan a migration of 200TB of data with zero downtime', ideal: 'deep', floor: 'deep' },
  { text: 'analyze the concurrency bug in this lock-free queue', ideal: 'deep', floor: 'deep' },
  { text: 'review our architecture for the coming 10x traffic growth', ideal: 'deep', floor: 'deep' },
  { text: '评估一下这个分布式锁的实现是否存在竞态条件', ideal: 'deep', floor: 'deep' },
  { text: '设计一个支持多租户的权限系统', ideal: 'deep', floor: 'deep' },
  { text: 'is this cryptographic comparison constant time, and does it matter here?', ideal: 'deep', floor: 'deep' },
]

async function decide(content) {
  const response = await fetch(`${BASE}/plugins/model-router/decide`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-model-router-control': '1' },
    body: JSON.stringify({ content }),
  })
  if (!response.ok) throw new Error(`decide failed: HTTP ${response.status}`)
  const data = await response.json()
  const decision = data?.decision
  if (!decision?.tier) return null
  return {
    tier: decision.tier,
    margin: typeof decision.confidenceMargin === 'number'
      ? decision.confidenceMargin
      : (typeof decision.confidence === 'number' ? decision.confidence : null),
    probabilities: decision.probabilities ?? null,
  }
}

function percentile(values, q) {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]
}

async function main() {
  const rows = []
  let failed = 0
  for (const [index, task] of TASKS.entries()) {
    const samples = []
    for (let attempt = 0; attempt < REPEAT; attempt += 1) {
      try {
        const answer = await decide(task.text)
        if (answer) samples.push(answer)
      } catch (error) {
        // A judge that is down is not a data point; skip it and report how many.
      }
    }
    if (samples.length === 0) {
      failed += 1
      continue
    }
    // Use the median margin so one noisy call cannot decide the verdict.
    const margin = percentile(samples.map((sample) => sample.margin ?? 0), 0.5)
    const tier = samples[0].tier
    rows.push({ ...task, tier, margin })
    process.stdout.write(`\r  judged ${index + 1}/${TASKS.length}`)
  }
  process.stdout.write('\r' + ' '.repeat(30) + '\r')

  if (rows.length === 0) {
    console.error('No judgements came back. Is the decision model reachable?')
    process.exit(1)
  }

  const margins = rows.map((row) => row.margin)
  console.log(`judged ${rows.length} tasks${failed ? `, ${failed} skipped (no answer)` : ''}`)
  console.log(`observed margin: min ${percentile(margins, 0).toFixed(2)}  p25 ${percentile(margins, 0.25).toFixed(2)}  p50 ${percentile(margins, 0.5).toFixed(2)}  p75 ${percentile(margins, 0.75).toFixed(2)}  p90 ${percentile(margins, 0.9).toFixed(2)}  max ${percentile(margins, 0.99).toFixed(2)}`)
  console.log()

  // What the judge actually chose, against what the task needs.
  const belowFloor = rows.filter((row) => TIER_RANK[row.tier] < TIER_RANK[row.floor])
  const belowIdeal = rows.filter((row) => TIER_RANK[row.tier] < TIER_RANK[row.ideal])
  const aboveIdeal = rows.filter((row) => TIER_RANK[row.tier] > TIER_RANK[row.ideal])
  console.log(`judge chose below the usable floor for ${belowFloor.length}/${rows.length} tasks`)
  console.log(`judge chose below the ideal tier for ${belowIdeal.length}/${rows.length} tasks`)
  console.log(`judge overspent (above ideal) on ${aboveIdeal.length}/${rows.length} tasks`)
  if (belowFloor.length > 0) {
    console.log('  below floor:')
    for (const row of belowFloor) {
      console.log(`    margin ${row.margin.toFixed(2)}  chose ${row.tier}, needs ${row.floor}  — ${row.text}`)
    }
  }
  console.log()

  // The sweep: a threshold decides which of the judge's answers get acted on.
  const header = 'threshold   acted on   below floor   harm rate   cheaper than ideal'
  console.log(header)
  console.log('-'.repeat(header.length))
  const sweep = []
  for (const threshold of [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.75, 0.8, 0.9]) {
    const acted = rows.filter((row) => row.margin >= threshold)
    const harm = acted.filter((row) => TIER_RANK[row.tier] < TIER_RANK[row.floor])
    const cheaper = acted.filter((row) => TIER_RANK[row.tier] < TIER_RANK[row.ideal])
    const harmRate = acted.length === 0 ? 0 : harm.length / acted.length
    sweep.push({ threshold, acted: acted.length, harm: harm.length, harmRate, cheaper: cheaper.length })
    console.log(
      `${threshold.toFixed(2).padStart(9)}`
      + `${String(acted.length).padStart(11)}`
      + `${String(harm.length).padStart(14)}`
      + `${`${(harmRate * 100).toFixed(0)}%`.padStart(12)}`
      + `${String(cheaper.length).padStart(22)}`,
    )
  }
  console.log()

  // A threshold is only worth lowering while it admits turns without admitting
  // harm. Report the highest threshold that still acts on a useful share.
  const safe = sweep.filter((row) => row.harm === 0 && row.acted >= rows.length * 0.5)
  const best = safe.length > 0 ? safe[safe.length - 1]
    : sweep.filter((row) => row.harmRate <= 0.05).pop()
  if (best) {
    console.log(`No harm observed at threshold ${best.threshold.toFixed(2)}: acts on ${best.acted}/${rows.length}, ${best.cheaper} land on a cheaper tier than ideal.`)
  } else {
    console.log('Every threshold with meaningful coverage also admits a harmful downgrade. Keep the gate strict.')
  }
  console.log()
  console.log('Labels are one engineer\'s judgement, not ground truth. Re-run after changing')
  console.log('the decision model, its criteria, or the candidate models.')
}

await main()
