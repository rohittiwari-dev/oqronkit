# Chapter 5: Roadmap & Future Expansion Planning

While the v1 Architecture stabilizes the precise microservices logic natively utilizing SQLite pushdowns and `ILockAdapter` proxying for namespace boundaries, the OqronKit team is fundamentally targeting the following enterprise goals for `v1.0.0-stable`:

## 🚀 Priority Implementations (Planned)

### 1. `PostgresAdapter` Database Extension
Utilizing PostgreSQL `FOR UPDATE SKIP LOCKED` logic natively. This natively unlocks raw execution concurrency constraints across horizontal deployments without actively demanding a centralized Redis lock cluster architecture! It virtually guarantees the elimination of standard "Lock Wait Timeout" microsecond errors inside environments sustaining upwards of 5,000+ RPS scheduling operations natively.

### 2. `RedisLockAdapter` Redlock Standardization
Transitioning the current ephemeral Memory lock algorithms natively toward a robust **Redlock Definition** integration for the core `ILockAdapter`. This guarantees locking integrity safely across multi-region high-availability server grids (e.g., AWS ElastiCache).

### 3. Deep Telemetry Dashboards (Grafana Bridge)
The internal generic `OqronEventBus` will be dynamically expanded out strictly to automatically stream Prometheus Counters structurally (`oqronkit_jobs_active`, `oqronkit_execution_lag`, `oqronkit_duration_ms`). Express routers can natively mount `/api/oqron/metrics` to securely stream metric topologies instantly inside visualization tooling contexts.

### 4. Rate-Limiting & Output Throttling
Currently natively constrained by system IO thresholds, future `v1.0.0` goals mathematically enforce `guaranteedWorker` thresholds (e.g., `maxConcurrent: 5`) explicitly inside the Adapter interfaces. This fundamentally prevents achrono scheduled DB fetches from rapidly bursting and aggressively destroying external downstream Webhook dependencies!

---

## 💡 Evaluated Active Ideation (Unplanned Goals)

### External Orchestration Wrappers
- **Oqron UI App (`@oqronkit/ui`):** A beautiful standalone Next.js-driven Server-Side-Rendered dashboard package mapped cleanly to visually pause, legally execute (`trigger({ payload: '' })`), and explicitly drill down into the real-time payload definitions of precisely what logic represents `oqron_schedules` internally without coding an SQL proxy.
- **Kafka / RabbitMQ Sub-Topics:** Extending `IOqronAdapter` logic interfaces externally to flush high-throughput delay executions identically against Enterprise Kafka streams rather than maintaining heavy relational SQL persistence requirements!
