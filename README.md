# status-dots

A Claude Code mod for the Claude desktop app. It puts a colored dot in front of each session's title in the Code tab's sidebar, so you can tell how a session ended without opening it.

| Dot | The session |
|---|---|
| 🟡 | is waiting for you: a question, a plan to approve or a permission card |
| 🟢 | finished with an answer |
| ⚪ | finished and suggested a next step for you to pick |
| 🔴 | was stopped by an error or a refusal |
| no dot | is working (the app's own grey dot shows that), or you stopped it yourself |

The app's own dot tells you a session is working, needs you or has something unread. Once you've opened a finished session, its dot goes away and the list no longer says how it ended. With several sessions running, status-dots keeps that in view.

Mods can't recolor the app's own dot. The title is the one part of the sidebar a mod can change, so the dot goes there.

## Install

At the prompt of a terminal session:

```
/plugin install status-dots --marketplace kevlar10x/status-dots
```

Answer `y` to add the marketplace, then pick the user scope.

From a shell:

```bash
claude plugin install status-dots --marketplace kevlar10x/status-dots
```

In the desktop app, where `/plugin` doesn't run: click **+** next to the prompt box, then **Plugins**, **Add marketplace** with `kevlar10x/status-dots`, then **Add plugin**.

It needs a Claude Code version that runs mods. It was built and tested on Claude Code 2.1.308 with desktop app 3.6556 on Windows. Terminal sessions have no sidebar, so there it does nothing.

## Turning it off

`/dots off` takes the dot off this session and every other session that has one, and keeps the dots off everywhere. `/dots on` turns them back on, and each session gets its dot the next time Claude finishes there.

Run `/dots off` before you uninstall, or the titles keep their last dot.

## Things to know

- Sessions you named yourself get no dot. The app won't let anything change a title you typed unless you approve it, and a mod has no way to ask. If you want a dot on one of them, ask Claude to rename it and approve that once. The mod explains this in a short note the first time it happens.
- A new session gets its first dot when Claude finishes its first turn. The mod leaves a title alone until the app has named the session, so the app's naming still works.
- Once a session has a dot, the app counts its title as set and stops renaming that session on its own, for example to a pull request's title.
- After you approve a permission card, the dot stays yellow until that tool call is done.
- The title moves over a little when its dot comes and goes.

## Privacy

The mod reads this session's title from the desktop app and writes it back through the app's own rename tool. When you run `/dots off`, it also reads your other sessions' titles to take their dots off. It keeps two values in its own storage on your computer: whether the dots are off, and whether it has shown its one-time note. It makes no network requests and starts no programs. The app may record title changes in its own usage data, as it does for any rename.

## What it calls and hooks

It calls the desktop app's session tools (`ccd_session_mgmt`) without Claude asking for them:

- `get_session` and `set_session_title` for the session it runs in, when the dot changes.
- `list_sessions` and `set_session_title` for your other sessions, only when you run `/dots off`.

It hooks these events and passes each one on unchanged:

- `turn.start` and `turn.complete`: the dot goes away while Claude works, then turns green, white or red when the turn ends. Subagents' turns are skipped.
- `tool.call`: yellow while `AskUserQuestion` or `ExitPlanMode` waits for you, and white when the app's end-of-turn box (`wrap_up`) carries a question for you.
- `classic.PermissionRequest` and `classic.Notification`: yellow while a permission card is up.
- `session.start`: registers `/dots` and clears a yellow dot left over from a session that closed mid-turn.

## Limits

- Tested on Windows only.
- Yellow for questions has been seen working in the desktop app. Yellow for permission cards hasn't been seen live yet. The app's own dot turns yellow for those either way.

## Uninstall

Run `/dots off` first, then:

```bash
claude plugin uninstall status-dots
```

## License

MIT, by kevlar10x. The original is at https://github.com/kevlar10x/status-dots.

If you'd like to leave a tip: https://ko-fi.com/kevlar10x
