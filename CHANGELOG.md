# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - 2026-02-21

### Added
- Initial release of the BlazingMQ Node.js SDK.
- Pure TypeScript implementation of the BlazingMQ wire protocol over TCP.
- **Session API** — low-level interface for connection, negotiation, queue operations.
- **Producer API** — high-level interface for publishing messages with ACK support.
- **Consumer API** — high-level interface with callback and async iterator patterns.
- **Admin API** — queue management, inspection, and health checking.
- Full message properties support (BOOL, CHAR, SHORT, INT32, INT64, STRING, BINARY).
- CRC32-C (Castagnoli) data integrity checksums.
- ZLIB compression for large payloads.
- Automatic heartbeat response.
- Reconnection with exponential backoff.
- Typed error hierarchy (BlazingMQError, BrokerTimeoutError, ConnectionError, etc.).
- Comprehensive unit tests for protocol codec.
- Integration tests against a live BlazingMQ broker.
- Full documentation: architecture, protocol spec, transport layer, session layer.
