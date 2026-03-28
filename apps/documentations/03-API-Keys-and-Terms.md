# Chapter 3: API Keys & Term Definitions

When defining intensely controlled jobs (`cron` or `schedule`), you command access to Enterprise-grade execution strictness.

## Timeline Triggers
`every`
An object `{ hours: 1, seconds: 30 }`. It defines a basic recurring temporal loop execution relative to the current clock.

`runAfter`
*(Schedules exclusively)*. An object natively mapping `{ days: 3 }` that delays the persistent sleep logic based exactly on the Microsecond moment `.schedule()` is called. Perfect for relative delay logic.

`runAt`
*(Schedules exclusively)*. A highly explicit, mathematically accurate `Date(Date.now() + 3000)` object triggering explicitly in the future.

`rrule`
An industry-standard RRULE specification format (e.g., `FREQ=WEEKLY;INTERVAL=2;BYDAY=TU,TH`). Engineered for mapping extremely deep "Every 3rd Tuesday of November pending the phase of the Moon" execution logic natively.

---

## Collision Avoidance Security (Concurrency)

`overlap` (`"skip" | "run"`)
What happens if Job-A takes 3 entire minutes to cleanly execute, but it was recklessly configured to run `every: { minutes: 1 }`?
- **`skip`** (Default Engine Safe-Mode): OqronKit checks the persistent State of the previous Job-A ID. If the last lock hasn't been destroyed natively, it completely aborts compiling this minute. Ensures zero race conditions for data-mutation sweeps (e.g., Bulk Invoice Emails).
- **`run`**: Instructs the Oqron engine to forcefully allocate a secondary CPU thread and concurrently process identical logic dynamically.

---

## Server Crash Resilience Algorithms

`missedFire` (`"skip" | "discard" | "run_now" | "run_all"`)
What logically happens if a critical `cron` execution is strictly mapped for 3:00 AM UTC, but your AWS `us-east-1` cluster entirely panicked at 2:50 AM and didn't formally recover online until 5:00 AM?
- **`run_now`**: The millisecond Node.js successfully remounts at 5:00 AM, the Engine evaluates the downtime delta, realizes the deadline was missed, and forcefully executes instantly.
- **`skip`**: Instructs the logic to simply acknowledge the downtime peacefully, calculate the next relative polling cycle (e.g., 3:00 AM tomorrow), and delay execution statically.
- **`run_all`**: Accumulates the missed polling window dynamically and recursively dispatches N backlogs simultaneously (Use strictly with caution to avoid DDOSing external APIs!)

---

## Auditing, Limits & System Health Protections

`keepHistory` / `keepFailedHistory`
Instead of allowing bloated DB SQL files to infinitely append completed jobs forever, standardizing a `keepHistory: 100` setting maps OqronKit natively deleting prior completed database IDs recursively off the disk.

`timeout`
(Milliseconds Default Constraint). If a poorly written developer API function dynamically hangs essentially forever inside your `handler`, OqronKit intelligently revokes the CPU Execution scope and forcibly fails the context after the threshold is hit natively.

`heartbeatMs`
(Milliseconds Native Pings). Critical for ultra-long 6-hour video rendering operations. The operating Node worker "pings" the external SQL database row every X milliseconds signaling its alive status. If the ECS container collapses without sending an exit code, OqronKit identifies the silenced heartbeat dynamically and allows another active secondary Node server to seize and structurally restart the job safely!
