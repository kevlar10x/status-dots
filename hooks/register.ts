import type { EngineInterface as Engine, McpToolResult, Register, Timer } from 'claude-code'

import type { Turn } from '../types'

// status-dots by kevlar10x, MIT: https://github.com/kevlar10x/status-dots
//
// Puts a colored dot in front of this session's title, which the Code tab's
// sidebar shows, so the list reads like a traffic light: red when an error or
// a refusal stopped Claude, yellow when something on screen waits for you (a
// question, a plan or a permission card, or a question in the next-step box),
// blue when it finished while you weren't looking, green once you've seen it
// and it needs nothing from you, white while Claude works. The desktop app
// gives mods no way to recolor its own sidebar dot, so the title carries it. A
// title you typed yourself is yours: the app won't let anything but an
// approved rename change it, so that session gets no dot.
//
// Hooks never wait for the title: they set the dot they want and pass their
// event straight on, and the title catches up a moment later.

type Status = 'working' | 'waiting' | 'fresh' | 'done' | 'failed'

// Yellow is the app's own color for a session that needs input, blue its color
// for one with something you haven't seen. White is the nearest emoji to the
// app's grey working dot.
const DOTS: Record<Status, string> = { working: '⚪', waiting: '🟡', fresh: '🔵', done: '🟢', failed: '🔴' }
const DOT = /^(?:⚪|🟡|🔵|🟢|🔴) /u
const SESSIONS = 'ccd_session_mgmt'
const WINDOW = 'ccd_window'
// A blue session checks whether you've opened it every second at first, since
// that's when you're most likely to, then every 4 seconds for about 5 minutes,
// then every 15 seconds for as long as it stays blue.
const SEEN_STEPS = [
  { checks: 20, everyMs: 1000 },
  { checks: 70, everyMs: 4000 },
  { checks: Infinity, everyMs: 15000 },
]
// A write that couldn't reach the app (its tools still connecting, say) is
// tried again every second, ten times.
const WRITE_RETRY_MS = 1000
const WRITE_TRIES = 10
const UNREACHABLE_RUNS = 2
// How often, and how many times, a starting session retries reaching the app.
const START_RETRY_MS = 1000
const START_TRIES = 30
// How long a starting session waits for a turn before calling a white dot stale.
const STALE_WORKING_MS = 10000
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
// The app's rename tool, as Claude calls it.
const RENAME = `mcp__${SESSIONS}__set_session_title`
// The app's session ids, which name its record files.
const SESSION_ID = /^local_[\w-]+$/
// The current turn, held by the host. A reload of the mod's code in the middle
// of a turn (an update, a dev folder's hot reload) starts a new copy with
// nothing in memory, and the turn's end can still reach the old copy while
// its tool calls reach the new one, so both keep the turn here too.
const TURN = { plugin: 'status-dots', key: 'turn' } as const

// The dot this session should show; undefined for none.
let wanted: Status | undefined
let isWriting = false
// The title as last read or written, so a dot change is one call, not two.
let knownTitle: string | undefined
let writeRetry: Timer | undefined
let writeTries = 0
// Changes in a row whose writes never reached the app, retries and all.
let unreachableRuns = 0
// The title is one you set, which the app keeps.
let isUserTitle = false
let isOff = false
let questions = 0
// The turn's end-of-turn box asks you something.
let isAsking = false
// While the dot is blue: the next check for whether you've opened the session.
let seenCheck: Timer | undefined
let seenChecks = 0
// A turn has started in this process, so the start check has nothing left to do.
let hasTurned = false
// Counts the main loop's turns, so a check started for one turn knows when another began.
let turnCount = 0
// After a turn: the next look for the app's verdict on it.
let verdictCheck: Timer | undefined
let sessionId: string | undefined
let recordPath: string | undefined
let recordSearches = 0
// The record as last read, and when the file was last read for a verdict, by
// its modification time.
let loaded: { mtimeMs: number; record: AppRecord } | undefined
let recordReadAt: number | undefined

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
  // 'user' when you named the session yourself.
  titleSource?: unknown
}
type Verdict = 'waiting' | 'failed' | 'finished'

function textOf(result: McpToolResult) {
  const block = result.content.find(one => one.type === 'text') as { text?: string } | undefined
  return block?.text ?? ''
}

// An app call that didn't answer in time.
class TimedOut extends Error {
  tool: string
  constructor(tool: string) {
    super(`${tool} timed out`)
    this.tool = tool
  }
}

async function call($: Engine, server: string, tool: string, args: Record<string, unknown>) {
  let timer: Timer | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = $.clock.after(CALL_TIMEOUT_MS, () => reject(new TimedOut(tool)))
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
  if (SESSION_ID.test(session.sessionId ?? '')) sessionId ??= session.sessionId
  knownTitle = session.title?.trim() ?? ''
  return knownTitle
}

function statusOf(title: string): Status | undefined {
  return (Object.keys(DOTS) as Status[]).find(status => title.startsWith(`${DOTS[status]} `))
}

function dotted(title: string, status: Status | undefined) {
  const bare = title.replace(DOT, '')
  return status === undefined ? bare : `${DOTS[status]} ${bare}`
}

// The app answers a rename with `Renamed this session to "new" (was "old").`
function replacedTitle(answer: string) {
  const match = /\(was (".*")\)\.?\s*$/su.exec(answer)
  if (match === null) return undefined
  try {
    return JSON.parse(match[1] ?? '') as string
  } catch {
    return undefined
  }
}

// The app keeps one file per session under %LOCALAPPDATA%\Claude-Data. Looked up
// once, then reused; a few tries, since the session's id comes from the app.
// Only a search of the app's folder counts as a try.
async function findRecord($: Engine) {
  if (recordPath !== undefined || sessionId === undefined || recordSearches >= 3) return recordPath
  const local = await $.env.get('LOCALAPPDATA')
  if (!local) return undefined
  const base = `${local}/Claude-Data`
  if (!(await $.fs.exists(base))) return undefined
  recordSearches += 1
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

// The record as last read from the file, which is read again only once it has
// changed (a stat is far cheaper than reading and parsing it). Only the fields
// the mod uses are kept: the whole record is a few hundred KB in memory.
async function loadRecord($: Engine) {
  const path = await findRecord($)
  if (path === undefined) return undefined
  const { mtimeMs } = await $.fs.stat(path)
  if (loaded?.mtimeMs !== mtimeMs) {
    const full = JSON.parse(await $.fs.read(path)) as AppRecord
    const record: AppRecord = {
      lastAssistantUuid: full.lastAssistantUuid,
      postTurnSummary: full.postTurnSummary === undefined ? undefined : true,
      postTurnSummaryFor: full.postTurnSummaryFor,
      turnWrapUp: full.turnWrapUp,
      error: full.error,
      errorCategory: full.errorCategory,
      titleSource: full.titleSource,
    }
    loaded = { mtimeMs, record }
  }
  return loaded
}

// Reads the record, or with `onlyIfChanged`, only when the file has changed
// since the last verdict was taken from it.
async function readRecord($: Engine, onlyIfChanged = false) {
  try {
    const latest = await loadRecord($)
    if (latest === undefined) return undefined
    if (onlyIfChanged && latest.mtimeMs === recordReadAt) return undefined
    recordReadAt = latest.mtimeMs
    return latest.record
  } catch {
    return undefined
  }
}

// Whether you named this session yourself, by the app's record. The app holds
// any other rename of such a title for your approval, and a mod's rename can't
// carry that approval, so each try would only leave another card up.
async function isNamedByYou($: Engine) {
  try {
    return (await loadRecord($))?.record.titleSource === 'user'
  } catch {
    return false
  }
}

// The same for another session, from its record next to this one's.
async function isOtherNamedByYou($: Engine, id: string) {
  // The id becomes part of a file path, so one that isn't the app's usual
  // shape is left alone rather than looked up.
  if (!SESSION_ID.test(id)) return true
  try {
    const path = await findRecord($)
    if (path === undefined) return false
    const other = JSON.parse(await $.fs.read(`${path.slice(0, path.lastIndexOf('/'))}/${id}.json`)) as AppRecord
    return other.titleSource === 'user'
  } catch {
    return false
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

// Whether a 'finished' verdict leaves the dot as it is: green or blue already,
// or yellow for a question in the next-step box. The app records that question
// only when it stops the work, so 'finished' can't say it's gone.
function keepsFinishedDot() {
  return wanted === 'done' || wanted === 'fresh' || (wanted === 'waiting' && isAsking)
}

function applyVerdict($: Engine, verdict: Verdict) {
  if (verdict === 'finished') {
    if (!keepsFinishedDot()) void showFinished($)
    return
  }
  if (wanted === verdict) return
  stopWatching()
  show($, verdict)
}

// The app sums up a turn a few seconds after it ends. Until then the dot comes
// from the mod's own checks; once the summary is in, the app's verdict wins.
function followVerdict($: Engine, triesLeft = VERDICT_TRIES) {
  const turn = turnCount
  verdictCheck?.cancel()
  verdictCheck = $.clock.after(VERDICT_CHECK_MS, async () => {
    verdictCheck = undefined
    if (turn !== turnCount) return
    const record = await readRecord($, true)
    const verdict = record === undefined ? undefined : verdictOf(record)
    if (turn !== turnCount) return
    if (verdict !== undefined) return applyVerdict($, verdict)
    if (triesLeft > 1) followVerdict($, triesLeft - 1)
  })
}

function stopFollowing() {
  verdictCheck?.cancel()
  verdictCheck = undefined
}

function holdTurn($: Engine, turn: Turn) {
  void $.state.set(TURN, turn).catch(() => undefined)
}

async function heldTurn($: Engine) {
  try {
    return (await $.state.get(TURN)).value
  } catch {
    return undefined
  }
}

// Whether the dots are off, in this session or another one since it last
// looked. Another session's /dots off has already taken this dot away, so
// this one drops its dot and its checks rather than bring it back.
async function isTurnedOff($: Engine) {
  if (!isOff) {
    try {
      isOff = (await $.store.get('isOff')) === true
    } catch {
      return false
    }
  }
  if (!isOff) return false
  wanted = undefined
  stopWatching()
  stopFollowing()
  return true
}

// Writes the wanted dot into the title, one write at a time. A change asked for
// while a write is out is picked up when that write returns. Never throws.
async function paint($: Engine) {
  if (isWriting || isUserTitle) return
  isWriting = true
  let isReachable = true
  try {
    let status: Status | undefined
    let written: string | undefined
    // A rename that came in while a write was out: the name the dot goes onto.
    let renamed: string | undefined
    let isRenamed = false
    let redos = 0
    do {
      status = wanted
      isRenamed = false
      if (status !== undefined && (await isTurnedOff($))) status = wanted
      const title = knownTitle ?? (await titleOf($))
      if (title === undefined) return
      // No title yet. The app names a new session from its first prompt, and a
      // title written before that would stop it from doing so.
      if (title.replace(DOT, '') === '') {
        knownTitle = undefined
        return
      }
      const next = dotted(renamed ?? title, status)
      renamed = undefined
      if (next === title) continue
      if (await isNamedByYou($)) {
        knownTitle = undefined
        isUserTitle = true
        await explainOnce($)
        return
      }
      const result = await call($, SESSIONS, 'set_session_title', { session_id: 'self', title: next })
      if (result.isError) {
        knownTitle = undefined
        if (/set by the user/.test(textOf(result))) {
          isUserTitle = true
          await explainOnce($)
        }
        return
      }
      knownTitle = next
      // The app says which title it replaced. If that isn't the one this write
      // was based on (nor this paint's own last write), the session was renamed
      // in between, so the dot goes onto that name instead of bringing the old
      // one back. Once per paint, so a busy rename can't keep it looping.
      const replaced = replacedTitle(textOf(result))
      if (replaced === undefined) {
        // The answer doesn't say (the app may word it differently one day), so
        // read the title again before the next write rather than trust the cache.
        knownTitle = undefined
      } else if (replaced !== title && replaced !== written && redos < 1) {
        renamed = replaced
        isRenamed = true
        redos += 1
      }
      written = next
      // Looked at again once the write is in: dots turned off while it was out
      // take this one straight back off.
      if (status !== undefined) await isTurnedOff($)
    } while (isRenamed || status !== wanted)
  } catch (error) {
    knownTitle = undefined
    // A rename that doesn't answer is most likely held on an approval card, for
    // a title you set where the record couldn't say so. Trying again would
    // only stack more cards, so this session writes no more dots.
    if (error instanceof TimedOut && error.tool === 'set_session_title') isUserTitle = true
    // Otherwise the app's tools aren't reachable: not connected yet in a
    // process that has just started, or not there at all outside the desktop app.
    else isReachable = false
  } finally {
    isWriting = false
  }
  if (isReachable) unreachableRuns = 0
  else retryPaint($)
}

// Retries while the app's tools may still be connecting. After a few changes
// that never got through (a terminal session has no app to reach), each change
// is tried once and no more.
function retryPaint($: Engine) {
  if (writeTries >= WRITE_TRIES || unreachableRuns >= UNREACHABLE_RUNS) {
    if (writeTries >= WRITE_TRIES) unreachableRuns += 1
    return
  }
  writeTries += 1
  writeRetry?.cancel()
  writeRetry = $.clock.after(WRITE_RETRY_MS, () => {
    writeRetry = undefined
    void paint($)
  })
}

// Said once, ever, so a session without a dot isn't a mystery.
async function explainOnce($: Engine) {
  if ((await $.store.get('hasExplained')) === true) return
  await $.store.set('hasExplained', true)
  $.ui.toast("status-dots: you named this session yourself, so it gets no dot. Have Claude rename it once (you approve) and it will.")
}

// Sets the dot this session should show and starts writing it.
function show($: Engine, status: Status | undefined) {
  wanted = isOff ? undefined : status
  writeTries = 0
  void paint($)
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
    // A title you named yourself is yours, a dot in front included: renaming
    // it would put up an approval card for each one.
    if (!DOT.test(title) || (await isOtherNamedByYou($, session.sessionId))) continue
    try {
      const result = await call($, SESSIONS, 'set_session_title', {
        session_id: session.sessionId,
        title: title.replace(DOT, ''),
      })
      if (!result.isError) cleared += 1
    } catch (error) {
      // Held on an approval card: the rest would each put up another.
      if (error instanceof TimedOut) break
      throw error
    }
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
  if (isUserTitle) return
  const turn = turnCount
  const isSeen = await isOnScreen($)
  // A new turn may have started while the check was out.
  if (turn !== turnCount) return
  show($, isSeen ? 'done' : 'fresh')
  if (!isSeen) watchUntilSeen($, true)
}

function seenDelay() {
  let left = seenChecks
  for (const step of SEEN_STEPS) {
    if (left < step.checks) return step.everyMs
    left -= step.checks
  }
  return SEEN_STEPS[SEEN_STEPS.length - 1]?.everyMs ?? 15000
}

// Checks while the dot is blue, less often the longer it stays blue, and stops
// once it isn't.
function watchUntilSeen($: Engine, isNew = false) {
  if (isNew) seenChecks = 0
  seenCheck?.cancel()
  seenCheck = $.clock.after(seenDelay(), async () => {
    seenCheck = undefined
    seenChecks += 1
    if (wanted !== 'fresh') return
    const isSeen = await isOnScreen($)
    // A turn may have started while the check was out.
    if (wanted !== 'fresh') return
    if (isSeen) show($, 'done')
    else watchUntilSeen($)
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
// app's tools may not be connected yet, so the check tries again every second
// for a while, until a turn starts and takes over.
async function checkAtStart($: Engine, triesLeft: number) {
  if (hasTurned) return
  // A reload in the middle of a turn fires this again: the turn goes on, and
  // its white dot isn't one left from a run that stopped.
  const held = await heldTurn($)
  if (held?.isAsking) isAsking = true
  if (held?.isWorking) {
    hasTurned = true
    wanted = 'working'
    return
  }
  let title: string
  try {
    title = (await titleOf($)) ?? ''
  } catch {
    if (triesLeft > 0) $.clock.after(START_RETRY_MS, () => void checkAtStart($, triesLeft - 1).catch(() => undefined))
    return
  }
  if (hasTurned) return
  if (isOff) {
    if (DOT.test(title)) show($, undefined)
    return
  }
  wanted = statusOf(title)
  const record = await readRecord($)
  const verdict = record === undefined ? undefined : verdictOf(record)
  if (hasTurned) return
  // A yellow dot with a next-step box behind it came from that box's question.
  if (wanted === 'waiting' && record?.turnWrapUp !== undefined) isAsking = true
  if (verdict === 'finished' && !keepsFinishedDot()) return showFinished($)
  if (verdict !== undefined) applyVerdict($, verdict)
  // A white dot with no turn behind it is left from a run that stopped mid-turn:
  // the process ended, or the app closed without picking the turn up again. A
  // turn that resumes takes over within moments; if none does, the dot goes.
  if (wanted === 'working') {
    $.clock.after(STALE_WORKING_MS, () => {
      if (!hasTurned && wanted === 'working') show($, undefined)
    })
    return
  }
  if (wanted !== 'fresh') return
  if (await isOnScreen($)) {
    if (!hasTurned && wanted === 'fresh') show($, 'done')
  } else watchUntilSeen($, true)
}

// Back to working once nothing waits on you. Tool calls only return inside a
// turn, so this needs no turn of its own to have been seen.
function resume($: Engine) {
  if (questions === 0 && wanted === 'waiting') show($, 'working')
}

// Another session may have turned the dots off since this one last looked.
async function refreshOff($: Engine) {
  const isOffNow = (await $.store.get('isOff')) === true
  if (isOffNow === isOff) return
  isOff = isOffNow
  show($, wanted)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'dots', description: 'Turn the sidebar status dots on or off' })
    const result = await next(e)
    isOff = (await $.store.get('isOff')) === true
    void checkAtStart($, START_TRIES).catch(() => undefined)

    return result
  })

  on('turn.start', ($, e, next) => {
    if (e.agentId === undefined) {
      questions = 0
      isAsking = false
      holdTurn($, { isWorking: true, isAsking: false })
      stopWatching()
      stopFollowing()
      hasTurned = true
      turnCount += 1
      show($, 'working')
      void refreshOff($).catch(() => undefined)
    }

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId !== undefined) return result
    // A copy of the mod reloaded mid-turn may have seen the question instead.
    if ((await heldTurn($))?.isAsking) isAsking = true
    holdTurn($, { isWorking: false, isAsking })
    questions = 0
    // An answer whose next-step box asks you something leaves it your turn. A
    // question only in the reply's text doesn't: nothing on screen waits for you.
    if (e.reason === 'answer' && !isAsking) void showFinished($)
    // Stopped by you: no dot, since you were there to see it.
    else show($, e.reason === 'answer' ? 'waiting' : e.reason === 'aborted' ? undefined : 'failed')
    if (e.reason === 'answer') followVerdict($)

    return result
  })

  // A permission prompt or a question is waiting for you. There's no hook on
  // the permission check itself: the Claude directory accepts one there only
  // when it does nothing but pass the event on.
  on('classic.Notification', ($, e, next) => {
    if (e.notification_type === 'permission_prompt' || e.notification_type === 'elicitation_dialog') {
      show($, 'waiting')
    }

    return next(e)
  }).catch(($, e, next) => next(e))

  // A question or a plan to approve waits for you until its call returns; any
  // call returning moves an answered permission card back to working. When
  // Claude renames this session, the mod reads the new name before its next dot.
  on('tool.call', async ($, e, next) => {
    if (e.tool === WRAP_UP && e.agentId === undefined) {
      const ask = (e as { ask?: unknown }).ask
      if (typeof ask === 'string' && ask.trim() !== '') {
        isAsking = true
        holdTurn($, { isWorking: true, isAsking: true })
      }
    }
    const isQuestion = ASKS.has(e.tool)
    if (isQuestion) {
      questions += 1
      show($, 'waiting')
    }
    try {
      return await next(e)
    } finally {
      if (isQuestion) questions -= 1
      if (e.tool === RENAME) {
        const target = (e as { session_id?: unknown }).session_id
        if (target === 'self' || target === sessionId) {
          knownTitle = undefined
          isUserTitle = false
          show($, wanted)
        }
      }
      resume($)
    }
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'dots' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    isOff = arg === 'off' ? true : arg === 'on' ? false : !isOff
    await $.store.set('isOff', isOff)
    if (isOff) {
      stopWatching()
      stopFollowing()
      show($, undefined)
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
