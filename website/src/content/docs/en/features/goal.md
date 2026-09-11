---
title: Goal mode
description: Give a completion condition; it is checked at the end of every turn until it holds.
---

`/goal <condition>` sets a completion condition, and the condition text goes out immediately as the first turn's instruction. After that, **at the end of every turn** a separate model call decides whether the condition holds: if it does, the work is done; if not, the reasoning from that verdict becomes the next turn's instruction, and so on until it holds or a brake trips.

```
/goal get npm test passing without touching any test file
/goal                # show state: condition, turns, elapsed, tokens, latest verdict
/goal clear          # cancel (stop / off / reset / none / cancel are synonyms)
```

The more verifiable the condition, the better: the evaluator can only read the conversation transcript and cannot run commands itself, so "`npm test` exits 0", where the output is visible in the record, is far more reliable than "the code gets better". It is also explicitly instructed to rule "not met" whenever the record shows no evidence - the model saying "that should pass" does not count.

## Brakes

Three of them; any one releases the goal rather than leaving it to start running again the next time you speak:

- `goalMaxTurns` (10 turns by default). An unattended loop needs a ceiling; raise it for long jobs, up to 100.
- An `esc` interrupt, or a turn ending in an error. It does not retry a session that was killed or 401ed.
- Two consecutive unintelligible verdicts. A broken evaluator and genuinely unfinished work cannot be treated as the same thing.

## While the loop runs

The session counts as busy for the whole chain, and the status line above the input box reads "goal 3/10 · 12s". Sending a message here does not interrupt the loop: it becomes guidance for the next turn, fed to the model alongside the evaluator's instruction, so you can correct course at any time. `esc` stops the whole loop.

## Persistence

An unfinished goal is saved with the session (an extension custom record) and carried along by `/fork`. When `mojocode -c` resumes it, the goal is "set but does not start on its own": the status line reads "goal pending", the turn count, timer and token baseline all reset, and one message is needed to carry on. Opening an old session should not burn a turn out of nowhere.

| Key | Default | Notes |
|---|---|---|
| `goalModel` | the session's current model | model id used by the evaluator, on the current provider. It reads one transcript and answers two lines, so a cheap small model brings the extra cost close to zero; `MOJOCODE_GOAL_MODEL` overrides it |
| `goalMaxTurns` | `10` | how many turns it may auto-continue for, capped at 100 |

`/goal` is an extension (`src/extensions/goal/`) and the acceptance test for the hook layer: evaluate in `turn_end`, continue with `followUp`, and catch an interrupt between the two turns with `aborted` in `agent_end`.
