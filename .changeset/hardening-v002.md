---
"oqronkit": patch
---

Hardening release — 19 crash-safety, consistency, and correctness fixes across Queue, Worker, Webhook, Scheduler, and Manager engines. Key improvements: stall recovery now properly releases concurrency slots, cancel operations write audit tombstones, retry/rerun preserves job priority, webhook cancellation aborts in-flight HTTP, and graceful shutdown no longer leaks timers.
