# Changelog

Tested on Claude Code 2.1.308 with desktop app 3.6556 (Windows).

## Unreleased

- The README's screenshot now shows green and yellow dots, not only green.

## 0.4.0 - 2026-10-27

- Better status detection: a few seconds after a turn ends, the dot follows the app's own summary of that turn, the one its sidebar uses. A reply that leaves you something to do now gets yellow even when it doesn't end on a question, and a turn the app counts as failed gets red.
- A session whose end-of-turn dot was missed gets it when the session starts again.
- A call to the app that doesn't answer now gives up after 10 seconds, so one stuck call can't stop the dots in that session.
- The README's list of hooked events is whole again. The `session.start` line had slipped below the note that follows it.
- The README links the other kevlar10x mods.
- The plugin listing has a display name, an icon and a short description.

## 0.3.1 - 2026-10-27

- Fixed: a session whose process had just started could go without dots until it restarted, because the app's tools weren't connected yet when the mod first looked at the title. A failed call now skips only that one change, and the check at start tries again for up to 30 seconds.

## 0.3.0 - 2026-10-27

- A session that finishes while you aren't looking at it now gets a blue dot. It turns green once you open the session, so the list shows which finishes you haven't seen yet.
- The README has a screenshot of the sidebar with the dots.

## 0.2.1 - 2026-10-27

- The mod no longer hooks permission checks, so it never takes part in a permission decision. Permission prompts still turn the dot yellow through Claude Code's notification event.
- The README says exactly which tools the mod calls, what it reads and what it sends.

## 0.2.0 - 2026-10-27

- The colors now read like a traffic light: red when an error stopped Claude, yellow when it's your turn, green when it's done and needs nothing from you.
- A turn that ends by asking you something (the app's next-step box) now gets yellow instead of white, since it's waiting on you too. Old white dots change the next time the session works.
- A reply whose last line is a question also gets yellow, so a question asked in plain text doesn't hide behind a green dot.
- A yellow dot now stays when the app restarts, because that session still needs you.

## 0.1.0 - 2026-10-27

- First release. Each session's title in the desktop app's sidebar starts with a dot: yellow while Claude waits for you, green when it finished with an answer, white when it finished and suggested a next step, red when an error or a refusal stopped it.
- While Claude works the title has no dot, and the app's own grey dot shows instead.
- Titles you named yourself are left alone, and a one-time note says why.
- `/dots off` takes the dots off every session and keeps them off; `/dots on` brings them back.
