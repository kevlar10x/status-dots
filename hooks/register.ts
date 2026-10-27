import type { EngineInterface as Engine, McpToolResult, Register } from 'claude-code'

// status-dots by kevlar10x, MIT: https://github.com/kevlar10x/status-dots
//
// Puts a colored dot in front of this session's title, which the Code tab's
// sidebar shows, so the list reads like a traffic light: red when an error or
// a refusal stopped Claude, yellow when it's your turn (a question, a plan or
// a permission card waits for you, or the turn ended by asking you something),
// green when it finished and needs nothing from you. While Claude works the
// title has no dot: the app's own grey dot shows then. The desktop app gives
// mods no way to recolor its own sidebar dot, so the title carries it. A title
// you typed yourself is yours: the app won't let anything but an approved
// rename change it, so that session gets no dot.

type Status = 'waiting' | 'done' | 'failed'

// Yellow is the app's own color for a session that needs input.
const DOTS: Record<Status, string> = { waiting: '🟡', done: '🟢', failed: '🔴' }
// ⚪ is 0.1.0's dot for a suggested next step, matched so it's replaced or cleared.
const DOT = /^(?:⚪|🟡|🟢|🔴) /u
const SESSIONS = 'ccd_session_mgmt'
// Tools that stop for you whatever the permission mode.
const ASKS = new Set(['AskUserQuestion', 'ExitPlanMode'])
// The app's end-of-turn box; with an `ask` it shows a question and buttons.
const WRAP_UP = 'mcp__ccd_turn__wrap_up'
// Text whose last line is a question, past any closing markdown or quotes.
const ENDS_ASKING = /\?["'”’)\]*_`]*\s*$/u

// The dot this session should show; undefined for none.
let wanted: Status | undefined
let isWriting = false
// 'user': the title is one you set, which the app keeps. 'app': the desktop
// app's session tools aren't here (a terminal session).
let blocked: 'user' | 'app' | undefined
let isOff = false
let questions = 0
// The turn's end-of-turn box asks you something.
let isAsking = false

function textOf(result: McpToolResult) {
  const block = result.content.find(one => one.type === 'text') as { text?: string } | undefined
  return block?.text ?? ''
}

async function titleOf($: Engine) {
  const result = await $.mcp.call(SESSIONS, 'get_session', { session_id: 'self' })
  if (result.isError) return undefined
  const session = JSON.parse(textOf(result)) as { title?: string }
  return session.title?.trim() ?? ''
}

// Writes the wanted dot into the title, one write at a time. A change asked for
// while a write is out is picked up when that write returns.
async function paint($: Engine) {
  if (isWriting || blocked !== undefined) return
  isWriting = true
  try {
    let status: Status | undefined
    do {
      status = wanted
      const title = await titleOf($)
      if (title === undefined) return
      const bare = title.replace(DOT, '')
      // No title yet. The app names a new session from its first prompt, and a
      // title written before that would stop it from doing so.
      if (bare === '') return
      const next = status === undefined ? bare : `${DOTS[status]} ${bare}`
      if (next !== title) {
        const result = await $.mcp.call(SESSIONS, 'set_session_title', { session_id: 'self', title: next })
        if (result.isError) {
          if (/set by the user/.test(textOf(result))) {
            blocked = 'user'
            await explainOnce($)
          }
          return
        }
      }
    } while (status !== wanted)
  } catch {
    blocked = 'app'
  } finally {
    isWriting = false
  }
}

// Said once, ever, so a session without a dot isn't a mystery.
async function explainOnce($: Engine) {
  if ((await $.store.get('hasExplained')) === true) return
  await $.store.set('hasExplained', true)
  $.ui.toast("status-dots: you named this session yourself, so it gets no dot. Have Claude rename it once (you approve) and it will.")
}

async function show($: Engine, status: Status | undefined) {
  // Another session may have turned the dots off since.
  isOff = (await $.store.get('isOff')) === true
  wanted = isOff ? undefined : status
  await paint($)
}

// Takes the dot off every other session the app lists, archived ones too, so
// turning the dots off (before an uninstall, say) leaves none behind.
async function clearOthers($: Engine) {
  const listed = await $.mcp.call(SESSIONS, 'list_sessions', { limit: 200, include_archived: true })
  if (listed.isError) return 0
  const sessions = JSON.parse(textOf(listed)) as { sessionId: string; title?: string }[]
  let cleared = 0
  for (const session of sessions) {
    const title = session.title?.trim() ?? ''
    if (!DOT.test(title)) continue
    const result = await $.mcp.call(SESSIONS, 'set_session_title', {
      session_id: session.sessionId,
      title: title.replace(DOT, ''),
    })
    if (!result.isError) cleared += 1
  }
  return cleared
}

// Back to working (no dot) once nothing waits on you. Tool calls only return
// inside a turn, so this needs no turn of its own to have been seen.
async function resume($: Engine) {
  if (questions === 0 && wanted === 'waiting') await show($, undefined)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'dots', description: 'Turn the sidebar status dots on or off' })
    const result = await next(e)
    isOff = (await $.store.get('isOff')) === true
    // With the dots off, a dot left from before goes. With them on, every dot
    // stays: a yellow one left by a closed app still means the session needs you.
    if (isOff) {
      try {
        if (DOT.test((await titleOf($)) ?? '')) await show($, undefined)
      } catch {
        blocked = 'app'
      }
    }

    return result
  })

  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) {
      questions = 0
      isAsking = false
      // You may have handed the title back since (an approved rename by Claude).
      if (blocked === 'user') blocked = undefined
      await show($, undefined)
    }

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId !== undefined) return result
    questions = 0
    // An answer that asks you something leaves it your turn: through the
    // end-of-turn box, or by ending its text on a question.
    const answered = isAsking || ENDS_ASKING.test(e.answer) ? 'waiting' : 'done'
    // Stopped by you: no dot, since you were there to see it.
    await show($, e.reason === 'answer' ? answered : e.reason === 'aborted' ? undefined : 'failed')

    return result
  })

  // A permission card is up, for the main loop or a subagent.
  on('classic.PermissionRequest', async ($, e, next) => {
    await show($, 'waiting')

    return next(e)
  }).catch(($, e, next) => next(e))

  on('classic.Notification', async ($, e, next) => {
    if (e.notification_type === 'permission_prompt' || e.notification_type === 'elicitation_dialog') {
      await show($, 'waiting')
    }

    return next(e)
  }).catch(($, e, next) => next(e))

  // A question or a plan to approve waits for you until its call returns; any
  // call returning moves an answered permission card back to working.
  on('tool.call', async ($, e, next) => {
    if (e.tool === WRAP_UP && e.agentId === undefined) {
      const ask = (e as { ask?: unknown }).ask
      if (typeof ask === 'string' && ask.trim() !== '') isAsking = true
    }
    const isQuestion = ASKS.has(e.tool)
    if (isQuestion) {
      questions += 1
      await show($, 'waiting')
    }
    try {
      return await next(e)
    } finally {
      if (isQuestion) questions -= 1
      await resume($)
    }
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'dots' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    isOff = arg === 'off' ? true : arg === 'on' ? false : !isOff
    await $.store.set('isOff', isOff)
    if (isOff) {
      await show($, undefined)
      if (blocked === 'app') return { text: 'Status dots are off.' }
      let cleared = 0
      try {
        cleared = await clearOthers($)
      } catch {
        // The list couldn't be read; each session still drops its dot when it next starts or works.
      }
      const others = cleared === 1 ? '1 other session' : `${cleared} other sessions`
      return { text: cleared === 0 ? 'Status dots are off.' : `Status dots are off. Also took the dot off ${others}.` }
    }
    if (blocked === 'app') return { text: 'Status dots are on, but they only show in the Claude desktop app.' }

    return { text: 'Status dots are on. This session gets its dot the next time Claude finishes here.' }
  })
}
