/**
 * Client half of the Model Router bundle: a compact control in the composer
 * tool row plus a settings panel.
 *
 * The panel talks to the Host half over same-origin JSON routes. Those routes
 * are loopback-only by default; the control degrades to "unavailable" when the
 * page is opened from another host.
 *
 * The panel is organised around the working mode first, because the mode
 * decides which settings matter: with routing off there is nothing to
 * configure, with "watch only" you configure how the difficulty is judged, and
 * with "auto" you additionally configure the per-session override.
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-model-router-web',
  factory(require) {
    const React = require('react')
    const { createPortal } = require('react-dom')
    const h = React.createElement

    const TIERS = ['fast', 'balanced', 'deep']

    const EN = {
      title: 'Model Router',
      chip: 'Model Router',
      subtitle: 'Picks a cheaper model for easy turns and a stronger one for hard turns.',
      tabSettings: 'Settings',
      tabHistory: 'Records',
      unknown: 'unknown',
      effort: 'thinking',
      why: 'why',
      mode: 'Working mode',
      modeOff: 'Off',
      modeObserve: 'Watch only',
      modeAuto: 'Auto',
      modeOffHint: 'Off: nothing is judged and no model is switched. Pick "watch only" or "auto" to start.',
      modeObserveHint: 'Watch only: every turn is judged and written to the records, but no request is changed. Use it to check how well the judgement matches your intent.',
      modeAutoHint: 'Auto: the judgement is applied for real — the model and its thinking level change per turn.',
      modeNeeds: 'This mode needs',
      needsObserve: 'the models each tier points at, and how difficulty is judged.',
      needsAuto: 'the same settings as "watch only"; auto also applies them.',
      needsOff: 'nothing yet.',
      tierMap: 'Models per tier',
      tierMapHint: 'Choose which model each difficulty level uses.',
      provider: 'provider',
      model: 'model',
      selectModel: 'pick a model',
      decision: 'Decision model',
      decisionHint: 'The judge that decides how hard each turn is. Several can be configured; one is used at a time.',
      dmUse: 'Use this decision model',
      dmInUse: 'This decision model is in use',
      dmEdit: 'Edit',
      dmRemove: 'Remove',
      dmAdd: 'Add a decision model',
      dmAddBuiltin: 'Add',
      dmSwitchTo: 'Use',
      dmInUseLabel: 'In use:',
      dmNowUsing: 'now in use:',
      dmAdded: 'added:',
      dmRemoved: 'removed:',
      dmNoEndpoint: 'no address yet',
      dmBuiltins: 'Quick setups',
      dmName: 'name',
      dmNamePlaceholder: 'for example jev',
      decisionActiveHint: 'The decision model in use right now.',
      endpoint: 'Endpoint',
      decisionModel: 'Model',
      protocol: 'Protocol',
      timeout: 'Timeout (ms)',
      tierQuestion: 'Tier question',
      effortQuestion: 'Effort question',
      criteria: 'What counts as each tier',
      criteriaHint: 'The text the judge reads to pick a tier.',
      criteriaDefaultHint: 'Every decision model uses the standard criteria below.',
      criteriaCustomise: 'Customise',
      criteriaReset: 'Use the standard',
      criteriaBuiltin: 'The standard criteria apply.',
      criteriaInvalid: 'That is not valid JSON.',
      scope: 'Applies to',
      main: 'Main chat',
      subagents: 'Subagents',
      trust: 'How much to trust the judge',
      trustMax: 'Quality first',
      trustSafe: 'Allow it to downgrade',
      trustDecision: 'Follow it exactly',
      trustMaxHint: 'It may only pick a stronger model, never a cheaper one.',
      judgeSaid: 'the judge itself said',
      ruleSaw: 'the local rule saw',
      observedMargin: 'observed separation p50/p90',
      passingThreshold: 'above the threshold',
      thresholdIs: 'threshold',
      trustSafeHint: 'It may pick a cheaper model when it is confident.',
      trustDecisionHint: 'Its answer is used as-is.',
      configure: 'Configure',
      done: 'Done',
      persistFailed: 'The change applies to this run but could not be written to the profile.',
      close: 'Close',
      unavailable: 'Router status unavailable',
      historyHint: 'Every routing decision, with the reason behind it. Tap a row for the full judgement.',
      historyDetail: 'Show the full judgement',
      verdictTrail: 'The verdict for this turn',
      judgeTime: 'judge took',
      tokensUsed: 'tokens used',
      tokens: 'tokens',
      input: 'in',
      output: 'out',
      usageToday: "Today's tokens",
      usageEmpty: 'No token usage recorded yet.',
      keptRoute: 'the route chosen for this turn was kept',
      longTurnReason: 'the cheap model stayed in use for many steps',
      judgeChose: 'the decision model chose',
      ruleChose: 'a local rule chose',
      escalatedReason: 'a recent request had failed, so a stronger model was used',
      toolErrorReason: 'a tool call had failed, so a stronger model was used',
      overrideReason: 'you pinned this tier for the session',
      sessionOffReason: 'routing was switched off for the session',
      externalReason: 'the model was changed outside the router',
      fromJudge: 'decision model',
      notConsulted: 'not consulted',
      rawVerdict: 'Raw judgement payload',
      noRaw: 'This decision did not consult the decision model.',
      confidence: 'confidence',
      turnStep: 'turn / step',
      agentId: 'agent',
      time: 'time',
      effortAuto: 'automatic',
      noVision: 'no images',
      effortOff: 'off',
      effortMinimal: 'minimal',
      effortLow: 'low',
      effortMedium: 'medium',
      effortHigh: 'high',
      effortXhigh: 'very high',
      effortMax: 'max',
      historyEmpty: 'Nothing recorded yet. Switch to "watch only" or "auto" and send a message.',
      historySub: 'subagent',
      historyMain: 'main',
      tierFastShort: 'Cheapest',
      tierBalancedShort: 'Middle',
      tierDeepShort: 'Strongest',
      srcFallback: 'local fallback',
      srcDecision: 'decision model',
      srcBoth: 'decision model',
      srcOverride: 'you chose it',
      srcSessionOff: 'kept the current model',
      srcEscalation: 'held after a failure',
      srcContinuation: 'same route as the previous step',
      srcToolError: 'a tool failed',
      srcLongTurn: 'the turn ran long',
    }

    const ZH = {
      title: '模型路由',
      chip: '模型路由',
      subtitle: '简单的问题用更便宜的模型，难的问题用更强的模型。',
      tabSettings: '设置',
      tabHistory: '记录',
      unknown: '未知',
      effort: '思考强度',
      why: '原因',
      mode: '工作方式',
      modeOff: '关闭',
      modeObserve: '只观察',
      modeAuto: '自动',
      modeOffHint: '关闭：什么都不判断，也不会切换模型。想开始请选"只观察"或"自动"。',
      modeObserveHint: '只观察：每一轮都会判断难度并写进"记录"，但不会真的改动请求。适合先看看判断准不准。',
      modeAutoHint: '自动：判断结果会真的生效——模型和思考强度会按每轮任务切换。',
      modeNeeds: '这个方式需要配置',
      needsObserve: '各档位对应哪个模型，以及难度怎么判断。',
      needsAuto: '和"只观察"一样；区别是这些判断会真的生效。',
      needsOff: '暂时不需要配置任何东西。',
      tierMap: '各档位用哪个模型',
      tierMapHint: '自己决定每个难度档位用哪个模型。',
      provider: '供应商',
      model: '模型',
      selectModel: '请选择模型',
      decision: '决策模型',
      decisionHint: '负责判断每轮任务难不难。可以配置多个，一次只用一个。',
      dmUse: '使用这个决策模型',
      dmInUse: '正在使用这个决策模型',
      dmEdit: '编辑',
      dmRemove: '删除',
      dmAdd: '添加决策模型',
      dmAddBuiltin: '添加',
      dmSwitchTo: '使用',
      dmInUseLabel: '正在使用：',
      dmNowUsing: '正在使用：',
      dmAdded: '已添加：',
      dmRemoved: '已删除：',
      dmNoEndpoint: '尚未填写地址',
      dmBuiltins: '快速配置',
      dmName: '名称',
      dmNamePlaceholder: '例如 jev',
      decisionActiveHint: '当前使用的决策模型。',
      endpoint: '接口地址',
      decisionModel: '模型',
      protocol: '协议',
      timeout: '超时（毫秒）',
      tierQuestion: '档位问题名',
      effortQuestion: '思考问题名',
      criteria: '各档位的判定标准',
      criteriaHint: '决策模型据此判断难度。',
      criteriaDefaultHint: '所有决策模型默认使用下面的统一标准。',
      criteriaCustomise: '自定义',
      criteriaReset: '用统一标准',
      criteriaBuiltin: '使用统一判定标准。',
      criteriaInvalid: '这不是合法的 JSON。',
      scope: '作用范围',
      main: '主对话',
      subagents: '子智能体',
      trust: '对决策模型的信任程度',
      trustMax: '质量优先',
      trustSafe: '允许降档',
      trustDecision: '完全照办',
      trustMaxHint: '只允许换更强的模型，不允许换更便宜的。',
      judgeSaid: '模型自报',
      ruleSaw: '本地规则命中',
      observedMargin: '实测区分度 p50/p90',
      passingThreshold: '超过阈值',
      thresholdIs: '阈值',
      trustSafeHint: '它有把握时，可以换更便宜的模型。',
      trustDecisionHint: '完全按它的结果执行。',
      configure: '配置',
      done: '完成',
      persistFailed: '改动已在本轮生效，但没能写进配置文件。',
      close: '关闭',
      unavailable: '读不到路由器状态',
      historyHint: '每一条路由决定，以及它背后的依据。点一行看完整判定。',
      historyDetail: '展开完整判定',
      verdictTrail: '本轮的判定结果',
      judgeTime: '判定耗时',
      tokensUsed: '本次消耗',
      tokens: 'token',
      input: '输入',
      output: '输出',
      usageToday: '今日 token 消耗',
      usageEmpty: '还没有 token 记录。',
      keptRoute: '沿用本轮已选的路由',
      longTurnReason: '便宜模型已经连续用了很多步',
      judgeChose: '决策模型判定为',
      ruleChose: '本地规则判定为',
      escalatedReason: '刚才的请求失败了，改用更强的模型',
      toolErrorReason: '工具调用失败了，改用更强的模型',
      overrideReason: '你为这个会话指定了档位',
      sessionOffReason: '这个会话已关闭路由',
      externalReason: '模型是在路由之外被改动的',
      fromJudge: '决策模型',
      notConsulted: '未参与',
      rawVerdict: '原始判断报文',
      noRaw: '这条决定没有调用决策模型。',
      confidence: '置信度',
      turnStep: '轮次 / 步',
      agentId: '智能体',
      time: '时间',
      effortAuto: '自动',
      noVision: '不支持图片',
      effortOff: '关闭',
      effortMinimal: '极低',
      effortLow: '低',
      effortMedium: '中',
      effortHigh: '高',
      effortXhigh: '极高',
      effortMax: '最高',
      historyEmpty: '还没有任何记录。切到"只观察"或"自动"，然后发一条消息试试。',
      historySub: '子智能体',
      historyMain: '主对话',
      tierFastShort: '最便宜',
      tierBalancedShort: '中间档',
      tierDeepShort: '最强',
      srcFallback: '本地兜底',
      srcDecision: '决策模型',
      srcBoth: '决策模型',
      srcOverride: '你手动指定',
      srcSessionOff: '沿用当前模型',
      srcEscalation: '失败后保持高强度',
      srcContinuation: '沿用上一步的路由',
      srcToolError: '工具调用失败',
      srcLongTurn: '这一轮跑得太久',
    }

    const CSS = `
.mr-root{position:relative;display:inline-flex;align-items:center;min-width:0}
.mr-trigger{height:28px;display:inline-flex;align-items:center;gap:6px;border:1px solid transparent;background:transparent;color:var(--dsw-alias-label-secondary);border-radius:var(--dsw-radius-sm,6px);padding:0 8px;font-size:13px;line-height:20px;cursor:pointer;max-width:280px}
.mr-trigger:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12));border-color:var(--dsw-alias-border-l1)}
.mr-trigger:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.mr-dot{width:7px;height:7px;border-radius:50%;flex:none;box-shadow:0 0 0 2px var(--dsw-alias-bg-base)}
.mr-trigger-text{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.mr-trigger-mode{font-weight:600;color:var(--dsw-alias-label-primary)}
.mr-panel{position:fixed;z-index:1200;box-sizing:border-box;background:var(--dsw-alias-bg-overlay);border:1px solid var(--dsw-alias-border-l1);border-radius:12px;box-shadow:0 18px 48px rgba(0,0,0,.32);color:var(--dsw-alias-label-primary);padding:14px;font-size:13px;line-height:1.45;overflow:auto;max-height:min(80vh,680px);overscroll-behavior:contain;width:min(420px,calc(100vw - 24px))}
.mr-head{display:flex;align-items:flex-start;justify-content:space-between;gap:8px}
.mr-head-text{min-width:0}
.mr-title{font-weight:600;font-size:14px}
.mr-subtitle{font-size:11px;color:var(--dsw-alias-label-secondary);margin-top:2px}
.mr-head-tools{display:flex;align-items:center;gap:4px;flex:none}
.mr-config{height:24px;border:1px solid var(--dsw-alias-border-l1);border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary);font-size:11px;padding:0 8px;cursor:pointer}
.mr-config:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12))}
.mr-config.is-on{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.mr-modal-backdrop{position:fixed;inset:0;z-index:1300;background:rgba(0,0,0,.42);display:flex;align-items:center;justify-content:center;padding:16px}
.mr-modal{box-sizing:border-box;width:min(440px,calc(100vw - 32px));max-height:min(84vh,720px);overflow:auto;background:var(--dsw-alias-bg-overlay);border:1px solid var(--dsw-alias-border-l1);border-radius:12px;box-shadow:0 24px 64px rgba(0,0,0,.42);color:var(--dsw-alias-label-primary);padding:14px;font-size:13px;line-height:1.45}
.mr-close{width:24px;height:24px;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;font-size:16px;line-height:1;display:grid;place-items:center;flex:none}
.mr-close:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12))}
.mr-usage{margin-top:10px;padding:8px 10px;border:1px solid var(--dsw-alias-border-l1);border-radius:9px;background:var(--dsw-alias-bg-layer-1)}
.mr-usage-head{display:flex;align-items:baseline;justify-content:space-between;gap:8px;margin-bottom:5px}
.mr-usage-title{font-size:11px;font-weight:600;color:var(--dsw-alias-label-primary)}
.mr-usage-total{font-size:11px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}
.mr-usage-empty{font-size:11px;color:var(--dsw-alias-label-secondary);padding:2px 0}
.mr-usage-rows{display:flex;flex-direction:column;gap:3px}
.mr-usage-row{display:flex;align-items:baseline;gap:8px;font-size:11px;line-height:1.6}
.mr-usage-tier{flex:none;width:48px;color:var(--dsw-alias-label-secondary)}
.mr-usage-model{flex:1;min-width:0;color:var(--dsw-alias-label-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.mr-usage-value{flex:none;color:var(--dsw-alias-label-primary);font-variant-numeric:tabular-nums}
.mr-dm-active{display:flex;flex-direction:column;gap:1px}
.mr-dm-active-name{font-size:12px;font-weight:600;color:var(--dsw-alias-label-primary)}
.mr-dm-active-meta{font-size:10px;color:var(--dsw-alias-label-secondary);word-break:break-all}
.mr-dm-list{display:flex;flex-direction:column;gap:4px;margin:6px 0}
.mr-dm{display:flex;align-items:stretch;gap:4px;border:1px solid var(--dsw-alias-border-l1);border-radius:7px;background:var(--dsw-alias-bg-layer-1);overflow:hidden}
.mr-dm.is-active{border-color:var(--dsw-alias-brand-primary)}
.mr-dm.is-editing{box-shadow:inset 0 0 0 1px var(--dsw-alias-brand-primary)}
.mr-dm-main{flex:1;min-width:0;display:flex;flex-direction:column;gap:1px;align-items:flex-start;text-align:left;padding:6px 8px;background:none;border:0;color:inherit;cursor:pointer;font:inherit}
.mr-dm-main:disabled{cursor:default;opacity:1}
.mr-dm-name{font-size:12px;font-weight:600;color:var(--dsw-alias-label-primary)}
.mr-dm-meta{font-size:10px;color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:100%}
.mr-dm-act{flex:none;width:26px;background:none;border:0;border-left:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary);cursor:pointer;font-size:12px}
.mr-dm-act:hover:not(:disabled){color:var(--dsw-alias-label-primary)}
.mr-dm-act:disabled{opacity:.4;cursor:default}
.mr-dm-actions{display:flex;gap:6px;margin:4px 0 8px}
.mr-dm-builtins{margin:6px 0 10px}
.mr-dm-builtin-row{display:flex;gap:6px;flex-wrap:wrap;margin-top:4px}
.mr-tabs{display:flex;gap:2px;padding:2px;background:var(--dsw-alias-bg-layer-2);border-radius:8px;margin:12px 0 10px}
.mr-tab{flex:1;border:0;background:transparent;color:var(--dsw-alias-label-secondary);border-radius:6px;padding:5px 6px;font-size:12px;cursor:pointer}
.mr-tab:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12))}
.mr-tab.is-on{background:var(--dsw-alias-bg-overlay);color:var(--dsw-alias-label-primary);font-weight:600;box-shadow:0 1px 2px rgba(0,0,0,.14)}
.mr-now{border:1px solid var(--dsw-alias-border-l1);border-radius:10px;padding:9px 10px;margin-bottom:12px;background:var(--dsw-alias-bg-layer-1)}
.mr-now-label{font-size:10px;letter-spacing:.04em;text-transform:uppercase;color:var(--dsw-alias-label-secondary)}
.mr-now-model{font-size:14px;font-weight:600;margin-top:3px;word-break:break-word}
.mr-now-tags{display:flex;flex-wrap:wrap;gap:5px;margin-top:6px}
.mr-tag{font-size:10px;padding:2px 6px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);white-space:nowrap}
.mr-tag-strong{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font-weight:600}
.mr-now-why{font-size:11px;color:var(--dsw-alias-label-secondary);margin-top:6px;word-break:break-word}
.mr-group{border-top:1px solid var(--dsw-alias-border-l1);padding-top:9px;margin-top:9px}
.mr-group:first-of-type{border-top:0;padding-top:0;margin-top:0}
.mr-group-head{display:flex;align-items:baseline;justify-content:space-between;gap:8px;margin-bottom:5px}
.mr-group-title{font-size:12px;font-weight:600}
.mr-group-hint{font-size:10px;color:var(--dsw-alias-label-secondary);margin-bottom:6px;line-height:1.4}
.mr-row{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:4px 0}
.mr-row-text{min-width:0;flex:1}
.mr-row-label{font-size:12px}
.mr-row-hint{font-size:10px;color:var(--dsw-alias-label-secondary);margin-top:1px;line-height:1.35}
.mr-seg{display:flex;gap:2px;padding:2px;background:var(--dsw-alias-bg-layer-2);border-radius:8px}
.mr-seg-item{flex:1;min-width:0;border:0;background:transparent;color:var(--dsw-alias-label-secondary);border-radius:6px;padding:5px 4px;font-size:11px;line-height:16px;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.mr-seg-item:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12))}
.mr-seg-item.is-on{background:var(--dsw-alias-bg-overlay);color:var(--dsw-alias-label-primary);font-weight:600;box-shadow:0 1px 2px rgba(0,0,0,.14)}
.mr-seg-item:disabled{opacity:.55;cursor:default}
.mr-switch{width:34px;height:20px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);padding:2px;cursor:pointer;display:flex;align-items:center;transition:background .12s ease,border-color .12s ease;flex:none}
.mr-switch.is-on{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary)}
.mr-switch:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
.mr-knob{width:14px;height:14px;border-radius:50%;background:#fff;box-shadow:0 1px 2px rgba(0,0,0,.25);transition:transform .12s ease}
.mr-switch.is-on .mr-knob{transform:translateX(14px)}
.mr-select{height:26px;border:1px solid var(--dsw-alias-border-l1);border-radius:6px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-size:12px;padding:0 6px;max-width:100%;flex:none}
.mr-select-sm{height:24px;font-size:11px}
.mr-input{height:26px;border:1px solid var(--dsw-alias-border-l1);border-radius:6px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-size:12px;padding:0 6px;width:100%;box-sizing:border-box}
.mr-criteria-head{display:flex;align-items:center;justify-content:space-between;gap:8px}
.mr-criteria-preview{margin-top:4px;max-height:132px;overflow:auto;border:1px solid var(--dsw-alias-border-l1);border-radius:6px;background:var(--dsw-alias-bg-layer-1);padding:6px 8px;font-size:10px;line-height:1.5;color:var(--dsw-alias-label-secondary)}
.mr-textarea{width:100%;box-sizing:border-box;min-height:96px;border:1px solid var(--dsw-alias-border-l1);border-radius:6px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-size:11px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;padding:6px;resize:vertical}
.mr-field{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:3px 0}
.mr-field-label{font-size:11px;color:var(--dsw-alias-label-secondary);flex:none;width:84px}
.mr-field-body{flex:1;min-width:0;display:flex;gap:6px;align-items:center}
.mr-tier{display:flex;align-items:center;gap:8px;padding:3px 0}
.mr-tier-name{font-size:12px;font-weight:600;flex:none;width:56px}
.mr-tier-select{flex:1;min-width:0;max-width:none}
.mr-note{margin-top:9px;font-size:11px;color:var(--dsw-alias-label-secondary);line-height:1.4}
.mr-error{color:var(--dsw-alias-state-error-primary)}
.mr-actions{display:flex;gap:6px;justify-content:flex-end;flex-wrap:wrap;margin-top:12px}
.mr-btn{height:28px;border:1px solid var(--dsw-alias-border-l1);border-radius:6px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-size:12px;padding:0 10px;cursor:pointer}
.mr-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12))}
.mr-btn:disabled{opacity:.5;cursor:default}
.mr-btn-primary{background:var(--dsw-alias-brand-primary);border-color:transparent;color:#fff}
.mr-btn-primary:disabled{opacity:.45}
.mr-btn-sm{height:24px;font-size:11px;padding:0 8px}
.mr-log{border:1px solid var(--dsw-alias-border-l1);border-radius:9px;overflow:hidden;background:var(--dsw-alias-bg-layer-1)}
.mr-log-row{display:flex;gap:8px;align-items:flex-start;padding:7px 9px;border-top:1px solid var(--dsw-alias-border-l1)}
.mr-log-row:first-child{border-top:0}
.mr-log-time{font-size:10px;color:var(--dsw-alias-label-secondary);flex:none;width:56px;font-variant-numeric:tabular-nums}
.mr-log-body{min-width:0;flex:1}
.mr-log-head{display:flex;flex-wrap:wrap;gap:5px;align-items:center}
.mr-log-tier{font-size:10px;font-weight:600;padding:1px 6px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.mr-log-model{font-size:11px;color:var(--dsw-alias-label-secondary);word-break:break-word}
.mr-log-why{font-size:10px;color:var(--dsw-alias-label-secondary);margin-top:2px;word-break:break-word}
.mr-empty{font-size:11px;color:var(--dsw-alias-label-secondary);padding:14px;text-align:center;line-height:1.5}
.mr-log-row{cursor:pointer}
.mr-log-row:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}
.mr-log-row:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.08))}
.mr-log-chevron{font-size:10px;color:var(--dsw-alias-label-secondary);flex:none;width:10px;text-align:center;margin-top:2px}
.mr-log-detail{margin-top:6px;padding-top:6px;border-top:1px dashed var(--dsw-alias-border-l1);display:flex;flex-direction:column;gap:2px}
.mr-detail-row{display:flex;gap:8px;font-size:10px;line-height:1.5}
.mr-detail-label{flex:none;width:72px;color:var(--dsw-alias-label-secondary)}
.mr-detail-value{flex:1;min-width:0;color:var(--dsw-alias-label-primary);word-break:break-word;font-variant-numeric:tabular-nums}
.mr-detail-title{font-size:10px;font-weight:600;color:var(--dsw-alias-label-secondary);margin-top:6px;text-transform:uppercase;letter-spacing:.04em}
.mr-detail-empty{font-size:10px;color:var(--dsw-alias-label-secondary);margin-top:2px}
.mr-verdict{display:flex;gap:8px;font-size:11px;line-height:1.6;margin-top:3px;padding:6px 8px;border-radius:6px;background:var(--dsw-alias-bg-layer-2)}
.mr-verdict-label{flex:none;color:var(--dsw-alias-label-secondary)}
.mr-verdict-value{flex:1;min-width:0;color:var(--dsw-alias-label-primary);word-break:break-word;font-weight:600}
.mr-prob{display:flex;flex-wrap:wrap;gap:5px;margin-top:5px}
.mr-prob-item{font-size:10px;padding:1px 6px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}
.mr-raw{margin:4px 0 0;padding:6px 8px;border-radius:6px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:10px;line-height:1.5;white-space:pre-wrap;word-break:break-word;max-height:180px;overflow:auto}
/* Routing owns the model choice, so the composer's own selector would be a
   second, conflicting control. Every slot outlet carries data-slot. */
html[data-model-router-routing] [data-slot="conversation.input.model"]{display:none !important}
`

    function installStyle() {
      const id = 'dsh-model-router-style'
      const previous = document.getElementById(id)
      if (previous) previous.remove()
      const style = document.createElement('style')
      style.id = id
      style.textContent = CSS
      document.head.appendChild(style)
      return () => style.remove()
    }

    async function requestJson(path, init) {
      const response = await fetch(path, {
        credentials: 'same-origin',
        cache: 'no-store',
        ...init,
      })
      const text = await response.text()
      let data = null
      if (text) {
        try {
          data = JSON.parse(text)
        } catch {
          data = null
        }
      }
      if (!response.ok) throw new Error(data?.error || `HTTP ${response.status}`)
      if (!data) throw new Error('empty response')
      return data
    }

    function RouterControl(props) {
      const { useState, useEffect, useRef, useCallback } = React
      const t = props.t
      const sessionId = String(props.sessionId ?? '')
      const [open, setOpen] = useState(false)
      const [tab, setTab] = useState('settings')
      const [status, setStatus] = useState(null)
      const [catalog, setCatalog] = useState(null)
      const [error, setError] = useState('')
      const [note, setNote] = useState('')
      const [busy, setBusy] = useState(false)
      const [position, setPosition] = useState(null)
      const [decisionOpen, setDecisionOpen] = useState(false)
      const [draft, setDraft] = useState(null)
      // Which decision model the user is editing, and whether the editor is
      // open at all. The list itself always lives on the Host.
      const [editingId, setEditingId] = useState(null)
      const rootRef = useRef(null)
      const panelRef = useRef(null)
      const modalRef = useRef(null)
      const triggerRef = useRef(null)
      const [expanded, setExpanded] = useState(() => new Set())

      const refresh = useCallback(async () => {
        try {
          const data = await requestJson(`/plugins/model-router/status?sessionId=${encodeURIComponent(sessionId)}`)
          setStatus(data)
          setError('')
        } catch (failure) {
          setError(String(failure?.message ?? failure))
        }
      }, [sessionId])

      const loadCatalog = useCallback(async () => {
        try {
          const data = await requestJson('/plugins/model-router/providers')
          setCatalog(data)
        } catch {
          setCatalog(null)
        }
      }, [])

      // One poll loop whose cadence follows the panel: frequent while it is
      // open, occasional while it is closed, so the composer's model seat still
      // follows a mode changed somewhere else.
      useEffect(() => {
        refresh()
        const timer = setInterval(refresh, open ? 5000 : 20000)
        return () => clearInterval(timer)
      }, [open, refresh])

      useEffect(() => {
        if (!open) return undefined
        loadCatalog()
      }, [open, loadCatalog])

      // Only `auto` actually chooses the model; `observe` leaves the request
      // untouched, so the composer's own selector must stay available.
      useEffect(() => {
        const root = document.documentElement
        if ((status?.config?.mode ?? status?.mode) === 'auto') root.setAttribute('data-model-router-routing', '')
        else root.removeAttribute('data-model-router-routing')
        return () => root.removeAttribute('data-model-router-routing')
      }, [status])

      // The decision fields are edited as text, so they need a local draft
      // that only syncs from the Host when the user is not editing.
      useEffect(() => {
        const decision = status?.config?.decision
        if (!decision) return
        const models = decision.models ?? []
        const active = models.find((entry) => entry.id === decision.activeId) ?? models[0] ?? null
        // The editor follows the profile the user picked.
        const target = models.find((entry) => entry.id === editingId) ?? active
        if (!target) return
        setDraft((current) => {
          if (current && current.id === target.id) return current
          return {
            id: target.id,
            label: target.label ?? '',
            endpoint: target.endpoint ?? '',
            model: target.model ?? '',
            protocol: target.protocol ?? 'systemone',
            timeoutMs: String(target.timeoutMs ?? 900),
            tierQuestion: target.tierQuestion ?? 'tier',
            effortQuestion: target.effortQuestion ?? 'effort',
            useDefault: !hasCriteria(target.questions),
            criteria: JSON.stringify(target.questions ?? defaultQuestions ?? {}, null, 2),
          }
        })
      }, [status, editingId])

      const place = useCallback(() => {
        const rect = rootRef.current?.getBoundingClientRect()
        if (!rect) return
        const width = Math.min(420, Math.max(320, window.innerWidth - 24))
        const left = Math.max(8, Math.min(window.innerWidth - width - 8, rect.right - width))
        const bottom = Math.max(8, window.innerHeight - rect.top + 8)
        setPosition({ left, bottom, width })
      }, [])

      useEffect(() => {
        if (!open) return undefined
        place()
        const onResize = () => place()
        window.addEventListener('resize', onResize)
        const focusTimer = setTimeout(() => panelRef.current?.querySelector('button')?.focus(), 0)
        return () => {
          window.removeEventListener('resize', onResize)
          clearTimeout(focusTimer)
        }
      }, [open, place])

      useEffect(() => {
        if (!open) return undefined
        const onPointer = (event) => {
          if (rootRef.current?.contains(event.target)) return
          if (panelRef.current?.contains(event.target)) return
          // The decision modal is its own overlay: its backdrop owns dismissal,
          // so a click inside it must not tear down the panel behind it.
          if (modalRef.current?.contains(event.target)) return
          if (decisionOpen) return
          setOpen(false)
        }
        const onKey = (event) => {
          if (event.key !== 'Escape') return
          if (decisionOpen) {
            setDecisionOpen(false)
            return
          }
          setOpen(false)
          setDecisionOpen(false)
          triggerRef.current?.focus()
        }
        document.addEventListener('mousedown', onPointer, true)
        document.addEventListener('keydown', onKey)
        return () => {
          document.removeEventListener('mousedown', onPointer, true)
          document.removeEventListener('keydown', onKey)
        }
      }, [open, decisionOpen])

      // Every change is applied and persisted in one step, the way the
      // Harness' own model configuration behaves, so there is no save action.
      async function postConfig(patch) {
        setBusy(true)
        setNote('')
        try {
          const data = await requestJson('/plugins/model-router/config', {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-model-router-control': '1' },
            body: JSON.stringify({ patch }),
          })
          setStatus(data)
          setError('')
          setNote(data?.persisted === false ? t('persistFailed') : '')
          return true
        } catch (failure) {
          setNote(String(failure?.message ?? failure))
          return false
        } finally {
          setBusy(false)
        }
      }

      const cfg = status?.config
      const mode = cfg?.mode ?? status?.mode ?? 'off'
      const candidates = status?.candidates ?? []
      const session = status?.sessions?.find((entry) => entry.id === sessionId)
      const activeTier = session?.active?.tier ?? session?.decision?.tier ?? null
      const activeModel = session?.active?.model ?? session?.decision?.model ?? ''
      const activeEffort = session?.active?.effort ?? session?.decision?.effort ?? ''
      const effortLabel = (value) => {
        const key = String(value ?? '').toLowerCase()
        if (!key) return t('effortAuto')
        return ({
          off: t('effortOff'),
          minimal: t('effortMinimal'),
          low: t('effortLow'),
          medium: t('effortMedium'),
          high: t('effortHigh'),
          xhigh: t('effortXhigh'),
          max: t('effortMax'),
        })[key] ?? key
      }

      const tierName = (tier) => {
        if (tier === 'fast') return t('tierFastShort')
        if (tier === 'balanced') return t('tierBalancedShort')
        if (tier === 'deep') return t('tierDeepShort')
        return tier ?? t('unknown')
      }

      const override = session?.overrideTier
        ?? status?.overrides?.find((entry) => entry.sessionId === sessionId)?.tier
        ?? null
      const chipDetail = mode === 'off'
        ? t('title')
        : [tierName(override ?? activeTier), activeModel, activeEffort ? `${t('effort')} ${effortLabel(activeEffort)}` : null]
          .filter(Boolean)
          .join(' · ') || t('title')
      const chipTitle = mode === 'off'
        ? `${t('title')} — ${t('subtitle')}`
        : `${t('title')} — ${chipDetail}`

      const dotColor = mode === 'off'
        ? 'var(--dsw-alias-state-idle-primary)'
        : activeTier === 'fast'
          ? 'var(--dsw-alias-state-success-primary)'
          : activeTier === 'balanced'
            ? 'var(--dsw-alias-brand-primary)'
            : activeTier === 'deep'
              ? 'var(--dsw-alias-state-warn-primary)'
              : 'var(--dsw-alias-state-idle-primary)'

      const chipLabel = mode === 'off'
        ? t('modeOff')
        : mode === 'observe'
          ? t('modeObserve')
          : [activeModel || (activeTier ? tierName(activeTier) : t('modeAuto')), activeEffort ? effortLabel(activeEffort) : null]
            .filter(Boolean)
            .join(' · ')

      // --- tier -> model editing -------------------------------------------
      const providerOptions = catalog?.providers ?? []
      const modelOptions = (provider) => catalog?.models?.[provider] ?? []
      const modelLabel = (entry) => {
        const name = String(entry?.name || entry?.id || '')
        const slash = name.lastIndexOf('/')
        const short = slash >= 0 ? name.slice(slash + 1) : name
        // Say plainly when a model cannot read an image: the router refuses to
        // route a picture to it, and the user should see that in the list.
        const modalities = entry?.inputModalities
        if (Array.isArray(modalities) && modalities.length > 0 && !modalities.includes('image')) {
          return `${short} · ${t('noVision')}`
        }
        return short
      }

      function candidateFor(tier) {
        return candidates.find((candidate) => candidate.tier === tier) ?? null
      }

      function updateCandidate(tier, patch) {
        const list = candidates.map((candidate) => ({ ...candidate }))
        const index = list.findIndex((candidate) => candidate.tier === tier)
        const base = index >= 0 ? list[index] : { tier, label: tierName(tier), cost: list.length + 1 }
        const next = { ...base, ...patch, tier }
        if (index >= 0) list[index] = next
        else list.push(next)
        return postConfig({ candidates: list })
      }

      function pickModelRow(tier, value) {
        const index = value.indexOf('|')
        if (index < 0) return
        const provider = value.slice(0, index)
        const model = value.slice(index + 1)
        const current = candidateFor(tier)
        if (current && current.provider === provider && current.model === model) return
        const row = modelOptions(provider).find((entry) => entry.id === model)
        const efforts = row?.efforts ?? []
        const effortByTier = { ...(current?.effortByTier ?? {}) }
        const effort = effortByTier[tier]
        if (effort && !efforts.includes(effort)) delete effortByTier[tier]
        updateCandidate(tier, { provider, model, label: model || tierName(tier), effortByTier })
      }

      // --- decision model editing ------------------------------------------
      // The list of decision models, as the Host holds it.
      const decisionModels = status?.config?.decision?.models ?? []
      const activeDecisionId = status?.config?.decision?.activeId ?? decisionModels[0]?.id ?? ''
      const builtins = status?.builtinDecisionModels ?? []
      // The criteria a profile uses until it is given its own. The panel shows
      // them and sends null, so a new decision model needs no typing.
      const defaultQuestions = status?.defaultDecisionQuestions ?? null

      // Criteria that carry no content mean "use the shared standard", so a
      // profile saved from a half-filled editor is not treated as custom.
      function hasCriteria(questions) {
        if (!questions || typeof questions !== 'object') return false
        const tier = questions.tier?.criteria
        const effort = questions.effort?.criteria
        return (tier && Object.keys(tier).length > 0) || (effort && Object.keys(effort).length > 0)
      }

      // The shared criteria, in a form a reader can check at a glance.
      function summarizeQuestions(questions) {
        if (!questions) return t('criteriaBuiltin')
        const tier = questions.tier?.criteria ?? {}
        const effort = questions.effort?.criteria ?? {}
        return [
          ...Object.keys(tier).map((key) => `${key}: ${tier[key]}`),
          ...Object.keys(effort).map((key) => `${t('effort')} ${key}: ${effort[key]}`),
        ]
      }

      function draftQuestions() {
        if (!draft) return null
        // Following the shared default: store no criteria of our own.
        if (draft.useDefault) return null
        if (!draft.criteria.trim()) return null
        try {
          return JSON.parse(draft.criteria)
        } catch {
          return undefined
        }
      }

      // The list a patch carries, with the edited profile folded in.
      function modelsWithDraft() {
        const questions = draftQuestions()
        if (questions === undefined) return null
        const rows = decisionModels.map((entry) => (entry.id === draft.id
          ? {
            ...entry,
            label: draft.label.trim() || entry.label,
            endpoint: draft.endpoint.trim(),
            model: draft.model.trim(),
            protocol: draft.protocol,
            timeoutMs: Number(draft.timeoutMs),
            tierQuestion: draft.tierQuestion.trim(),
            effortQuestion: draft.effortQuestion.trim(),
            questions,
          }
          : entry))
        return rows
      }

      // Save the edited profile.
      async function applyDecision() {
        if (!draft) return false
        const models = modelsWithDraft()
        if (!models) {
          setNote(t('criteriaInvalid'))
          return false
        }
        const ok = await postConfig({
          decision: {
            enabled: true,
            models,
            activeId: activeDecisionId,
          },
        })
        return ok
      }

      // Use another decision model from now on.
      async function useDecisionModel(id) {
        const ok = await postConfig({ decision: { activeId: id } })
        if (ok) {
          setEditingId(null)
          const row = decisionModels.find((entry) => entry.id === id)
          setNote(`${t('dmNowUsing')} ${row?.label || row?.model || id}`)
        }
        return ok
      }

      // Add an empty profile to fill in.
      async function addDecisionModel() {
        const models = [...decisionModels]
        const id = `decision-${models.length + 1}`
        models.push({
          id,
          label: '',
          endpoint: '',
          model: '',
          protocol: 'systemone',
          timeoutMs: 900,
          tierQuestion: 'tier',
          effortQuestion: 'effort',
          questions: null,
        })
        const ok = await postConfig({ decision: { models, activeId: id } })
        if (ok) setEditingId(id)
        return ok
      }

      // Add one of the built-in setups with a single click.
      async function addBuiltinDecisionModel(preset) {
        const models = [...decisionModels]
        const id = preset.id
        if (models.some((entry) => entry.id === id)) {
          // Already there: just switch to it.
          return useDecisionModel(id)
        }
        models.push({
          id: preset.id,
          label: preset.label ?? preset.id,
          endpoint: preset.endpoint ?? '',
          model: preset.model ?? '',
          protocol: preset.protocol ?? 'systemone',
          timeoutMs: preset.timeoutMs ?? 900,
          tierQuestion: preset.tierQuestion ?? 'tier',
          effortQuestion: preset.effortQuestion ?? 'effort',
          questions: preset.questions ?? null,
        })
        const ok = await postConfig({ decision: { models, activeId: id } })
        if (ok) {
          setEditingId(null)
          setNote(`${t('dmAdded')} ${preset.label || preset.id}`)
        }
        return ok
      }

      // Remove a profile. The last one cannot be removed.
      async function removeDecisionModel(id) {
        if (decisionModels.length <= 1) return false
        const models = decisionModels.filter((entry) => entry.id !== id)
        const activeId = activeDecisionId === id ? (models[0]?.id ?? '') : activeDecisionId
        const ok = await postConfig({ decision: { models, activeId } })
        if (ok) {
          setEditingId(null)
          setNote(`${t('dmRemoved')} ${id}`)
        }
        return ok
      }

      // --- rendering helpers ------------------------------------------------
      const segmented = (value, options, onChange) => h('div', {
        className: 'mr-seg',
        role: 'radiogroup',
      }, options.map(([key, label]) => h('button', {
        key,
        type: 'button',
        role: 'radio',
        'aria-checked': value === key,
        className: `mr-seg-item${value === key ? ' is-on' : ''}`,
        disabled: busy,
        onClick: () => onChange(key),
      }, label)))

      const switchRow = (label, checked, onChange, hint) => h('div', { className: 'mr-row' }, [
        h('div', { className: 'mr-row-text' }, [
          h('div', { className: 'mr-row-label' }, label),
          hint ? h('div', { className: 'mr-row-hint' }, hint) : null,
        ]),
        h('button', {
          type: 'button',
          role: 'switch',
          'aria-checked': Boolean(checked),
          'aria-label': label,
          className: `mr-switch${checked ? ' is-on' : ''}`,
          disabled: busy,
          onClick: onChange,
        }, h('span', { className: 'mr-knob' })),
      ])

      const selectRow = (label, value, options, onChange, hint) => h('div', { className: 'mr-row' }, [
        h('div', { className: 'mr-row-text' }, [
          h('div', { className: 'mr-row-label' }, label),
          hint ? h('div', { className: 'mr-row-hint' }, hint) : null,
        ]),
        h('select', {
          className: 'mr-select',
          value,
          disabled: busy,
          'aria-label': label,
          onChange: (event) => onChange(event.target.value),
        }, options.map(([key, text]) => h('option', { key, value: key }, text))),
      ])

      const field = (label, control) => h('div', { className: 'mr-field' }, [
        h('div', { className: 'mr-field-label' }, label),
        h('div', { className: 'mr-field-body' }, control),
      ])

      const group = (title, hint, children) => h('div', { className: 'mr-group' }, [
        h('div', { className: 'mr-group-head', key: 'head' }, h('div', { className: 'mr-group-title' }, title)),
        hint ? h('div', { className: 'mr-group-hint', key: 'hint' }, hint) : null,
        ...children,
      ])

      // One flat picker per tier, like the composer's own model menu: choosing a
      // provider first and then a model costs a row and says nothing extra.
      const tierEditor = h('div', { key: 'tiers' }, TIERS.map((tier) => {
        const candidate = candidateFor(tier)
        const current = candidate ? `${candidate.provider}|${candidate.model}` : ''
        const groups = providerOptions.map((provider) => {
          const rows = modelOptions(provider.id)
          if (rows.length === 0) return null
          return h('optgroup', { key: provider.id, label: provider.name || provider.id },
            rows.map((entry) => h('option', {
              key: `${provider.id}|${entry.id}`,
              value: `${provider.id}|${entry.id}`,
            }, modelLabel(entry))))
        }).filter(Boolean)
        // Keep the configured value selectable even when its provider is not
        // currently discoverable, so the picker never misreports the route.
        const present = groups.some((group) => (group.props.children ?? [])
          .some((option) => option.props.value === current))
        return h('div', { key: tier, className: 'mr-tier' }, [
          h('span', { className: 'mr-tier-name' }, tierName(tier)),
          h('select', {
            className: 'mr-select mr-select-sm mr-tier-select',
            value: current,
            disabled: busy,
            'aria-label': `${tierName(tier)} ${t('model')}`,
            onChange: (event) => pickModelRow(tier, event.target.value),
          }, [
            ...(current && !present
              ? [h('option', { key: 'current', value: current }, `${candidate.provider} / ${candidate.model}`)]
              : []),
            ...(groups.length === 0 ? [h('option', { key: 'none', value: '' }, t('selectModel'))] : []),
            ...groups,
          ]),
        ])
      }))

      // The decision-model settings live in their own modal, opened from the
      // configuration button beside the panel title.
      // The list of decision models, with the active one marked.
      const decisionList = h('div', { className: 'mr-dm-list', key: 'list' },
        decisionModels.map((entry) => {
          const isActive = entry.id === activeDecisionId
          const isEditing = entry.id === editingId
          return h('div', {
            key: entry.id,
            className: `mr-dm${isActive ? ' is-active' : ''}${isEditing ? ' is-editing' : ''}`,
          }, [
            h('button', {
              key: 'use',
              type: 'button',
              className: 'mr-dm-main',
              disabled: busy || isActive,
              title: isActive ? t('dmInUse') : t('dmUse'),
              onClick: () => useDecisionModel(entry.id),
            }, [
              h('span', { className: 'mr-dm-name' }, entry.label || entry.model || entry.id),
              h('span', { className: 'mr-dm-meta' }, [
                entry.model ? entry.model : null,
                entry.endpoint ? entry.endpoint : null,
              ].filter(Boolean).join(' · ')),
            ]),
            h('button', {
              key: 'edit',
              type: 'button',
              className: 'mr-dm-act',
              disabled: busy,
              'aria-label': t('dmEdit'),
              title: t('dmEdit'),
              onClick: () => setEditingId(isEditing ? null : entry.id),
            }, isEditing ? '×' : '✎'),
            decisionModels.length > 1 ? h('button', {
              key: 'remove',
              type: 'button',
              className: 'mr-dm-act',
              disabled: busy,
              'aria-label': t('dmRemove'),
              title: t('dmRemove'),
              onClick: () => removeDecisionModel(entry.id),
            }, '−') : null,
          ])
        }))

      // The one-click setups the panel knows about.
      const builtinList = builtins.length === 0 ? null : h('div', { className: 'mr-dm-builtins', key: 'builtins' }, [
        h('div', { className: 'mr-group-hint' }, t('dmBuiltins')),
        h('div', { className: 'mr-dm-builtin-row' }, builtins.map((preset) => {
          const existing = decisionModels.find((entry) => entry.id === preset.id)
          const isActive = existing?.id === activeDecisionId
          return h('button', {
            key: preset.id,
            type: 'button',
            className: `mr-btn mr-btn-sm${isActive ? ' is-on' : ''}`,
            disabled: busy || isActive,
            title: existing
              ? `${existing.label || existing.id} · ${existing.endpoint || t('dmNoEndpoint')}`
              : (preset.endpoint || t('dmNoEndpoint')),
            onClick: () => addBuiltinDecisionModel(preset),
          }, isActive
            ? `${t('dmInUseLabel')} ${preset.label}`
            : existing
              ? `${t('dmSwitchTo')} ${preset.label}`
              : `${t('dmAddBuiltin')} ${preset.label}`)
        })),
      ])

      const decisionBody = h('div', { key: 'decision' }, [
        h('div', { className: 'mr-group-hint', key: 'hint' }, t('decisionHint')),
        decisionList,
        h('div', { className: 'mr-dm-actions', key: 'actions' }, [
          h('button', {
            key: 'add',
            type: 'button',
            className: 'mr-btn mr-btn-sm',
            disabled: busy,
            onClick: () => addDecisionModel(),
          }, t('dmAdd')),
        ]),
        builtinList,
        draft && editingId ? h('div', { key: 'fields' }, [
          field(t('dmName'), h('input', {
            className: 'mr-input',
            value: draft.label ?? '',
            disabled: busy,
            placeholder: t('dmNamePlaceholder'),
            onChange: (event) => setDraft({ ...draft, label: event.target.value }),
          })),
          field(t('endpoint'), h('input', {
            className: 'mr-input',
            value: draft.endpoint,
            disabled: busy,
            placeholder: 'http://host:port/v1/chat/completions',
            onChange: (event) => setDraft({ ...draft, endpoint: event.target.value }),
          })),
          field(t('decisionModel'), h('input', {
            className: 'mr-input',
            value: draft.model,
            disabled: busy,
            placeholder: 'decision-model-preview',
            onChange: (event) => setDraft({ ...draft, model: event.target.value }),
          })),
          field(t('protocol'), h('select', {
            className: 'mr-select mr-select-sm',
            value: draft.protocol,
            disabled: busy,
            'aria-label': t('protocol'),
            onChange: (event) => setDraft({ ...draft, protocol: event.target.value }),
          }, [
            h('option', { key: 'systemone', value: 'systemone' }, 'systemone'),
            h('option', { key: 'openai', value: 'openai' }, 'openai'),
            h('option', { key: 'custom', value: 'custom' }, 'custom'),
          ])),
          field(t('timeout'), h('input', {
            className: 'mr-input',
            value: draft.timeoutMs,
            disabled: busy,
            inputMode: 'numeric',
            onChange: (event) => setDraft({ ...draft, timeoutMs: event.target.value }),
          })),
          field(t('tierQuestion'), h('input', {
            className: 'mr-input',
            value: draft.tierQuestion,
            disabled: busy,
            onChange: (event) => setDraft({ ...draft, tierQuestion: event.target.value }),
          })),
          field(t('effortQuestion'), h('input', {
            className: 'mr-input',
            value: draft.effortQuestion,
            disabled: busy,
            onChange: (event) => setDraft({ ...draft, effortQuestion: event.target.value }),
          })),
          h('div', { key: 'criteria', className: 'mr-row', style: { display: 'block' } }, [
            h('div', { className: 'mr-criteria-head' }, [
              h('span', { className: 'mr-row-label' }, t('criteria')),
              h('button', {
                key: 'toggle',
                type: 'button',
                className: 'mr-btn mr-btn-sm',
                disabled: busy,
                onClick: () => {
                  if (draft.useDefault) {
                    // Start from the shared default, so the textarea opens
                    // with a working answer instead of an empty box.
                    setDraft({
                      ...draft,
                      useDefault: false,
                      criteria: JSON.stringify(defaultQuestions ?? {}, null, 2),
                    })
                  } else {
                    setDraft({ ...draft, useDefault: true })
                  }
                },
              }, draft.useDefault ? t('criteriaCustomise') : t('criteriaReset')),
            ]),
            h('div', { className: 'mr-row-hint' }, draft.useDefault ? t('criteriaDefaultHint') : t('criteriaHint')),
            draft.useDefault
              ? h('div', { className: 'mr-criteria-preview' }, summarizeQuestions(defaultQuestions))
              : h('textarea', {
                className: 'mr-textarea',
                value: draft.criteria,
                disabled: busy,
                spellCheck: false,
                style: { marginTop: '4px' },
                onChange: (event) => setDraft({ ...draft, criteria: event.target.value }),
              }),
          ]),
        ]) : null,
      ])

      const historyRows = (status?.history ?? []).slice().reverse()
      const sourceLabel = (source) => {
        const value = String(source ?? '')
        if (value === 'session-override') return t('srcOverride')
        if (value === 'session-off') return t('srcSessionOff')
        if (value === 'escalation') return t('srcEscalation')
        if (value === 'continuation') return t('srcContinuation')
        if (value === 'tool-error') return t('srcToolError')
        if (value === 'long-turn') return t('srcLongTurn')
        if (value === 'heuristic+decision') return t('srcBoth')
        if (value === 'heuristic') return t('srcFallback')
        if (value === 'decision') return t('srcDecision')
        return value
      }
      // Why this route, in plain words. The Host records the reason; this
      // renders it in the interface language.
      const reasonLine = (entry) => {
        if (entry.source === 'continuation') return `${t('why')}: ${t('keptRoute')}`
        if (entry.source === 'long-turn') return `${t('why')}: ${t('longTurnReason')}`
        if (entry.source === 'heuristic+decision' || entry.decisionTier) {
          const parts = [
            tierName(entry.decisionTier),
            typeof entry.confidence === 'number' ? `${t('confidence')} ${entry.confidence.toFixed(2)}` : null,
          ].filter(Boolean)
          return `${t('why')}: ${t('judgeChose')} ${parts.join(' · ')}`
        }
        if (entry.source === 'heuristic') return `${t('why')}: ${t('ruleChose')} ${tierName(entry.tier)}`
        if (entry.source === 'escalation') return `${t('why')}: ${t('escalatedReason')}`
        if (entry.source === 'tool-error') return `${t('why')}: ${t('toolErrorReason')}`
        if (entry.source === 'session-override') return `${t('why')}: ${t('overrideReason')}`
        if (entry.source === 'session-off') return `${t('why')}: ${t('sessionOffReason')}`
        if (entry.source === 'external') return `${t('why')}: ${t('externalReason')}`
        return entry.rationale ? `${t('why')}: ${entry.rationale}` : ''
      }
      // Token counts get long; show them in a compact unit.
      const formatTokens = (value) => {
        const n = Number(value ?? 0)
        if (!Number.isFinite(n) || n <= 0) return '0'
        if (n < 1000) return String(n)
        if (n < 1000000) return `${(n / 1000).toFixed(n < 10000 ? 1 : 0)}k`
        return `${(n / 1000000).toFixed(1)}M`
      }
      const prettyJson = (text) => {
        if (typeof text !== 'string') return String(text ?? '')
        try {
          return JSON.stringify(JSON.parse(text), null, 2)
        } catch {
          return text
        }
      }
      const clockOf = (iso) => {
        try {
          const date = new Date(iso)
          if (Number.isNaN(date.getTime())) return ''
          return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
        } catch {
          return ''
        }
      }

      const settingsTab = h('div', { key: 'settings' }, [
        group(t('mode'), mode === 'off' ? t('modeOffHint') : mode === 'observe' ? t('modeObserveHint') : t('modeAutoHint'), [
          segmented(mode, [
            ['off', t('modeOff')],
            ['observe', t('modeObserve')],
            ['auto', t('modeAuto')],
          ], (value) => postConfig({ mode: value })),
          h('div', { key: 'needs', className: 'mr-note' }, [
            `${t('modeNeeds')}: `,
            mode === 'off' ? t('needsOff') : mode === 'observe' ? t('needsObserve') : t('needsAuto'),
          ]),
        ]),

        mode !== 'off' ? h('div', { key: 'active' }, [
          group(t('tierMap'), activeEffort ? `${t('tierMapHint')} ${t('effort')}: ${effortLabel(activeEffort)}.` : t('tierMapHint'), [tierEditor]),
          group(t('scope'), '', [
            switchRow(t('main'), cfg?.policy?.main ?? true, () => {
              postConfig({ policy: { main: !(cfg?.policy?.main ?? true) } })
            }),
            switchRow(t('subagents'), cfg?.policy?.subagents ?? true, () => {
              postConfig({ policy: { subagents: !(cfg?.policy?.subagents ?? true) } })
            }),
          ]),
          group(t('decision'), t('decisionActiveHint'), [
            // The name alone, and a dropdown that switches without opening the
            // configuration modal.
            h('select', {
              key: 'active',
              className: 'mr-select',
              value: activeDecisionId,
              disabled: busy || decisionModels.length === 0,
              onChange: (event) => useDecisionModel(event.target.value),
            }, decisionModels.map((entry) => h('option', {
              key: entry.id,
              value: entry.id,
            }, entry.label || entry.model || entry.id))),
          ]),
          selectRow(t('trust'), cfg?.policy?.decisionTrust ?? 'max', [
            ['max', t('trustMax')],
            ['safe', t('trustSafe')],
            ['decision', t('trustDecision')],
          ], (value) => postConfig({ policy: { decisionTrust: value } }), [
            {
              max: t('trustMaxHint'),
              safe: t('trustSafeHint'),
              decision: t('trustDecisionHint'),
            }[(cfg?.policy?.decisionTrust ?? 'max')],
            // The threshold is compared against the judge's top-two margin,
            // whose range is not obvious without seeing it.
            status?.confidenceStats
              ? [
                `${t('observedMargin')} ${status.confidenceStats.p50.toFixed(2)} / ${status.confidenceStats.p90.toFixed(2)}`,
                `${t('passingThreshold')} ${status.confidenceStats.passing}/${status.confidenceStats.samples}`,
                `${t('thresholdIs')} ${status.confidenceStats.threshold.toFixed(2)}`,
              ].join(' · ')
              : null,
          ].filter(Boolean).join('\n')),
        ]) : null,


      ])

      const historyTab = h('div', { key: 'history' }, [
        h('div', { className: 'mr-group-hint' }, t('historyHint')),
        historyRows.length === 0
          ? h('div', { className: 'mr-empty' }, t('historyEmpty'))
          : h('div', { className: 'mr-log' }, historyRows.map((entry, index) => {
            const rowKey = `${entry.at}-${entry.agent}-${index}`
            const isOpen = expanded.has(rowKey)
            const toggle = () => setExpanded((current) => {
              const next = new Set(current)
              if (next.has(rowKey)) next.delete(rowKey)
              else next.add(rowKey)
              return next
            })
            const detail = (label, value) => (value === null || value === undefined || value === '')
              ? null
              : h('div', { className: 'mr-detail-row', key: label }, [
                h('span', { className: 'mr-detail-label' }, label),
                h('span', { className: 'mr-detail-value' }, String(value)),
              ])
            return h('div', {
              key: rowKey,
              className: `mr-log-row${isOpen ? ' is-open' : ''}`,
              role: 'button',
              tabIndex: 0,
              'aria-expanded': isOpen,
              'aria-label': t('historyDetail'),
              onClick: toggle,
              onKeyDown: (event) => {
                if (event.key !== 'Enter' && event.key !== ' ') return
                event.preventDefault()
                toggle()
              },
            }, [
              h('span', { key: 'time', className: 'mr-log-time' }, clockOf(entry.at)),
              h('div', { key: 'body', className: 'mr-log-body' }, [
                h('div', { className: 'mr-log-head' }, [
                  h('span', { key: 'tier', className: 'mr-log-tier' }, tierName(entry.tier)),
                  h('span', { key: 'model', className: 'mr-log-model' }, entry.model ?? ''),
                  entry.effort ? h('span', { key: 'effort', className: 'mr-tag' }, `${t('effort')}: ${entry.effort}`) : null,
                  h('span', { key: 'src', className: 'mr-tag' }, sourceLabel(entry.source)),
                  h('span', { key: 'who', className: 'mr-tag' }, entry.subagent ? t('historySub') : t('historyMain')),
                ]),
                !isOpen && reasonLine(entry) ? h('div', { className: 'mr-log-why' }, reasonLine(entry)) : null,
                isOpen ? h('div', { className: 'mr-log-detail', key: 'detail' }, [
                  h('div', { className: 'mr-detail-title', key: 'verdict' }, t('verdictTrail')),
                  h('div', { className: 'mr-verdict', key: 'verdictRow' }, [
                    h('span', { className: 'mr-verdict-label' }, t('fromJudge')),
                    h('span', { className: 'mr-verdict-value' }, entry.decisionTier
                      ? [
                        tierName(entry.decisionTier),
                        typeof entry.confidence === 'number' ? `${t('confidence')} ${entry.confidence.toFixed(2)}` : null,
                        typeof entry.reportedConfidence === 'number' && typeof entry.confidenceMargin === 'number'
                          && Math.abs(entry.reportedConfidence - entry.confidenceMargin) >= 0.02
                          ? `${t('judgeSaid')} ${entry.reportedConfidence.toFixed(2)}`
                          : null,
                        entry.decisionEffort ? `${t('effort')} ${effortLabel(entry.decisionEffort)}` : null,
                      ].filter(Boolean).join(' · ')
                      : t('notConsulted')),
                  ]),
                  entry.probabilities && typeof entry.probabilities === 'object'
                    ? h('div', { key: 'prob', className: 'mr-prob' },
                      Object.entries(entry.probabilities).map(([key, value]) => h('span', {
                        key,
                        className: 'mr-prob-item',
                      }, `${key} ${typeof value === 'number' ? value.toFixed(2) : value}`)))
                    : null,
                  entry.heuristicHits
                    ? detail(t('ruleSaw'), [
                      entry.heuristicHits.deep?.length ? `deep: ${entry.heuristicHits.deep.join(', ')}` : null,
                      entry.heuristicHits.medium?.length ? `balanced: ${entry.heuristicHits.medium.join(', ')}` : null,
                      entry.heuristicHits.fast?.length ? `fast: ${entry.heuristicHits.fast.join(', ')}` : null,
                      typeof entry.heuristicScore === 'number' ? `score ${entry.heuristicScore}` : null,
                    ].filter(Boolean).join(' · '))
                    : null,
                  detail(t('provider'), entry.provider),
                  detail(t('model'), entry.model),
                  detail(t('effort'), entry.effort ? `${effortLabel(entry.effort)} (${entry.effort})` : t('effortAuto')),
                  entry.decisionLatencyMs !== null && entry.decisionLatencyMs !== undefined
                    ? detail(t('judgeTime'), `${entry.decisionLatencyMs} ms`)
                    : null,
                  entry.totalTokens !== null && entry.totalTokens !== undefined
                    ? detail(t('tokensUsed'), [
                      `${t('tokens')} ${formatTokens(entry.totalTokens)}`,
                      entry.inputTokens ? `${t('input')} ${formatTokens(entry.inputTokens)}` : null,
                      entry.outputTokens ? `${t('output')} ${formatTokens(entry.outputTokens)}` : null,
                    ].filter(Boolean).join(' · '))
                    : null,
                  detail(t('turnStep'), `${entry.turn ?? '-'} / ${entry.step ?? '-'}`),
                  detail(t('agentId'), String(entry.agent ?? '')),
                  detail(t('time'), new Date(entry.at).toLocaleString()),
                  h('div', { className: 'mr-detail-title', key: 'raw' }, t('rawVerdict')),
                  entry.decisionVerdict
                    ? h('pre', { key: 'rawjson', className: 'mr-raw' }, prettyJson(entry.decisionVerdict))
                    : h('div', { key: 'rawnone', className: 'mr-detail-empty' }, t('noRaw')),
                ]) : null,
              ]),
              h('span', { key: 'chevron', className: 'mr-log-chevron', 'aria-hidden': 'true' }, isOpen ? '▾' : '▸'),
            ])
          })),
      ])

      // Today's token totals, one row per tier and model.
      const usage = status?.usage ?? null
      const usageRows = usage?.rows ?? []
      const usagePanel = h('div', { className: 'mr-usage', key: 'usage' }, [
        h('div', { className: 'mr-usage-head' }, [
          h('span', { className: 'mr-usage-title' }, t('usageToday')),
          usage?.calls
            ? h('span', { className: 'mr-usage-total' }, `${formatTokens(usage.totalTokens)} ${t('tokens')}`)
            : null,
        ]),
        usageRows.length === 0
          ? h('div', { className: 'mr-usage-empty' }, t('usageEmpty'))
          : h('div', { className: 'mr-usage-rows' }, usageRows.map((row) => h('div', {
            key: `${row.tier}|${row.provider}|${row.model}`,
            className: 'mr-usage-row',
          }, [
            h('span', { className: 'mr-usage-tier' }, row.tier ? tierName(row.tier) : t('unknown')),
            h('span', { className: 'mr-usage-model' }, `${row.provider}/${row.model}`),
            h('span', { className: 'mr-usage-value' }, `${formatTokens(row.totalTokens)} ${t('tokens')}`),
          ]))),
      ])

      const panel = open ? createPortal(h('div', {
        ref: panelRef,
        className: 'mr-panel',
        role: 'dialog',
        'aria-label': t('title'),
        style: { ...(position ?? { left: 8, bottom: 8, width: 380 }), maxHeight: 'min(80vh, 680px)' },
      }, [
        h('div', { className: 'mr-head', key: 'head' }, [
          h('div', { className: 'mr-head-text', key: 'text' }, [
            h('div', { className: 'mr-title', key: 'title' }, t('title')),
            h('div', { className: 'mr-subtitle', key: 'sub' }, t('subtitle')),
          ]),
          h('div', { key: 'tools', className: 'mr-head-tools' }, [
            h('button', {
              key: 'decision',
              type: 'button',
              className: `mr-config${decisionOpen ? ' is-on' : ''}`,
              'aria-label': t('configure'),
              title: t('decision'),
              onClick: () => {
                loadCatalog()
                setDecisionOpen((value) => !value)
              },
            }, t('configure')),
            h('button', {
              key: 'close',
              type: 'button',
              className: 'mr-close',
              'aria-label': t('close'),
              onClick: () => {
                setOpen(false)
                triggerRef.current?.focus()
              },
            }, '×'),
          ]),
        ]),

        usagePanel,

        h('div', { className: 'mr-tabs', key: 'tabs', role: 'tablist' }, [
          h('button', {
            key: 'settings',
            type: 'button',
            role: 'tab',
            'aria-selected': tab === 'settings',
            className: `mr-tab${tab === 'settings' ? ' is-on' : ''}`,
            onClick: () => setTab('settings'),
          }, t('tabSettings')),
          h('button', {
            key: 'history',
            type: 'button',
            role: 'tab',
            'aria-selected': tab === 'history',
            className: `mr-tab${tab === 'history' ? ' is-on' : ''}`,
            onClick: () => setTab('history'),
          }, t('tabHistory')),
        ]),

        tab === 'settings' ? settingsTab : historyTab,

        error ? h('div', { className: 'mr-note mr-error', key: 'error' }, `${t('unavailable')}: ${error}`) : null,
        note ? h('div', { className: 'mr-note', key: 'note' }, note) : null,
        status && status.persistFailed
          ? h('div', { className: 'mr-note mr-error', key: 'save-hint' }, t('persistFailed'))
          : null,

      ]), document.body) : null

      const decisionModal = decisionOpen && open ? createPortal(h('div', {
        className: 'mr-modal-backdrop',
        onClick: (event) => {
          if (event.target === event.currentTarget) setDecisionOpen(false)
        },
      }, h('div', {
        ref: modalRef,
        className: 'mr-modal',
        role: 'dialog',
        'aria-modal': 'true',
        'aria-label': t('decision'),
      }, [
        h('div', { className: 'mr-head', key: 'head' }, [
          h('div', { className: 'mr-head-text', key: 'text' }, [
            h('div', { className: 'mr-title', key: 'title' }, t('decision')),
          ]),
          h('button', {
            key: 'close',
            type: 'button',
            className: 'mr-close',
            'aria-label': t('close'),
            onClick: () => {
              setEditingId(null)
              setDecisionOpen(false)
            },
          }, '×'),
        ]),
        decisionBody,
        note ? h('div', { className: 'mr-note', key: 'note' }, note) : null,
        h('div', { className: 'mr-actions', key: 'actions' }, [
          h('button', {
            key: 'done',
            type: 'button',
            className: 'mr-btn mr-btn-primary',
            disabled: busy,
            onClick: async () => {
              // Only an open editor has something to save; the list itself is
              // already written when a row is picked.
              const ok = editingId ? await applyDecision() : true
              if (ok) {
                setEditingId(null)
                setDecisionOpen(false)
              }
            },
          }, t('done')),
        ]),
      ])), document.body) : null

      return h('div', { className: 'mr-root', ref: rootRef }, [
        h('button', {
          key: 'trigger',
          ref: triggerRef,
          type: 'button',
          className: 'mr-trigger',
          'aria-haspopup': 'dialog',
          'aria-expanded': open,
          'aria-label': `${t('title')} · ${chipDetail}`,
          title: chipTitle,
          onClick: () => {
            if (open) {
              setOpen(false)
              setDecisionOpen(false)
            } else {
              setOpen(true)
            }
          },
        }, [
          h('span', { key: 'dot', className: 'mr-dot', style: { background: dotColor } }),
          h('span', { key: 'label', className: 'mr-trigger-text' }, [
            `${t('chip')} · `,
            h('span', { key: 'value', className: 'mr-trigger-mode' }, chipLabel),
          ]),
        ]),
        panel,
        decisionModal,
      ])
    }

    return {
      name: 'model-router',
      inject: ['slots', 'locale'],
      apply(ctx) {
        try {
          if (typeof ctx.effect === 'function') ctx.effect(() => installStyle())
          else installStyle()
        } catch {
          // Styling is best-effort; the control still functions without it.
        }

        let translate = (key) => {
          let localeId = 'en'
          try {
            localeId = ctx.locale?.getLocale?.().active ?? 'en'
          } catch {
            localeId = 'en'
          }
          return (localeId === 'zh' ? ZH : EN)[key] ?? key
        }
        try {
          if (ctx.locale?.register) {
            const register = () => ctx.locale.register('model-router', { zh: ZH, en: EN })
            if (typeof ctx.effect === 'function') ctx.effect(register)
            else register()
          }
          if (ctx.locale?.bind) translate = ctx.locale.bind('model-router')
        } catch {
          // Fall back to the bundled English/Chinese dictionary.
        }

        // The locale face republishes on every dictionary registration and
        // locale switch, so the control re-renders with the new language.
        const localeFace = ctx.locale ?? null

        ctx.slots.inject('conversation.input.right', () => ctx.slots.register({
          name: 'conversation.input.right',
          id: 'model-router',
          order: 20,
        }, (props) => h(RouterControl, { ...props, t: translate, localeFace })))
      },
    }
  },
})
