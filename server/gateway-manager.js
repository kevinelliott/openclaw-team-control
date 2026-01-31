/**
 * Gateway Manager - Handles discovery, registration, and health monitoring
 * 
 * Design: Team Control POLLS gateways (gateways don't register themselves)
 * - Auto-discover gateways on local network via mDNS
 * - Manual registration (URL + token)
 * - Persistent storage in JSON file
 * - WebSocket connections for realtime agent updates
 * - Health check polling for each gateway
 * 
 * Uses Clawdbot Gateway Protocol v3
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const WebSocket = require('ws');
const crypto = require('crypto');
const dgram = require('dgram');
const EventEmitter = require('events');

const DATA_DIR = path.join(__dirname, '../data');
const GATEWAYS_FILE = path.join(DATA_DIR, 'gateways.json');
const HEALTH_INTERVAL = 10000;  // 10 seconds
const DISCOVERY_PORT = 18790;   // UDP broadcast port for discovery
const RECONNECT_DELAY = 5000;   // 5 seconds before reconnect attempt
const PROTOCOL_VERSION = 3;     // Clawdbot gateway protocol version

class GatewayManager extends EventEmitter {
  constructor() {
    super();
    this.gateways = new Map();  // id -> gateway config + state
    this.connections = new Map(); // id -> WebSocket connection
    this.pendingRequests = new Map(); // id -> Map(requestId -> { resolve, reject, timeout })
    this.healthTimers = new Map(); // id -> interval timer
    this.agents = new Map();    // agentId -> agent data
    this.discoverySocket = null;
    this._ensureDataDir();
    this._loadGateways();
  }

  _ensureDataDir() {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
  }

  _loadGateways() {
    try {
      if (fs.existsSync(GATEWAYS_FILE)) {
        const data = JSON.parse(fs.readFileSync(GATEWAYS_FILE, 'utf8'));
        for (const gw of data.gateways || []) {
          // Reset runtime state on load
          gw.status = 'disconnected';
          gw.lastSeen = null;
          gw.agents = [];
          this.gateways.set(gw.id, gw);
        }
        console.log(`📂 Loaded ${this.gateways.size} gateways from storage`);
      }
    } catch (err) {
      console.error('Failed to load gateways:', err.message);
    }
  }

  _saveGateways() {
    try {
      const data = {
        version: 1,
        savedAt: new Date().toISOString(),
        gateways: Array.from(this.gateways.values()).map(gw => ({
          id: gw.id,
          url: gw.url,
          name: gw.name,
          token: gw.token,
          autoDiscovered: gw.autoDiscovered || false,
          createdAt: gw.createdAt
        }))
      };
      fs.writeFileSync(GATEWAYS_FILE, JSON.stringify(data, null, 2));
    } catch (err) {
      console.error('Failed to save gateways:', err.message);
    }
  }

  /**
   * Register a new gateway (manual or auto-discovered)
   */
  addGateway({ url, name, token, autoDiscovered = false }) {
    // Normalize URL
    url = this._normalizeUrl(url);
    
    // Check for duplicate URL
    for (const [id, gw] of this.gateways) {
      if (gw.url === url) {
        console.log(`⚠️ Gateway already registered: ${url}`);
        return gw;
      }
    }

    const id = `gw-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const gateway = {
      id,
      url,
      name: name || this._deriveGatewayName(url),
      token: token || null,
      autoDiscovered,
      status: 'connecting',
      lastSeen: null,
      lastError: null,
      agents: [],
      createdAt: new Date().toISOString(),
      healthChecks: { success: 0, failure: 0 },
      serverInfo: null  // Will be populated from hello-ok
    };

    this.gateways.set(id, gateway);
    this._saveGateways();
    this.emit('gateway:added', this._sanitizeGateway(gateway));

    // Start monitoring
    this._connectToGateway(id);
    this._startHealthCheck(id);

    console.log(`✅ Added gateway: ${gateway.name} (${url})`);
    return this._sanitizeGateway(gateway);
  }

  /**
   * Remove a gateway
   */
  removeGateway(id) {
    const gateway = this.gateways.get(id);
    if (!gateway) return false;

    // Cleanup
    this._stopHealthCheck(id);
    this._disconnectGateway(id);
    
    // Remove agents associated with this gateway
    for (const [agentId, agent] of this.agents) {
      if (agent.gatewayId === id) {
        this.agents.delete(agentId);
        this.emit('agent:removed', { id: agentId });
      }
    }

    this.gateways.delete(id);
    this._saveGateways();
    this.emit('gateway:removed', { id });

    console.log(`🗑️ Removed gateway: ${gateway.name}`);
    return true;
  }

  /**
   * Get all gateways (sanitized - no tokens)
   */
  getGateways() {
    return Array.from(this.gateways.values()).map(gw => this._sanitizeGateway(gw));
  }

  /**
   * Get all agents from all gateways
   */
  getAgents() {
    return Array.from(this.agents.values());
  }

  /**
   * Public method to send a request to a gateway
   */
  async sendRequest(gatewayId, method, params, timeoutMs = 10000) {
    return this._sendRequest(gatewayId, method, params, timeoutMs);
  }

  /**
   * Generate unique request ID
   */
  _generateRequestId() {
    return crypto.randomUUID();
  }

  /**
   * Connect to a gateway via WebSocket using Clawdbot protocol
   */
  _connectToGateway(id) {
    const gateway = this.gateways.get(id);
    if (!gateway) return;

    // Close existing connection
    this._disconnectGateway(id);

    const wsUrl = this._toWebSocketUrl(gateway.url);
    console.log(`🔌 Connecting to gateway: ${gateway.name} (${wsUrl})`);

    try {
      // Clawdbot protocol doesn't use Authorization header - auth is in connect frame
      const ws = new WebSocket(wsUrl, { 
        handshakeTimeout: 5000,
        maxPayload: 25 * 1024 * 1024  // 25MB for large responses
      });

      // Initialize pending requests map for this gateway
      this.pendingRequests.set(id, new Map());

      ws.on('open', () => {
        console.log(`🔗 WebSocket open, sending connect frame to: ${gateway.name}`);
        this._sendConnectFrame(id);
      });

      ws.on('message', (data) => {
        try {
          const msg = JSON.parse(data.toString());
          this._handleGatewayMessage(id, msg);
        } catch (err) {
          console.error(`Failed to parse message from ${gateway.name}:`, err.message);
        }
      });

      ws.on('error', (err) => {
        console.error(`Gateway ${gateway.name} error:`, err.message);
        this._updateGatewayStatus(id, 'error', err.message);
      });

      ws.on('close', (code, reason) => {
        const reasonStr = reason?.toString() || '';
        console.log(`❌ Gateway ${gateway.name} disconnected (${code}) ${reasonStr}`);
        this._updateGatewayStatus(id, 'disconnected');
        this.connections.delete(id);
        
        // Clear pending requests
        const pending = this.pendingRequests.get(id);
        if (pending) {
          for (const [reqId, req] of pending) {
            clearTimeout(req.timeout);
            req.reject(new Error(`Connection closed: ${code}`));
          }
          pending.clear();
        }
        
        // Schedule reconnect
        setTimeout(() => {
          if (this.gateways.has(id)) {
            this._connectToGateway(id);
          }
        }, RECONNECT_DELAY);
      });

      this.connections.set(id, ws);
    } catch (err) {
      console.error(`Failed to connect to ${gateway.name}:`, err.message);
      this._updateGatewayStatus(id, 'error', err.message);
    }
  }

  /**
   * Send Clawdbot protocol connect frame
   */
  _sendConnectFrame(id) {
    const gateway = this.gateways.get(id);
    if (!gateway) return;

    const connectParams = {
      minProtocol: PROTOCOL_VERSION,
      maxProtocol: PROTOCOL_VERSION,
      client: {
        id: 'clawdbot-control-ui',  // Valid Clawdbot client ID
        displayName: 'Team Control Dashboard',
        version: '1.0.0',
        platform: process.platform,
        mode: 'ui'  // Valid mode for UI clients
      },
      caps: ['sessions.list', 'agents.list', 'sessions.subscribe'],
      role: 'operator',
      scopes: ['operator.read', 'operator.write', 'operator.admin'],
      auth: gateway.token ? { token: gateway.token } : undefined
    };

    this._sendRequest(id, 'connect', connectParams)
      .then((helloOk) => {
        console.log(`✅ Connected to gateway: ${gateway.name} (protocol v${helloOk.protocol})`);
        gateway.serverInfo = helloOk.server;
        this._updateGatewayStatus(id, 'online');
        
        // Request sessions/agents list
        this._sendRequest(id, 'sessions.list', {}).then(result => {
          if (result?.sessions) {
            this._updateSessionsFromGateway(id, result.sessions);
          }
        }).catch(err => {
          console.log(`Failed to get sessions from ${gateway.name}:`, err.message);
        });
      })
      .catch((err) => {
        console.error(`Failed to connect to ${gateway.name}:`, err.message);
        this._updateGatewayStatus(id, 'error', err.message);
      });
  }

  /**
   * Send a request frame and wait for response
   */
  _sendRequest(id, method, params, timeoutMs = 10000) {
    return new Promise((resolve, reject) => {
      const ws = this.connections.get(id);
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        return reject(new Error('WebSocket not connected'));
      }

      const requestId = this._generateRequestId();
      const frame = {
        type: 'req',
        id: requestId,
        method,
        params
      };

      const timeout = setTimeout(() => {
        const pending = this.pendingRequests.get(id);
        if (pending) pending.delete(requestId);
        reject(new Error(`Request timeout: ${method}`));
      }, timeoutMs);

      const pending = this.pendingRequests.get(id);
      if (pending) {
        pending.set(requestId, { resolve, reject, timeout });
      }

      ws.send(JSON.stringify(frame));
    });
  }

  /**
   * Handle messages from gateway WebSocket
   */
  _handleGatewayMessage(gatewayId, msg) {
    const gateway = this.gateways.get(gatewayId);
    if (!gateway) return;

    // Handle response frames
    if (msg.type === 'res') {
      const pending = this.pendingRequests.get(gatewayId);
      if (pending && pending.has(msg.id)) {
        const req = pending.get(msg.id);
        clearTimeout(req.timeout);
        pending.delete(msg.id);

        if (msg.ok) {
          req.resolve(msg.payload);
        } else {
          req.reject(new Error(msg.error?.message || 'Request failed'));
        }
      }
      return;
    }

    // Handle event frames
    if (msg.type === 'event') {
      this._handleGatewayEvent(gatewayId, msg.event, msg.payload);
      return;
    }

    // Handle hello-ok (legacy compatibility)
    if (msg.type === 'hello-ok') {
      // This shouldn't happen in normal flow, but handle it
      gateway.serverInfo = msg.server;
      this._updateGatewayStatus(gatewayId, 'online');
      return;
    }

    // Unknown frame type
    console.log(`Unknown frame type from ${gateway.name}:`, msg.type);
  }

  /**
   * Handle event frames from gateway
   */
  _handleGatewayEvent(gatewayId, event, payload) {
    const gateway = this.gateways.get(gatewayId);
    if (!gateway) return;

    switch (event) {
      case 'tick':
        // Heartbeat tick from gateway
        this._updateGatewayStatus(gatewayId, 'online');
        break;

      case 'session:update':
      case 'session:created':
        this._updateSession(gatewayId, payload);
        break;

      case 'session:deleted':
        if (payload?.sessionKey) {
          const agentId = `${gatewayId}:${payload.sessionKey}`;
          if (this.agents.has(agentId)) {
            this.agents.delete(agentId);
            this.emit('agent:removed', { id: agentId });
          }
        }
        break;

      case 'agent:update':
        this._updateAgent(gatewayId, payload);
        break;

      case 'agent:removed':
        if (payload?.id) {
          this.agents.delete(payload.id);
          this.emit('agent:removed', payload);
        }
        break;

      case 'chat':
      case 'chat:chunk':
      case 'chat:done':
        // Chat events - forward to UI
        this.emit('chat:event', { gatewayId, event, payload });
        break;

      case 'shutdown':
        console.log(`Gateway ${gateway.name} shutting down: ${payload?.reason}`);
        this._updateGatewayStatus(gatewayId, 'disconnected');
        break;

      default:
        // Log unknown events for debugging
        console.log(`Event from ${gateway.name}: ${event}`);
    }
  }

  /**
   * Update sessions from gateway - shows each session individually
   */
  _updateSessionsFromGateway(gatewayId, sessions) {
    const gateway = this.gateways.get(gatewayId);
    if (!gateway) return;

    const seenIds = new Set();

    for (const session of sessions) {
      const sessionKey = session.sessionKey || session.key || session.id;
      if (!sessionKey) continue;
      
      const compositeId = `${gatewayId}:${sessionKey}`;
      seenIds.add(compositeId);
      
      const agentId = this._extractAgentId(session);
      const sessionType = this._getSessionType(sessionKey);
      const isActive = session.status === 'active' || session.active;
      
      // Derive a friendly name
      let displayName = session.label || session.displayName;
      if (!displayName) {
        if (sessionType === 'cron') {
          displayName = 'Scheduled Task';
        } else if (sessionType === 'subagent') {
          displayName = session.label || 'Sub-agent';
        } else if (sessionType === 'group') {
          displayName = session.displayName || 'Group Chat';
        } else if (sessionType === 'main') {
          displayName = 'Main Chat';
        } else {
          displayName = this._deriveSessionLabel(session);
        }
      }
      
      const agent = {
        id: compositeId,
        gatewayId,
        agentId: agentId || 'unknown',
        sessionKey,
        sessionType,
        name: displayName,
        status: isActive ? 'active' : 'idle',
        channel: session.channel || 'unknown',
        lastActive: session.lastActiveAt || session.updatedAt,
        messageCount: session.messageCount || 0,
        totalTokens: session.totalTokens || 0,
        model: session.model,
        avatar: this._getAgentAvatar(agentId, sessionType),
        // Include extra context
        displayContext: session.displayName || session.deliveryContext?.to,
        metadata: {
          contextTokens: session.contextTokens,
          transcriptPath: session.transcriptPath
        }
      };

      const existing = this.agents.get(compositeId);
      if (!existing || JSON.stringify(existing) !== JSON.stringify(agent)) {
        this.agents.set(compositeId, agent);
        this.emit('agent:update', agent);
      }
    }

    // Remove sessions that no longer exist
    for (const [compositeId, agent] of this.agents) {
      if (agent.gatewayId === gatewayId && !seenIds.has(compositeId)) {
        this.agents.delete(compositeId);
        this.emit('agent:removed', { id: compositeId });
      }
    }

    gateway.agents = Array.from(seenIds);
  }

  /**
   * Extract agentId from session data
   * Session keys look like: agent:main:telegram:group:-123:topic:1
   */
  _extractAgentId(session) {
    // First check if session has explicit agentId
    if (session.agentId) return session.agentId;

    // Extract from sessionKey pattern: agent:{agentId}:{rest...}
    const key = session.sessionKey || session.key || session.id;
    if (!key) return null;

    const parts = key.split(':');
    if (parts[0] === 'agent' && parts.length >= 2) {
      return parts[1]; // e.g., "main", "pilot", "canvas"
    }

    return null;
  }

  /**
   * Get avatar URL/emoji for an agent or session type
   */
  _getAgentAvatar(agentId, sessionType = null) {
    // Session type avatars
    if (sessionType === 'cron') return '⏰';
    if (sessionType === 'subagent') return '🔧';
    if (sessionType === 'group') return '👥';
    
    // Agent-specific avatars
    const avatars = {
      main: '🗿',      // Henry the Great
      personal: '🎩',  // Jeeves
      family: '🏠',    // Bixby
      pilot: '🧭',     // Pilot
      pixel: '🖼️',     // Pixel
      forge: '🔥',     // Forge
      atlas: '🗺️',     // Atlas
      compass: '🧭',   // Compass
      canvas: '🎨',    // Canvas
      cron: '⏰',
      default: '🤖'
    };
    return avatars[agentId] || avatars.default;
  }
  
  /**
   * Detect session type from session key
   */
  _getSessionType(sessionKey) {
    if (!sessionKey) return 'unknown';
    if (sessionKey.includes(':cron:')) return 'cron';
    if (sessionKey.includes(':subagent:')) return 'subagent';
    if (sessionKey.includes(':group:') || sessionKey.includes(':topic:')) return 'group';
    if (sessionKey.match(/^agent:[^:]+:main$/)) return 'main';
    return 'chat';
  }

  /**
   * Derive a human-readable label for a session
   */
  _deriveSessionLabel(session) {
    const key = session.sessionKey || session.key || session.id;
    if (!key) return 'Session';

    const parts = key.split(':');
    if (parts[0] === 'agent' && parts.length >= 3) {
      const sessionType = parts[2]; // e.g., "main", "telegram", "cron"

      if (sessionType === 'main') {
        return 'Main Session';
      } else if (sessionType === 'telegram') {
        const topicIdx = parts.indexOf('topic');
        if (topicIdx !== -1 && parts[topicIdx + 1]) {
          return `Telegram Topic ${parts[topicIdx + 1]}`;
        }
        return 'Telegram';
      } else if (sessionType === 'cron') {
        return 'Cron Job';
      } else {
        return sessionType.charAt(0).toUpperCase() + sessionType.slice(1);
      }
    }

    return key.slice(0, 20) || 'Session';
  }

  /**
   * Update a single session - merges into existing agent or creates new
   */
  _updateSession(gatewayId, sessionData) {
    if (!sessionData) return;
    
    const agentId = this._extractAgentId(sessionData);
    if (!agentId) return;

    const compositeId = `${gatewayId}:${agentId}`;
    const existingAgent = this.agents.get(compositeId);

    const newSession = {
      sessionKey: sessionData.sessionKey || sessionData.key || sessionData.id,
      label: sessionData.label || this._deriveSessionLabel(sessionData),
      channel: sessionData.channel,
      status: sessionData.status || (sessionData.active ? 'active' : 'idle'),
      lastActive: sessionData.lastActiveAt || sessionData.updatedAt,
      messageCount: sessionData.messageCount || 0
    };

    if (existingAgent) {
      // Update existing session or add new one
      const sessionIdx = existingAgent.sessions.findIndex(s => s.sessionKey === newSession.sessionKey);
      if (sessionIdx >= 0) {
        existingAgent.sessions[sessionIdx] = newSession;
      } else {
        existingAgent.sessions.push(newSession);
        existingAgent.sessionCount = existingAgent.sessions.length;
      }
      
      // Recalculate totals
      existingAgent.totalMessages = existingAgent.sessions.reduce((acc, s) => acc + (s.messageCount || 0), 0);
      existingAgent.status = existingAgent.sessions.some(s => s.status === 'active') ? 'active' : 'idle';
      
      const latestActivity = existingAgent.sessions
        .map(s => s.lastActive)
        .filter(Boolean)
        .sort()
        .pop();
      if (latestActivity) existingAgent.lastActive = latestActivity;

      this.emit('agent:update', existingAgent);
    } else {
      // Create new agent
      const agent = {
        id: compositeId,
        gatewayId,
        agentId,
        name: agentId,
        status: newSession.status === 'active' ? 'active' : 'idle',
        sessionCount: 1,
        sessions: [newSession],
        lastActive: newSession.lastActive,
        totalMessages: newSession.messageCount || 0,
        avatar: this._getAgentAvatar(agentId),
        metadata: {}
      };

      this.agents.set(compositeId, agent);
      this.emit('agent:update', agent);

      const gateway = this.gateways.get(gatewayId);
      if (gateway && !gateway.agents.includes(compositeId)) {
        gateway.agents.push(compositeId);
      }
    }
  }

  /**
   * Update a single agent
   */
  _updateAgent(gatewayId, agentData) {
    if (!agentData) return;
    
    const agent = this._normalizeAgent(gatewayId, agentData);
    this.agents.set(agent.id, agent);
    this.emit('agent:update', agent);

    const gateway = this.gateways.get(gatewayId);
    if (gateway && !gateway.agents.includes(agent.id)) {
      gateway.agents.push(agent.id);
    }
  }

  /**
   * Normalize agent data structure
   */
  _normalizeAgent(gatewayId, data) {
    return {
      id: data.id || `${gatewayId}:${data.agentId || Date.now().toString(36)}`,
      gatewayId,
      name: data.name || data.label || data.id || 'Unknown Agent',
      status: data.status || 'idle',
      currentSession: data.currentSession || data.session || null,
      sessions: data.sessions || [],
      lastActive: data.lastActive || null,
      metadata: data.metadata || {}
    };
  }

  /**
   * Send message to gateway (fire and forget)
   */
  _sendToGateway(id, msg) {
    const ws = this.connections.get(id);
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
      return true;
    }
    return false;
  }

  /**
   * Disconnect from gateway
   */
  _disconnectGateway(id) {
    const ws = this.connections.get(id);
    if (ws) {
      ws.close();
      this.connections.delete(id);
    }
    
    // Clear pending requests
    const pending = this.pendingRequests.get(id);
    if (pending) {
      for (const [reqId, req] of pending) {
        clearTimeout(req.timeout);
        req.reject(new Error('Disconnected'));
      }
      this.pendingRequests.delete(id);
    }
  }

  /**
   * Update gateway status
   */
  _updateGatewayStatus(id, status, error = null) {
    const gateway = this.gateways.get(id);
    if (!gateway) return;

    gateway.status = status;
    gateway.lastSeen = status === 'online' ? new Date().toISOString() : gateway.lastSeen;
    gateway.lastError = error;

    this.emit('gateway:update', this._sanitizeGateway(gateway));
  }

  /**
   * Start health check polling for gateway
   */
  _startHealthCheck(id) {
    this._stopHealthCheck(id);

    const timer = setInterval(() => {
      const gateway = this.gateways.get(id);
      if (!gateway) {
        this._stopHealthCheck(id);
        return;
      }

      // Use protocol ping request
      this._sendRequest(id, 'ping', {}, 5000)
        .then(() => {
          this._updateGatewayStatus(id, 'online');
          if (gateway?.healthChecks) gateway.healthChecks.success++;
        })
        .catch(() => {
          // Try HTTP health check as fallback
          this._httpHealthCheck(id);
        });
    }, HEALTH_INTERVAL);

    this.healthTimers.set(id, timer);
  }

  /**
   * Stop health check for gateway
   */
  _stopHealthCheck(id) {
    const timer = this.healthTimers.get(id);
    if (timer) {
      clearInterval(timer);
      this.healthTimers.delete(id);
    }
  }

  /**
   * HTTP health check fallback
   */
  async _httpHealthCheck(id) {
    const gateway = this.gateways.get(id);
    if (!gateway) return;

    const httpUrl = this._toHttpUrl(gateway.url);
    
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);

      const headers = {};
      if (gateway.token) {
        headers['Authorization'] = `Bearer ${gateway.token}`;
      }

      const response = await fetch(`${httpUrl}/api/health`, {
        signal: controller.signal,
        headers
      });
      clearTimeout(timeout);

      const currentGateway = this.gateways.get(id);
      if (response.ok) {
        this._updateGatewayStatus(id, 'online');
        if (currentGateway?.healthChecks) currentGateway.healthChecks.success++;
        
        // Try to reconnect WebSocket if needed
        if (!this.connections.has(id) || this.connections.get(id).readyState !== WebSocket.OPEN) {
          this._connectToGateway(id);
        }
      } else {
        this._updateGatewayStatus(id, 'error', `HTTP ${response.status}`);
        if (currentGateway?.healthChecks) currentGateway.healthChecks.failure++;
      }
    } catch (err) {
      this._updateGatewayStatus(id, 'offline', err.message);
      const currentGateway = this.gateways.get(id);
      if (currentGateway?.healthChecks) currentGateway.healthChecks.failure++;
    }
  }

  /**
   * Start network discovery for gateways
   */
  startDiscovery() {
    if (this.discoverySocket) return;

    console.log('🔍 Starting gateway discovery...');

    // UDP broadcast discovery
    this.discoverySocket = dgram.createSocket({ type: 'udp4', reuseAddr: true });

    this.discoverySocket.on('message', (msg, rinfo) => {
      try {
        const data = JSON.parse(msg.toString());
        if (data.type === 'clawdbot-gateway' && data.url) {
          console.log(`🔍 Discovered gateway: ${data.url} from ${rinfo.address}`);
          this.addGateway({
            url: data.url,
            name: data.name || `Gateway @ ${rinfo.address}`,
            autoDiscovered: true
          });
        }
      } catch (err) {
        // Ignore invalid messages
      }
    });

    this.discoverySocket.on('error', (err) => {
      console.error('Discovery socket error:', err.message);
    });

    this.discoverySocket.bind(DISCOVERY_PORT, () => {
      this.discoverySocket.setBroadcast(true);
      this._sendDiscoveryRequest();
    });

    this._discoveryInterval = setInterval(() => {
      this._sendDiscoveryRequest();
    }, 30000);
  }

  /**
   * Send discovery broadcast
   */
  _sendDiscoveryRequest() {
    if (!this.discoverySocket) return;

    const msg = JSON.stringify({ type: 'clawdbot-gateway-discovery' });
    const buf = Buffer.from(msg);
    
    const broadcastAddrs = ['255.255.255.255', '192.168.1.255', '192.168.0.255', '10.0.0.255'];
    for (const addr of broadcastAddrs) {
      this.discoverySocket.send(buf, 0, buf.length, DISCOVERY_PORT, addr, (err) => {
        if (err && !err.message.includes('ENETUNREACH')) {
          // Ignore unreachable errors
        }
      });
    }
  }

  /**
   * Stop network discovery
   */
  stopDiscovery() {
    if (this._discoveryInterval) {
      clearInterval(this._discoveryInterval);
      this._discoveryInterval = null;
    }
    if (this.discoverySocket) {
      this.discoverySocket.close();
      this.discoverySocket = null;
    }
  }

  /**
   * Get local LAN IP addresses
   */
  _getLocalIPs() {
    const ips = ['localhost', '127.0.0.1'];
    const interfaces = os.networkInterfaces();
    
    for (const name of Object.keys(interfaces)) {
      for (const iface of interfaces[name]) {
        if (iface.internal || iface.family !== 'IPv4') continue;
        ips.push(iface.address);
      }
    }
    
    return ips;
  }

  /**
   * Try to discover local and LAN gateways
   */
  async discoverLocal() {
    const commonPorts = [18789, 3000, 8080];
    const hosts = this._getLocalIPs();
    const discovered = [];

    console.log(`🔍 Scanning for gateways on: ${hosts.join(', ')}`);

    for (const host of hosts) {
      for (const port of commonPorts) {
        const url = `http://${host}:${port}`;
        try {
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), 2000);
          const response = await fetch(`${url}/api/health`, { signal: controller.signal });
          clearTimeout(timeout);
          
          if (response.ok) {
            const data = await response.json();
            if (data.type === 'clawdbot' || data.gateway) {
              console.log(`🔍 Found gateway at ${url}`);
              const gw = this.addGateway({
                url,
                name: data.name || `Gateway @ ${host}:${port}`,
                autoDiscovered: true
              });
              discovered.push(gw);
            }
          }
        } catch (err) {
          // Not a gateway at this address
        }
      }
    }

    return discovered;
  }

  /**
   * Initialize all gateway connections
   */
  init() {
    console.log('🚀 Initializing Gateway Manager...');
    
    for (const [id] of this.gateways) {
      this._connectToGateway(id);
      this._startHealthCheck(id);
    }

    this.startDiscovery();
    this.discoverLocal();
  }

  /**
   * Cleanup on shutdown
   */
  shutdown() {
    console.log('🛑 Shutting down Gateway Manager...');
    
    this.stopDiscovery();
    
    for (const [id] of this.gateways) {
      this._stopHealthCheck(id);
      this._disconnectGateway(id);
    }
  }

  // Helper methods
  _normalizeUrl(url) {
    url = url.trim();
    if (!url.startsWith('http') && !url.startsWith('ws')) {
      url = 'http://' + url;
    }
    return url.replace(/\/$/, '');
  }

  _toWebSocketUrl(url) {
    return url.replace(/^http/, 'ws');
  }

  _toHttpUrl(url) {
    return url.replace(/^ws/, 'http');
  }

  _deriveGatewayName(url) {
    try {
      const u = new URL(url);
      if (u.hostname === 'localhost' || u.hostname === '127.0.0.1') {
        return `Local Gateway (:${u.port || 80})`;
      }
      return u.hostname;
    } catch {
      return 'Gateway';
    }
  }

  _sanitizeGateway(gw) {
    const { token, ...safe } = gw;
    return { ...safe, hasToken: !!token };
  }
}

module.exports = GatewayManager;
