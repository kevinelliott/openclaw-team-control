# Team Control 🤖

Unified dashboard for managing Clawdbot agents across multiple gateways.

## Features

- **Multi-Gateway Support**: Connect and monitor multiple Clawdbot instances
- **Auto-Discovery**: Automatically find gateways on your local network
- **Manual Registration**: Add gateways via URL + optional auth token
- **Persistent Storage**: Gateway configs saved to `data/gateways.json`
- **Health Polling**: Continuous monitoring of gateway status
- **Real-time Updates**: WebSocket-based live updates
- **Agent Overview**: See all agents, their status, and current sessions

## Quick Start

```bash
# Install dependencies
npm run setup

# Start development (server + client)
npm run dev
```

Open http://localhost:3335 (or http://localhost:3335 for production build)

## Gateway Discovery

Team Control uses **polling** to monitor gateways (not the other way around):

1. **Auto-Discovery**: Click "Discover" to scan local network (localhost ports 18789, 3000, 8080)
2. **Manual**: Add gateways by URL (http:// or ws://) with optional auth token
3. **UDP Broadcast**: Listens on port 18790 for gateway announcements

### Connecting a Gateway

```bash
# Example: Add local gateway
curl -X POST http://localhost:3335/api/gateways \
  -H 'Content-Type: application/json' \
  -d '{"url":"http://localhost:18789","name":"My Gateway"}'

# Example: Add with auth token
curl -X POST http://localhost:3335/api/gateways \
  -H 'Content-Type: application/json' \
  -d '{"url":"http://localhost:18789","name":"Prod","token":"secret"}'
```

## Architecture

```
┌─────────────────────────────────────────────┐
│               Team Control                  │
├─────────────────────────────────────────────┤
│  Express Server (3334)                      │
│    ├── REST API                             │
│    ├── Socket.IO (client updates)           │
│    └── Gateway Manager                      │
│         ├── WebSocket to each gateway       │
│         ├── Health polling (10s)            │
│         ├── Auto-reconnect                  │
│         └── Persistent storage              │
├─────────────────────────────────────────────┤
│  React Client (3335 dev / 3334 prod)        │
│    └── Socket.IO for realtime updates       │
└─────────────────────────────────────────────┘
         │                   │
         ▼                   ▼
┌─────────────┐       ┌─────────────┐
│  Gateway 1  │       │  Gateway 2  │
│  (18789)    │       │  (18790)    │
│   ├ Agent A │       │   ├ Agent C │
│   └ Agent B │       │   └ Agent D │
└─────────────┘       └─────────────┘
```

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | /api/gateways | List all connected gateways |
| POST | /api/gateways | Register a new gateway |
| DELETE | /api/gateways/:id | Remove a gateway |
| POST | /api/gateways/discover | Trigger auto-discovery |
| GET | /api/agents | List all agents across gateways |
| GET | /api/agents?gatewayId=X | Filter agents by gateway |
| GET | /api/stats | Aggregate statistics |
| GET | /api/health | Server health check |

## WebSocket Events

**Client → Server:**
- `refresh` - Request full state sync
- `discover` - Trigger auto-discovery

**Server → Client:**
- `sync` - Full state on connect
- `gateway:added` - New gateway registered
- `gateway:removed` - Gateway disconnected
- `gateway:update` - Gateway status change
- `agent:update` - Agent status change
- `agent:removed` - Agent disconnected
- `discovery:complete` - Auto-discovery results

## Data Storage

Gateway configurations are persisted in `data/gateways.json`:

```json
{
  "version": 1,
  "savedAt": "2025-01-30T...",
  "gateways": [
    {
      "id": "gw-abc123",
      "url": "http://localhost:18789",
      "name": "Local Gateway",
      "token": null,
      "autoDiscovered": false,
      "createdAt": "2025-01-30T..."
    }
  ]
}
```

## Integration with Mission Control

Team Control can be used standalone or alongside Mission Control. When both are running:
- Agent activity can be linked to Mission Control tasks
- Session logs can reference card IDs
- Unified project context across tools

---

Built by Henry 🗿
