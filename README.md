# OqronKit Monorepo

Welcome to the **OqronKit** monorepo—the enterprise-grade, zero-config cron and job scheduling framework for Node.js. 

This repository is powered by [Turborepo](https://turbo.build/) and [Bun](https://bun.sh/) for lightning-fast compilation and workspace management.

## 📦 Workspace Structure

- `packages/oqronkit`: The core, framework-agnostic scheduling library. Includes native support for distributed locking, SQLite persistence, and declarative configuration.
- `apps/backend`: A fully-functional Express application demonstrating how to integrate OqronKit into a production API, including dynamic dynamic routing and job registration.

## 🚀 Getting Started

### Prerequisites
- Node.js 18+ or Bun 1.x+
- (Optional) Redis, if you are planning to test the Redis clustering adapters natively.

### Installation
Clone the repository and install the dependencies natively using Bun workspaces:

```bash
git clone https://github.com/your-org/oqronkit.git
cd oqronkit
bun install
```

### Development
To instantly start the TypeScript compiler in watch mode and spin up the backend demo server concurrently:

```bash
bun run dev
```

### Build Everything
To compile the core library (`esm` and `cjs` formats) and generate TypeScript definitions:

```bash
bun run build
```

## 🧪 Running Tests
The core package is fully covered with test suites verifying leader election, scheduling math, and multi-tenant constraints.

```bash
bun run test
```

## 📖 Documentation
- For detailed **NPM Package Documentation**, refer to [packages/oqronkit/README.md](./packages/oqronkit/README.md)
- For the **Application Demo Walkthrough**, refer to [apps/backend/README.md](./apps/backend/README.md)
