# Chapter 1: The Problem & The Solution

## The "Why"
Historically, scheduling tasks in Node.js (via `setInterval` or `node-cron`) works perfectly on a single developer machine. However, the moment you deploy your application to a massive horizontal server cluster (e.g., Kubernetes with 50 pods), **every single pod runs the same `setInterval`**. If that interval happens to send a billing invoice to a customer, your customer gets billed 50 times simultaneously!

To securely fix this double-execution problem historically, developers are forced to manually install massive message brokers like RabbitMQ or heavy Redis-Queue abstractions, which require extensive DevOps configuration, manual queue declarations, and complex polling logic spread across thousands of lines of boilerplate.

## The OqronKit Solution
OqronKit is a **Zero-Config, Self-Healing, Multi-Tenant Job Processing Scheduler.** 

- **Automatic Leader Election:** It automatically designates one single server as the "Master Poller" natively. No matter how many pods boot up, only one calculates due tasks, dramatically dropping CPU utilization globally.
- **Distributed Locks:** Even if the Leader fails and two servers simultaneously try to execute the exact same job, OqronKit places a microsecond lock on the underlying persistence layer (Database/Redis), mathematically guaranteeing only ONE worker begins executing the logic.
- **Zero-Boilerplate:** You don't create queues. You don't wire up topics. You simply define `.ts` files inside a `/jobs` folder, and OqronKit maps, discovers, and executes them entirely out-of-the-box.
