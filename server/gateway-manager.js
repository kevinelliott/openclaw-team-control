/**
 * Gateway Manager - Handles discovery, registration, and health monitoring
 * 
 * Design: Team Control POLLS gateways (gateways don't register themselves)
 * - Auto-discover gateways on local network via mDNS
 * - Manual registration (URL + token)
 * - Persistent storage in JSON file
 * - WebSocket connections for realtime agent updates
 * - Health check polling for each gateway
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const WebSocket = require('ws');
const dgram = require('dgram');
const EventEmitter = require('events');

const DATA_DIR = path.join(__dirname, '../data');
const GATEWAYS_FILE = path.join(DATA_DIR, 'gateways.json');
const HEALTH_INTERVAL = 10000;  // 10 seconds
const DISCOVERY_PORT = 18790;   // UDP broadcast port for discovery
const RECONNECT_DELAY = 5000;   // 5 seconds before reconnect attempt

class GatewayManager extends EventEmitter {
  constructor() {
    super();
    this.gateways = new Map();  // id -> gateway config + state
    this.connections = new Map(); // id -> WebSocket connection
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
      healthChecks: { success: 0, failure: 0 }
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
   * Connect to a gateway via WebSocket
   */
  _connectToGateway(id) {
    const gateway = this.gateways.get(id);
    if (!gateway) return;

    // Close existing connection
    this._disconnectGateway(id);

    const wsUrl = this._toWebSocketUrl(gateway.url);
    console.log(`🔌 Connecting to gateway: ${gateway.name} (${wsUrl})`);

    try {
      const headers = {};
      if (gateway.token) {
        headers['Authorization'] = `Bearer ${gateway.token}`;
      }

      const ws = new WebSocket(wsUrl, { headers, handshakeTimeout: 5000 });

      ws.on('open', () => {
        console.log(`✅ Connected to gateway: ${gateway.name}`);
        this._updateGatewayStatus(id, 'online');
        
        // Request agent list
        this._sendToGateway(id, { type: 'list_agents' });
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
        console.log(`❌ Gateway ${gateway.name} disconnected (${code})`);
        this._updateGatewayStatus(id, 'disconnected');
        this.connections.delete(id);
        
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
   * Handle messages from gateway WebSocket
   */
  _handleGatewayMessage(gatewayId, msg) {
    const gateway = this.gateways.get(gatewayId);
    if (!gateway) return;

    switch (msg.type) {
      case 'agents':
      case 'agent_list':
        // Full agent list from gateway
        this._updateAgentsFromGateway(gatewayId, msg.agents || []);
        break;

      case 'agent_update':
      case 'agent:update':
        // Single agent update
        this._updateAgent(gatewayId, msg.agent || msg.data);
        break;

      case 'agent_added':
      case 'agent:added':
        this._updateAgent(gatewayId, msg.agent || msg.data);
        break;

      case 'agent_removed':
      case 'agent:removed':
        const agentId = msg.agentId || msg.id;
        if (this.agents.has(agentId)) {
          this.agents.delete(agentId);
          this.emit('agent:removed', { id: agentId });
        }
        break;

      case 'session_update':
      case 'session:update':
        // Session activity update
        this._updateAgentSession(msg);
        break;

      case 'pong':
      case 'health':
        // Health response
        this._updateGatewayStatus(gatewayId, 'online');
        gateway.healthChecks.success++;
        break;

      default:
        // Unknown message type - log for debugging
        console.log(`Unknown message from ${gateway.name}:`, msg.type);
    }
  }

  /**
   * Update all agents from a gateway
   */
  _updateAgentsFromGateway(gatewayId, agentList) {
    const gateway = this.gateways.get(gatewayId);
    if (!gateway) return;

    // Track which agents we've seen
    const seenAgentIds = new Set();

    for (const agentData of agentList) {
      const agent = this._normalizeAgent(gatewayId, agentData);
      seenAgentIds.add(agent.id);
      
      const existing = this.agents.get(agent.id);
      if (!existing || JSON.stringify(existing) !== JSON.stringify(agent)) {
        this.agents.set(agent.id, agent);
        this.emit('agent:update', agent);
      }
    }

    // Remove agents that no longer exist on this gateway
    for (const [agentId, agent] of this.agents) {
      if (agent.gatewayId === gatewayId && !seenAgentIds.has(agentId)) {
        this.agents.delete(agentId);
        this.emit('agent:removed', { id: agentId });
      }
    }

    // Update gateway agent count
    gateway.agents = Array.from(seenAgentIds);
  }

  /**
   * Update a single agent
   */
  _updateAgent(gatewayId, agentData) {
    if (!agentData) return;
    
    const agent = this._normalizeAgent(gatewayId, agentData);
    this.agents.set(agent.id, agent);
    this.emit('agent:update', agent);

    // Update gateway agent list
    const gateway = this.gateways.get(gatewayId);
    if (gateway && !gateway.agents.includes(agent.id)) {
      gateway.agents.push(agent.id);
    }
  }

  /**
   * Update agent session info
   */
  _updateAgentSession(msg) {
    const agent = this.agents.get(msg.agentId);
    if (agent) {
      agent.currentSession = msg.session || msg.sessionId;
      agent.status = msg.status || agent.status;
      agent.lastActive = new Date().toISOString();
      this.emit('agent:update', agent);
    }
  }

  /**
   * Normalize agent data structure
   */
  _normalizeAgent(gatewayId, data) {
    return {
      id: data.id || data.agentId || `agent-${Date.now().toString(36)}`,
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
   * Send message to gateway
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

      // Try WebSocket ping first
      if (!this._sendToGateway(id, { type: 'ping' })) {
        // WebSocket not connected, try HTTP health check
        this._httpHealthCheck(id);
      }
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

      if (response.ok) {
        this._updateGatewayStatus(id, 'online');
        gateway.healthChecks.success++;
        
        // Try to reconnect WebSocket if needed
        if (!this.connections.has(id) || this.connections.get(id).readyState !== WebSocket.OPEN) {
          this._connectToGateway(id);
        }
      } else {
        this._updateGatewayStatus(id, 'error', `HTTP ${response.status}`);
        gateway.healthChecks.failure++;
      }
    } catch (err) {
      this._updateGatewayStatus(id, 'offline', err.message);
      gateway.healthChecks.failure++;
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
      // Send discovery request
      this._sendDiscoveryRequest();
    });

    // Periodic discovery requests
    this._discoveryInterval = setInterval(() => {
      this._sendDiscoveryRequest();
    }, 30000); // Every 30 seconds
  }

  /**
   * Send discovery broadcast
   */
  _sendDiscoveryRequest() {
    if (!this.discoverySocket) return;

    const msg = JSON.stringify({ type: 'clawdbot-gateway-discovery' });
    const buf = Buffer.from(msg);
    
    // Broadcast to common local network ranges
    const broadcastAddrs = ['255.255.255.255', '192.168.1.255', '192.168.0.255', '10.0.0.255'];
    for (const addr of broadcastAddrs) {
      this.discoverySocket.send(buf, 0, buf.length, DISCOVERY_PORT, addr, (err) => {
        if (err && !err.message.includes('ENETUNREACH')) {
          // console.error('Discovery broadcast error:', err.message);
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
        // Skip internal and non-IPv4 addresses
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
    
    // Connect to all saved gateways
    for (const [id] of this.gateways) {
      this._connectToGateway(id);
      this._startHealthCheck(id);
    }

    // Start network discovery
    this.startDiscovery();

    // Try to find local gateway
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
