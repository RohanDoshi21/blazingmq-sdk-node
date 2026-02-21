# Contributing to BlazingMQ Node.js SDK

Thank you for your interest in contributing! This document outlines the process
for contributing to this project.

## Development Setup

### Prerequisites

- **Node.js** ≥ 18.0.0
- **npm** ≥ 8.0.0
- **BlazingMQ broker** (for integration tests) — see [Running the broker](#running-the-broker)

### Getting Started

```bash
git clone https://github.com/RohanDoshi21/blazingmq-sdk-node.git
cd blazingmq-sdk-node
npm install
npm run build
```

### Running the Broker

Integration tests require a BlazingMQ broker running on `localhost:30114`:

```bash
# From the blazingmq repository root:
docker compose -f docker/single-node/docker-compose.yaml up -d
```

Ensure port 30114 is exposed in `docker/single-node/docker-compose.yaml`:
```yaml
services:
  bmqbrkr:
    ports:
      - "30114:30114"
```

## Project Structure

```
blazingmq-sdk-node/
├── src/
│   ├── protocol/         # Wire protocol encoding/decoding
│   │   ├── constants.ts  # Enums, sizes, magic numbers
│   │   └── codec.ts      # Binary encoder/decoder functions
│   ├── transport/         # TCP connection management
│   │   └── connection.ts  # BmqConnection class
│   ├── session.ts         # Core session state machine
│   ├── producer.ts        # High-level Producer API
│   ├── consumer.ts        # High-level Consumer API
│   ├── admin.ts           # High-level Admin API
│   ├── errors.ts          # Error class hierarchy
│   ├── types.ts           # TypeScript interfaces and types
│   └── index.ts           # Public API barrel export
├── tests/
│   ├── protocol.test.ts   # Unit tests for protocol codec
│   └── integration.test.ts # Integration tests (require broker)
├── docs/
│   ├── architecture.md    # SDK architecture overview
│   ├── protocol.md        # Wire protocol specification
│   ├── transport.md       # Transport layer documentation
│   └── session.md         # Session layer documentation
├── examples/
│   └── run-e2e.js         # End-to-end demo script
└── package.json
```

## Development Workflow

### Building

```bash
npm run build           # Compile TypeScript → dist/
```

### Testing

```bash
npm test                           # All tests
npm run test:unit                  # Unit tests only (no broker needed)
npm run test:integration           # Integration tests (broker required)
npm test -- --coverage             # With coverage report
```

### Linting

```bash
npm run lint            # Run ESLint
npm run lint:fix        # Auto-fix linting issues
```

### Type Checking

```bash
npx tsc --noEmit       # Type check without emitting
```

## Code Style

- **TypeScript strict mode** — all strict checks enabled.
- **Explicit types** — no implicit `any`, no unused locals/parameters.
- **JSDoc** — all public APIs must have JSDoc comments.
- **Error handling** — always use typed errors from `errors.ts`.
- **Naming** — camelCase for variables/functions, PascalCase for types/classes.

## Testing Guidelines

### Unit Tests

- Should not require a running broker.
- Test protocol encoding/decoding with known byte sequences.
- Test edge cases: empty buffers, maximum sizes, invalid inputs.

### Integration Tests

- Require a running BlazingMQ broker on `localhost:30114`.
- Clean up after themselves (close queues, stop sessions).
- Use unique queue URIs to avoid interference between tests.
- Set appropriate timeouts (15-45 seconds for broker operations).

## Pull Request Process

1. Fork the repository and create a feature branch.
2. Make your changes with appropriate tests.
3. Ensure all tests pass: `npm test`.
4. Ensure the build succeeds: `npm run build`.
5. Ensure no type errors: `npx tsc --noEmit`.
6. Submit a pull request with a clear description of your changes.

## Commit Messages

Follow [Conventional Commits](https://www.conventionalcommits.org/):

```
feat: add compression support for message properties
fix: handle broker disconnect during queue close
docs: improve protocol documentation
test: add edge case tests for CRC32-C
refactor: extract padding utilities into separate module
```

## Architecture Decisions

Before making significant changes, please read the [architecture documentation](./docs/architecture.md)
to understand the layered design and its constraints. Key principles:

- **Each layer has a clear responsibility** — don't mix protocol encoding into session logic.
- **No native dependencies** — keep the SDK pure JavaScript/TypeScript.
- **Event-driven** — use Node.js EventEmitter patterns for async communication between layers.
- **Typed errors** — all errors must extend `BlazingMQError`.

## License

By contributing, you agree that your contributions will be licensed under the
Apache-2.0 License.
