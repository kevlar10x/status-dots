import type { EngineInterface as Engine, McpToolResult, Register, Timer } from 'claude-code'

// status-dots by kevlar10x, MIT: https://github.com/kevlar10x/status-dots
//
// Puts a colored dot in front of this session's title, which the Code tab's
// sidebar shows, so the list reads like a traffic light: red when an error or
// a refusal stopped Claude, yellow when something on screen waits for you (a
// question, a plan or a permission card, or a question in the next-step box),
// blue when it finished while you weren't looking, green once you've seen it
// and it needs nothing from you. While Claude works the title has no dot: the
// app's own grey dot shows then. The desktop app gives mods no way to recolor
// its own sidebar dot, so the title carries it. A title you typed yourself is
// yours: the app won't let anything but an approved rename change it, so that
// session gets no dot.

type Status = 'waiting' | 'fresh' | 'done' | 'failed'

// Yellow is the app's own color for a session that needs input, blue its color
// for one with something you haven't seen.
const DOTS: Record<Status, string> = { waiting: '🟡', fresh: '🔵', done: '🟢', failed: '🔴' }
// ⚪ is 0.1.0's dot for a suggested next step, matched so it's replaced or cleared.
const DOT = /^(?:⚪|🟡|🔵|🟢|🔴) /u
const SESSIONS = 'ccd_session_mgmt'
const WINDOW = 'ccd_window'
// How often a blue session checks whether you've opened it.
const SEEN_CHECK_MS = 5000
// How often, and how many times, a starting session retries reaching the app.
const START_RETRY_MS = 5000
const START_TRIES = 6
// How often, and how many times, a finished turn looks for the app's verdict.
const VERDICT_CHECK_MS = 2000
const VERDICT_TRIES = 15
// An app call that hasn't answered by then counts as failed, so one stuck call
// can't hold up every dot after it.
const CALL_TIMEOUT_MS = 10000
// Tools that stop for you whatever the permission mode.
const ASKS = new Set(['AskUserQuestion', 'ExitPlanMode'])
// The app's end-of-turn box; with an `ask` it shows a question and buttons.
const WRAP_UP = 'mcp__ccd_turn__wrap_up'

// The dot this session should show; undefined for none.
let wanted: Status | undefined
let isWriting = false
// The title is one you set, which the app keeps.
let isUserTitle = false
let isOff = false
let questions = 0
// The turn's end-of-turn box asks you something.
let isAsking = false
// While the dot is blue: the next check for whether you've opened the session.
let seenCheck: Timer | undefined
// A turn has started in this process, so the start check has nothing left to do.
let hasTurned = false
// Counts the main loop's turns, so a check started for one turn knows when another began.
let turnCount = 0
// After a turn: the next look for the app's verdict on it.
let verdictCheck: Timer | undefined
let sessionId: string | undefined
let recordPath: string | undefined
let recordSearches = 0

// What the app keeps about this session in its data folder: whether the last
// turn's next-step box asked you something, and whether an error ended it. The
// file is the app's and private, so anything unexpected in it only means no
// verdict, and the mod's own checks stand.
type AppRecord = {
  lastAssistantUuid?: string
  postTurnSummary?: unknown
  postTurnSummaryFor?: string
  turnWrapUp?: { needsUser?: string }
  error?: unknown
  errorCategory?: unknown
}
type Verdict = 'waiting' | 'failed' | 'finished'

function textOf(result: McpToolResult) {
  const block = result.content.find(one => one.type === 'text') as { text?: string } | undefined
  return block?.text ?? ''
}

async function call($: Engine, server: string, tool: string, args: Record<string, unknown>) {
  let timer: Timer | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = $.clock.after(CALL_TIMEOUT_MS, () => reject(new Error(`${tool} timed out`)))
  })
  try {
    return await Promise.race([$.mcp.call(server, tool, args), timeout])
  } finally {
    timer?.cancel()
  }
}

async function titleOf($: Engine) {
  const result = await call($, SESSIONS, 'get_session', { session_id: 'self' })
  if (result.isError) return undefined
  const session = JSON.parse(textOf(result)) as { title?: string; sessionId?: string }
  sessionId ??= session.sessionId
  return session.title?.trim() ?? ''
}

function statusOf(title: string): Status | undefined {
  return (Object.keys(DOTS) as Status[]).find(status => title.startsWith(`${DOTS[status]} `))
}

// The app keeps one file per session under %LOCALAPPDATA%\Claude-Data. Looked up
// once, then reused; a few tries, since the session's id comes from the app.
async function findRecord($: Engine) {
  if (recordPath !== undefined || sessionId === undefined || recordSearches >= 3) return recordPath
  recordSearches += 1
  const local = await $.env.get('LOCALAPPDATA')
  if (!local) return undefined
  const base = `${local}/Claude-Data`
  if (!(await $.fs.exists(base))) return undefined
  for (const account of await $.fs.list(base)) {
    if (account.kind !== 'dir' || !account.name.startsWith('claude_')) continue
    const root = `${base}/${account.name}/claude-code-sessions`
    if (!(await $.fs.exists(root))) continue
    for (const outer of await $.fs.list(root)) {
      if (outer.kind !== 'dir') continue
      for (const inner of await $.fs.list(`${root}/${outer.name}`)) {
        const path = `${root}/${outer.name}/${inner.name}/${sessionId}.json`
        if (inner.kind === 'dir' && (await $.fs.exists(path))) return (recordPath = path)
      }
    }
  }
  return undefined
}

async function readRecord($: Engine) {
  try {
    const path = await findRecord($)
    return path === undefined ? undefined : (JSON.parse(await $.fs.read(path)) as AppRecord)
  } catch {
    return undefined
  }
}

// How the last turn ended, from what the app recorded, once its record has
// caught up with the latest reply (it sums every turn up, and the summary
// arriving is the sign). Only what's really on screen counts: a question in the
// next-step box is your turn and an error is red. The summary's own reading of
// the reply, that Claude seems blocked on you, say, is a guess the mod ignores,
// since nothing in the session waits for you then.
function verdictOf(record: AppRecord): Verdict | undefined {
  if (record.postTurnSummary === undefined || record.lastAssistantUuid === undefined) return undefined
  if (record.postTurnSummaryFor !== record.lastAssistantUuid) return undefined
  if (record.error !== undefined || record.errorCategory !== undefined) return 'failed'
  if (record.turnWrapUp?.needsUser) return 'waiting'
  return 'finished'
}

async function applyVerdict($: Engine, verdict: Verdict) {
  if (verdict === 'finished') {
    if (wanted !== 'done' && wanted !== 'fresh') await showFinished($)
    return
  }
  if (wanted === verdict) return
  stopWatching()
  await show($, verdict)
}

// The app sums up a turn a few seconds after it ends. Until then the dot comes
// from the mod's own checks; once the summary is in, the app's verdict wins.
function followVerdict($: Engine, triesLeft = VERDICT_TRIES) {
  const turn = turnCount
  verdictCheck?.cancel()
  verdictCheck = $.clock.after(VERDICT_CHECK_MS, async () => {
    verdictCheck = undefined
    if (turn !== turnCount) return
    const record = await readRecord($)
    const verdict = record === undefined ? undefined : verdictOf(record)
    if (turn !== turnCount) return
    if (verdict !== undefined) return applyVerdict($, verdict).catch(() => undefined)
    if (triesLeft > 1) followVerdict($, triesLeft - 1)
  })
}

function stopFollowing() {
  verdictCheck?.cancel()
  verdictCheck = undefined
}

// Writes the wanted dot into the title, one write at a time. A change asked for
// while a write is out is picked up when that write returns.
async function paint($: Engine) {
  if (isWriting || isUserTitle) return
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
        const result = await call($, SESSIONS, 'set_session_title', { session_id: 'self', title: next })
        if (result.isError) {
          if (/set by the user/.test(textOf(result))) {
            isUserTitle = true
            await explainOnce($)
          }
          return
        }
      }
    } while (status !== wanted)
  } catch {
    // The app's tools aren't reachable: not connected yet in a process that has
    // just started, or not there at all outside the desktop app. Only this
    // write is skipped; the next change tries again.
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
  const listed = await call($, SESSIONS, 'list_sessions', { limit: 200, include_archived: true })
  if (listed.isError) return 0
  const sessions = JSON.parse(textOf(listed)) as { sessionId: string; title?: string }[]
  let cleared = 0
  for (const session of sessions) {
    const title = session.title?.trim() ?? ''
    if (!DOT.test(title)) continue
    const result = await call($, SESSIONS, 'set_session_title', {
      session_id: session.sessionId,
      title: title.replace(DOT, ''),
    })
    if (!result.isError) cleared += 1
  }
  return cleared
}

// Whether the app shows this session in a window now. A failed check counts as
// shown, so a session the check can't reach goes green instead of staying blue.
async function isOnScreen($: Engine) {
  try {
    const result = await call($, WINDOW, 'get_window_layout', {})
    if (result.isError) return true
    const layout = JSON.parse(textOf(result)) as { this_session?: { on_screen?: boolean } }
    return layout.this_session?.on_screen !== false
  } catch {
    return true
  }
}

// A finished session stays blue until you've had it on screen, then turns green.
async function showFinished($: Engine) {
  if (await isOnScreen($)) return show($, 'done')
  await show($, 'fresh')
  if (wanted === 'fresh') watchUntilSeen($)
}

// Checks every few seconds while the dot is blue, and stops once it isn't.
function watchUntilSeen($: Engine) {
  seenCheck?.cancel()
  seenCheck = $.clock.after(SEEN_CHECK_MS, async () => {
    seenCheck = undefined
    if (wanted !== 'fresh') return
    const isSeen = await isOnScreen($)
    // A turn may have started while the check was out.
    if (wanted !== 'fresh') return
    if (!isSeen) return watchUntilSeen($)
    try {
      await show($, 'done')
    } catch {
      // The store couldn't be read; the next turn sets the dot again.
    }
  })
}

function stopWatching() {
  seenCheck?.cancel()
  seenCheck = undefined
}

// What a session finds when it starts. With the dots off, a dot left from
// before goes. With them on, the dot is brought in line with the app's verdict
// on the last turn, which also catches a turn whose end the mod missed (its
// process stopped, or the app couldn't be reached then). A yellow dot left by a
// closed app stays, since the session still needs you, and a blue one turns
// green once you've opened the session. In a process that has just started the
// app's tools may not be connected yet, so the check tries again a few times,
// until a turn starts and takes over.
async function checkAtStart($: Engine, triesLeft: number) {
  if (hasTurned) return
  let title: string
  try {
    title = (await titleOf($)) ?? ''
  } catch {
    if (triesLeft > 0) $.clock.after(START_RETRY_MS, () => void checkAtStart($, triesLeft - 1).catch(() => undefined))
    return
  }
  if (isOff) {
    if (DOT.test(title)) await show($, undefined)
    return
  }
  wanted = statusOf(title)
  const record = await readRecord($)
  const verdict = record === undefined ? undefined : verdictOf(record)
  if (hasTurned) return
  if (verdict !== undefined) await applyVerdict($, verdict)
  if (wanted !== 'fresh' || hasTurned) return
  if (await isOnScreen($)) await show($, 'done')
  else watchUntilSeen($)
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
    await checkAtStart($, START_TRIES)

    return result
  })

  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) {
      questions = 0
      isAsking = false
      stopWatching()
      stopFollowing()
      hasTurned = true
      turnCount += 1
      // You may have handed the title back since (an approved rename by Claude).
      isUserTitle = false
      await show($, undefined)
    }

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId !== undefined) return result
    questions = 0
    // An answer whose next-step box asks you something leaves it your turn. A
    // question only in the reply's text doesn't: nothing on screen waits for you.
    if (e.reason === 'answer' && !isAsking) await showFinished($)
    // Stopped by you: no dot, since you were there to see it.
    else await show($, e.reason === 'answer' ? 'waiting' : e.reason === 'aborted' ? undefined : 'failed')
    if (e.reason === 'answer') followVerdict($)

    return result
  })

  // A permission prompt or a question is waiting for you. There's no hook on
  // the permission check itself: the Claude directory accepts one there only
  // when it does nothing but pass the event on.
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
      stopWatching()
      stopFollowing()
      await show($, undefined)
      let cleared = 0
      try {
        cleared = await clearOthers($)
      } catch {
        // The list couldn't be read; each session still drops its dot when it next starts or works.
      }
      const others = cleared === 1 ? '1 other session' : `${cleared} other sessions`
      return { text: cleared === 0 ? 'Status dots are off.' : `Status dots are off. Also took the dot off ${others}.` }
    }
    return { text: 'Status dots are on. In the Claude desktop app, this session gets its dot the next time Claude finishes here.' }
  })
}
