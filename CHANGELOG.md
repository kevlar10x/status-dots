# Changelog

Tested on Claude Code 2.1.308 with desktop app 3.6556 (Windows).

## Unreleased

- The README's screenshot now shows green and yellow dots, not only green.

## 0.6.0 - 2026-10-27

- Faster dots. The mod no longer makes a turn or a question card wait while it writes the title, and once it knows a session's title, a dot change is a single call to the app.
- A dot that couldn't be written while the app's tools were still connecting, in a session that had just started, is tried again every second. Before, it stayed wrong for that whole turn.
- Blue turns green within a second of opening a session. A blue dot left alone checks less often over time: every 4 seconds, then every 15 seconds after about 5 minutes.
- After a turn, the app's file is read again only when it has changed.
- A session that stopped in the middle of a turn loses its white dot after 10 seconds instead of 20.
- Sessions you named yourself, and terminal sessions, no longer try to write a dot on every turn.
- If something else renames a session between two dot changes, the dot moves onto the new name instead of bringing the old one back.

## 0.5.1 - 2026-10-27

- A white dot left by a session that stopped in the middle of a turn now goes away when the session starts again and no turn picks up.
- The README says that sessions already open pick the mod up after a restart, and that a permission card can leave the dot white.

## 0.5.0 - 2026-10-27

- A session that's working now shows a white dot, so every session in the list has one. Before, a working session had no dot and only the app's own grey dot on the right showed it.
- After you answer a question card, the dot goes back to white while Claude carries on.

## 0.4.1 - 2026-10-27

- Yellow now means something in the session is waiting for you on screen: a question card, a plan to approve, a permission prompt, or a question in the app's next-step box. A reply that only asks in its text, or that the app's summary reads as waiting on you, no longer turns yellow.
- Red comes only from an error that ended the turn, not from the app's summary saying the work went wrong.
- A yellow dot that 0.4.0 set from the summary's guess goes back to green or blue the next time that session starts.

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
