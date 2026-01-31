import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { io } from 'socket.io-client'
import { Server, Bot, Activity, Plus, Settings, RefreshCw, Wifi, WifiOff, Trash2, Search, Clock, AlertCircle, CheckCircle2, Loader2, MessageSquare, Zap, Eye, ChevronDown, ChevronRight, Users, BarChart3, Play, Pause, Send, Terminal, History, Cpu, Database, X, Copy, Check, RotateCcw } from 'lucide-react'

function App() {
  const [gateways, setGateways] = useState([])
  const [agents, setAgents] = useState([])
  const [connected, setConnected] = useState(false)
  const [showAddGateway, setShowAddGateway] = useState(false)
  const [editingGateway, setEditingGateway] = useState(null)
  const [discovering, setDiscovering] = useState(false)
  const [activityLog, setActivityLog] = useState([])
  const [selectedAgent, setSelectedAgent] = useState(null)
  const [viewMode, setViewMode] = useState('grid') // 'grid' or 'list'
  
  // Stable socket reference - only create once
  const socketRef = useRef(null)
  if (!socketRef.current) {
    socketRef.current = io({
      autoConnect: false,
      transports: ['websocket'],  // Skip polling, go straight to websocket
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
      reconnectionAttempts: Infinity
    })
  }
  const socket = socketRef.current

  // Add activity log entry
  const addActivity = useCallback((type, message, data = {}) => {
    setActivityLog(prev => [{
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 4),
      type,
      message,
      data,
      timestamp: new Date().toISOString()
    }, ...prev].slice(0, 50)) // Keep last 50
  }, [])

  useEffect(() => {
    // Connect on mount
    if (!socket.connected) {
      socket.connect()
    }
    
    const onConnect = () => {
      setConnected(true)
      addActivity('system', 'Connected to Team Control server')
    }
    const onDisconnect = () => {
      setConnected(false)
      addActivity('warning', 'Disconnected from server')
    }
    
    socket.on('connect', onConnect)
    socket.on('disconnect', onDisconnect)
    
    socket.on('sync', (data) => {
      setGateways(data.gateways || [])
      setAgents(data.agents || [])
      addActivity('sync', `Synced ${data.gateways?.length || 0} gateways, ${data.agents?.length || 0} agents`)
    })
    
    socket.on('gateway:added', (gw) => {
      setGateways(prev => {
        if (prev.some(g => g.id === gw.id)) return prev
        return [...prev, gw]
      })
      addActivity('gateway', `Gateway added: ${gw.name}`, { gatewayId: gw.id })
    })
    
    socket.on('gateway:removed', ({ id }) => {
      setGateways(prev => prev.filter(g => g.id !== id))
      setAgents(prev => prev.filter(a => a.gatewayId !== id))
      addActivity('gateway', `Gateway removed`, { gatewayId: id })
    })
    
    socket.on('gateway:update', (gw) => {
      setGateways(prev => {
        const old = prev.find(g => g.id === gw.id)
        if (old?.status !== gw.status) {
          addActivity('gateway', `${gw.name}: ${gw.status}`, { gatewayId: gw.id, status: gw.status })
        }
        return prev.map(g => g.id === gw.id ? gw : g)
      })
    })
    
    socket.on('agent:update', (agent) => {
      setAgents(prev => {
        const old = prev.find(a => a.id === agent.id)
        const isNew = !old
        const statusChanged = old && old.status !== agent.status
        
        if (isNew) {
          addActivity('agent', `Agent discovered: ${agent.name}`, { agentId: agent.id })
        } else if (statusChanged) {
          addActivity('agent', `${agent.name}: ${agent.status}`, { agentId: agent.id, status: agent.status })
        }
        
        const idx = prev.findIndex(a => a.id === agent.id)
        if (idx >= 0) return [...prev.slice(0, idx), agent, ...prev.slice(idx + 1)]
        return [...prev, agent]
      })
    })
    
    socket.on('agent:removed', ({ id }) => {
      setAgents(prev => prev.filter(a => a.id !== id))
      addActivity('agent', `Agent removed`, { agentId: id })
    })

    socket.on('discovery:complete', ({ discovered, gateways: newGateways }) => {
      setDiscovering(false)
      addActivity('discovery', `Discovery complete: ${discovered} gateways found`)
    })

    const onChatEvent = ({ gatewayId, event, payload }) => {
      if (event === 'chat' || event === 'chat:done') {
        addActivity('chat', `Message in ${payload?.sessionKey || 'session'}`, { event, payload })
      }
    }
    
    socket.on('chat:event', onChatEvent)
    
    return () => {
      socket.off('connect', onConnect)
      socket.off('disconnect', onDisconnect)
      socket.off('sync')
      socket.off('gateway:added')
      socket.off('gateway:removed')
      socket.off('gateway:update')
      socket.off('agent:update')
      socket.off('agent:removed')
      socket.off('discovery:complete')
      socket.off('chat:event', onChatEvent)
      // Don't disconnect - socket is reused across StrictMode double-mount
    }
  }, [addActivity, socket])

  const addGateway = async (data) => {
    await fetch('/api/gateways', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    })
    setShowAddGateway(false)
  }

  const removeGateway = async (id) => {
    if (!confirm('Remove this gateway?')) return
    await fetch(`/api/gateways/${id}`, { method: 'DELETE' })
  }

  const updateGateway = async (id, data) => {
    socket.emit('gateway:update', { id, ...data })
    setEditingGateway(null)
  }

  const discoverGateways = () => {
    setDiscovering(true)
    socket.emit('discover')
    // Timeout fallback
    setTimeout(() => setDiscovering(false), 10000)
  }

  const refresh = () => socket.emit('refresh')

  return (
    <div className="min-h-screen flex flex-col bg-bg-dark">
      <Header 
        connected={connected} 
        onAddGateway={() => setShowAddGateway(true)} 
        onDiscover={discoverGateways}
        onRefresh={refresh}
        discovering={discovering}
        viewMode={viewMode}
        onViewModeChange={setViewMode}
      />
      <div className="flex-1 flex overflow-hidden">
        <main className="flex-1 p-6 overflow-y-auto">
          {gateways.length === 0 ? (
            <EmptyState 
              onAdd={() => setShowAddGateway(true)} 
              onDiscover={discoverGateways}
              discovering={discovering}
            />
          ) : (
            <div className="space-y-6">
              <StatsBar gateways={gateways} agents={agents} />
              {viewMode === 'grid' ? (
                <GatewayGrid 
                  gateways={gateways} 
                  agents={agents} 
                  onRemove={removeGateway}
                  onEdit={setEditingGateway}
                  onSelectAgent={setSelectedAgent}
                />
              ) : (
                <AgentListView 
                  gateways={gateways} 
                  agents={agents}
                  onSelectAgent={setSelectedAgent}
                />
              )}
            </div>
          )}
        </main>
        <ActivityPanel activity={activityLog} />
      </div>
      {showAddGateway && (
        <AddGatewayModal onClose={() => setShowAddGateway(false)} onSubmit={addGateway} />
      )}
      {editingGateway && (
        <EditGatewayModal 
          gateway={editingGateway} 
          onClose={() => setEditingGateway(null)} 
          onSubmit={(data) => updateGateway(editingGateway.id, data)} 
        />
      )}
      {selectedAgent && (
        <AgentDetailModal 
          agent={selectedAgent} 
          gateway={gateways.find(g => g.id === selectedAgent.gatewayId)}
          onClose={() => setSelectedAgent(null)}
          socket={socket}
        />
      )}
    </div>
  )
}

function Header({ connected, onAddGateway, onDiscover, onRefresh, discovering, viewMode, onViewModeChange }) {
  return (
    <header className="bg-bg-card border-b border-border-default px-6 py-4 flex items-center justify-between shrink-0">
      <div className="flex items-center gap-3">
        <div className="bg-gradient-to-r from-blue-500 to-purple-600 p-2 rounded-lg">
          <Users className="w-6 h-6 text-white" />
        </div>
        <div>
          <h1 className="text-xl font-bold">Team Control</h1>
          <p className="text-text-secondary text-sm">Clawdbot Agent Dashboard</p>
        </div>
      </div>
      <div className="flex items-center gap-3">
        <div className="flex items-center gap-2 text-sm mr-4">
          {connected ? (
            <Wifi className="w-4 h-4 text-green-400" />
          ) : (
            <WifiOff className="w-4 h-4 text-red-400" />
          )}
          <span className="text-text-secondary">{connected ? 'Connected' : 'Disconnected'}</span>
        </div>
        
        {/* View mode toggle */}
        <div className="flex bg-bg-dark rounded-lg p-1 mr-2">
          <button
            onClick={() => onViewModeChange('grid')}
            className={`p-2 rounded-md transition-colors ${viewMode === 'grid' ? 'bg-bg-hover text-text-primary' : 'text-text-muted hover:text-text-secondary'}`}
            title="Grid view"
          >
            <BarChart3 className="w-4 h-4" />
          </button>
          <button
            onClick={() => onViewModeChange('list')}
            className={`p-2 rounded-md transition-colors ${viewMode === 'list' ? 'bg-bg-hover text-text-primary' : 'text-text-muted hover:text-text-secondary'}`}
            title="List view"
          >
            <Activity className="w-4 h-4" />
          </button>
        </div>

        <button 
          onClick={onRefresh}
          className="p-2 text-text-secondary hover:text-text-primary hover:bg-bg-hover rounded-lg transition-colors"
          title="Refresh"
        >
          <RefreshCw className="w-5 h-5" />
        </button>
        <button 
          onClick={onDiscover}
          disabled={discovering}
          className="flex items-center gap-2 px-3 py-2 text-text-secondary hover:text-text-primary hover:bg-bg-hover rounded-lg transition-colors disabled:opacity-50"
          title="Auto-discover gateways"
        >
          {discovering ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : (
            <Search className="w-4 h-4" />
          )}
          <span className="text-sm hidden sm:inline">Discover</span>
        </button>
        <button 
          onClick={onAddGateway} 
          className="flex items-center gap-2 bg-blue-600 hover:bg-blue-700 px-4 py-2 rounded-lg text-sm font-medium transition-colors"
        >
          <Plus className="w-4 h-4" /> <span className="hidden sm:inline">Add Gateway</span>
        </button>
      </div>
    </header>
  )
}

function StatsBar({ gateways, agents }) {
  const onlineGateways = gateways.filter(g => g.status === 'online').length
  const activeAgents = agents.filter(a => a.status === 'active').length
  const totalSessions = agents.reduce((acc, a) => acc + (a.sessions?.length || 0), 0)
  const activeSessions = agents.reduce((acc, a) => acc + (a.sessions?.filter(s => s.status === 'active').length || 0), 0)
  const totalMessages = agents.reduce((acc, a) => acc + (a.messageCount || 0), 0)
  
  return (
    <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
      <StatCard 
        label="Gateways" 
        value={`${onlineGateways}/${gateways.length}`} 
        icon={<Server className="w-5 h-5" />} 
        color="blue"
        subtitle={onlineGateways === gateways.length ? 'All online' : `${gateways.length - onlineGateways} offline`}
      />
      <StatCard 
        label="Total Agents" 
        value={agents.length} 
        icon={<Bot className="w-5 h-5" />} 
        color="purple"
        subtitle={`${activeAgents} active`}
      />
      <StatCard 
        label="Active Now" 
        value={activeAgents} 
        icon={<Activity className="w-5 h-5" />} 
        color="green"
        subtitle={activeAgents > 0 ? 'Processing' : 'Idle'}
      />
      <StatCard 
        label="Sessions" 
        value={`${activeSessions}/${totalSessions}`} 
        icon={<Users className="w-5 h-5" />} 
        color="cyan"
        subtitle={activeSessions > 0 ? `${activeSessions} running` : 'None running'}
      />
      <StatCard 
        label="Messages" 
        value={totalMessages} 
        icon={<MessageSquare className="w-5 h-5" />} 
        color="amber"
        subtitle="Total processed"
      />
    </div>
  )
}

function StatCard({ label, value, icon, color, subtitle }) {
  const colors = {
    blue: 'from-blue-500/20 to-blue-600/10 text-blue-400',
    purple: 'from-purple-500/20 to-purple-600/10 text-purple-400',
    green: 'from-green-500/20 to-green-600/10 text-green-400',
    amber: 'from-amber-500/20 to-amber-600/10 text-amber-400',
    cyan: 'from-cyan-500/20 to-cyan-600/10 text-cyan-400'
  }
  return (
    <div className={`card bg-gradient-to-br ${colors[color]}`}>
      <div className="flex items-center justify-between">
        <div>
          <p className="text-text-secondary text-sm">{label}</p>
          <p className="text-3xl font-bold mt-1">{value}</p>
          {subtitle && <p className="text-xs text-text-muted mt-1">{subtitle}</p>}
        </div>
        <div className="opacity-60">{icon}</div>
      </div>
    </div>
  )
}

function GatewayGrid({ gateways, agents, onRemove, onEdit, onSelectAgent }) {
  return (
    <div className="space-y-6">
      {gateways.map(gw => (
        <GatewayCard 
          key={gw.id} 
          gateway={gw} 
          agents={agents.filter(a => a.gatewayId === gw.id)} 
          onRemove={() => onRemove(gw.id)}
          onEdit={() => onEdit(gw)}
          onSelectAgent={onSelectAgent}
        />
      ))}
    </div>
  )
}

function GatewayStatusIcon({ status }) {
  switch (status) {
    case 'online':
      return <CheckCircle2 className="w-4 h-4 text-green-400" />
    case 'connecting':
      return <Loader2 className="w-4 h-4 text-blue-400 animate-spin" />
    case 'error':
      return <AlertCircle className="w-4 h-4 text-red-400" />
    case 'offline':
    case 'disconnected':
    default:
      return <WifiOff className="w-4 h-4 text-gray-400" />
  }
}

function GatewayCard({ gateway, agents, onRemove, onEdit, onSelectAgent }) {
  const [expanded, setExpanded] = useState(true)
  
  const statusColors = {
    online: 'border-green-500/30 bg-green-500/5',
    connecting: 'border-blue-500/30 bg-blue-500/5',
    error: 'border-red-500/30 bg-red-500/5',
    offline: 'border-gray-500/30',
    disconnected: 'border-gray-500/30'
  }
  
  const activeAgents = agents.filter(a => a.status === 'active').length
  
  return (
    <div className={`card ${statusColors[gateway.status] || ''}`}>
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-3">
          <button 
            onClick={() => setExpanded(!expanded)}
            className="p-1 hover:bg-bg-hover rounded transition-colors"
          >
            {expanded ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
          </button>
          <GatewayStatusIcon status={gateway.status} />
          <div>
            <div className="flex items-center gap-2">
              <h3 className="font-semibold">{gateway.name || 'Gateway'}</h3>
              {gateway.autoDiscovered && (
                <span className="text-xs bg-blue-500/20 text-blue-400 px-2 py-0.5 rounded">Auto</span>
              )}
              {gateway.hasToken && (
                <span className="text-xs bg-amber-500/20 text-amber-400 px-2 py-0.5 rounded">Auth</span>
              )}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-4">
          {gateway.lastSeen && (
            <div className="flex items-center gap-1 text-text-muted text-xs">
              <Clock className="w-3 h-3" />
              <span>{formatTimeAgo(gateway.lastSeen)}</span>
            </div>
          )}
          {gateway.lastError && (
            <span className="text-red-400 text-xs max-w-[200px] truncate">{gateway.lastError}</span>
          )}
          <div className="flex items-center gap-2 text-text-muted text-sm">
            <Bot className="w-4 h-4" />
            <span>{agents.length}</span>
            {activeAgents > 0 && (
              <span className="text-green-400">({activeAgents} active)</span>
            )}
          </div>
          <button 
            onClick={onEdit}
            className="p-2 text-text-muted hover:text-blue-400 hover:bg-blue-500/10 rounded-lg transition-colors"
            title="Edit gateway"
          >
            <Settings className="w-4 h-4" />
          </button>
          <button 
            onClick={onRemove}
            className="p-2 text-text-muted hover:text-red-400 hover:bg-red-500/10 rounded-lg transition-colors"
            title="Remove gateway"
          >
            <Trash2 className="w-4 h-4" />
          </button>
        </div>
      </div>
      {expanded && (
        agents.length > 0 ? (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
            {agents.map(agent => (
              <AgentCard 
                key={agent.id} 
                agent={agent} 
                onClick={() => onSelectAgent?.(agent)}
              />
            ))}
          </div>
        ) : (
          <p className="text-text-secondary text-sm py-4 text-center">
            {gateway.status === 'online' ? 'No agents discovered yet' : 'Waiting for connection...'}
          </p>
        )
      )}
    </div>
  )
}

function AgentCard({ agent, onClick }) {
  const statusColors = {
    active: 'border-green-500/40 bg-green-500/10 hover:border-green-500/60',
    idle: 'border-border-default hover:border-border-active',
    busy: 'border-amber-500/40 bg-amber-500/10 hover:border-amber-500/60',
    error: 'border-red-500/40 bg-red-500/10 hover:border-red-500/60'
  }

  // Capitalize agent name for display
  const displayName = agent.name ? 
    agent.name.charAt(0).toUpperCase() + agent.name.slice(1) : 
    agent.agentId || agent.id;

  // Session type badge colors
  const typeBadges = {
    cron: { label: 'Cron', color: 'bg-purple-500/20 text-purple-300' },
    subagent: { label: 'Sub-agent', color: 'bg-blue-500/20 text-blue-300' },
    group: { label: 'Group', color: 'bg-cyan-500/20 text-cyan-300' },
    main: { label: 'Main', color: 'bg-green-500/20 text-green-300' },
    chat: { label: 'Chat', color: 'bg-zinc-500/20 text-zinc-300' },
  };
  const badge = typeBadges[agent.sessionType] || typeBadges.chat;
  
  return (
    <div 
      onClick={onClick}
      className={`bg-bg-hover rounded-xl p-4 border transition-all cursor-pointer hover:shadow-lg hover:scale-[1.02] ${statusColors[agent.status] || statusColors.idle}`}
    >
      {/* Large centered avatar */}
      <div className="flex flex-col items-center text-center mb-3">
        <div className={`text-5xl mb-2 ${agent.status === 'active' ? 'animate-pulse' : ''}`}>
          {agent.avatar || '🤖'}
        </div>
        <div className="flex items-center gap-2">
          <span className={`status-dot status-${agent.status || 'idle'}`} />
          <span className="font-semibold text-lg">{displayName}</span>
        </div>
        {/* Agent ID if different from name */}
        {agent.agentId && agent.agentId !== agent.name?.toLowerCase() && (
          <p className="text-text-muted text-xs mt-0.5">{agent.agentId}</p>
        )}
      </div>
      
      {/* Type badge */}
      <div className="flex justify-center mb-3">
        <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${badge.color}`}>
          {badge.label}
        </span>
      </div>
      
      {/* Stats row */}
      <div className="flex justify-center gap-4 text-xs text-text-muted">
        {agent.messageCount > 0 && (
          <span className="flex items-center gap-1">
            <MessageSquare className="w-3 h-3" />
            {agent.messageCount}
          </span>
        )}
        {agent.channel && agent.channel !== 'unknown' && (
          <span className="flex items-center gap-1 capitalize">
            {agent.channel}
          </span>
        )}
      </div>
      
      {/* Last active */}
      {agent.lastActive && (
        <p className="text-text-muted text-xs mt-2 text-center flex items-center justify-center gap-1">
          <Clock className="w-3 h-3" />
          {formatTimeAgo(agent.lastActive)}
        </p>
      )}
      
      {/* Model indicator */}
      {agent.model && (
        <p className="text-text-muted text-xs mt-1 text-center truncate opacity-60">
          {agent.model}
        </p>
      )}
    </div>
  )
}

function EmptyState({ onAdd, onDiscover, discovering }) {
  return (
    <div className="flex flex-col items-center justify-center h-[60vh] text-center">
      <div className="bg-bg-card p-8 rounded-2xl border border-border-default mb-6">
        <Server className="w-16 h-16 text-text-muted mx-auto mb-4" />
        <h2 className="text-xl font-semibold mb-2">No Gateways Connected</h2>
        <p className="text-text-secondary mb-6 max-w-md">
          Connect your first Clawdbot gateway to start monitoring your agents in real-time.
        </p>
        <div className="flex justify-center gap-3">
          <button 
            onClick={onDiscover} 
            disabled={discovering}
            className="flex items-center gap-2 bg-bg-hover hover:bg-bg-card border border-border-default px-6 py-3 rounded-lg font-medium transition-colors disabled:opacity-50"
          >
            {discovering ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Search className="w-4 h-4" />
            )}
            Auto-Discover
          </button>
          <button 
            onClick={onAdd} 
            className="flex items-center gap-2 bg-blue-600 hover:bg-blue-700 px-6 py-3 rounded-lg font-medium transition-colors"
          >
            <Plus className="w-4 h-4" /> Add Manually
          </button>
        </div>
      </div>
    </div>
  )
}

function AddGatewayModal({ onClose, onSubmit }) {
  const [url, setUrl] = useState('')
  const [name, setName] = useState('')
  const [token, setToken] = useState('')

  const handleSubmit = (e) => {
    e.preventDefault()
    if (!url.trim()) return
    onSubmit({ url: url.trim(), name: name.trim(), token: token.trim() })
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={onClose}>
      <div className="bg-bg-card border border-border-default rounded-xl p-6 w-full max-w-md" onClick={e => e.stopPropagation()}>
        <h2 className="text-lg font-semibold mb-4">Add Gateway</h2>
        <form onSubmit={handleSubmit}>
          <div className="space-y-4">
            <div>
              <label className="block text-sm text-text-secondary mb-1">Gateway URL *</label>
              <input 
                value={url} 
                onChange={e => setUrl(e.target.value)} 
                placeholder="http://localhost:18789 or ws://..." 
                className="w-full bg-bg-dark border border-border-default rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-blue-500"
                autoFocus
              />
              <p className="text-text-muted text-xs mt-1">HTTP or WebSocket URL to the Clawdbot gateway</p>
            </div>
            <div>
              <label className="block text-sm text-text-secondary mb-1">Display Name</label>
              <input 
                value={name} 
                onChange={e => setName(e.target.value)} 
                placeholder="Production Server" 
                className="w-full bg-bg-dark border border-border-default rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-blue-500" 
              />
            </div>
            <div>
              <label className="block text-sm text-text-secondary mb-1">Auth Token</label>
              <input 
                type="password" 
                value={token} 
                onChange={e => setToken(e.target.value)} 
                placeholder="Optional auth token" 
                className="w-full bg-bg-dark border border-border-default rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-blue-500" 
              />
              <p className="text-text-muted text-xs mt-1">Required if gateway has authentication enabled</p>
            </div>
          </div>
          <div className="flex justify-end gap-3 mt-6">
            <button 
              type="button"
              onClick={onClose} 
              className="px-4 py-2 text-sm text-text-secondary hover:text-text-primary transition-colors"
            >
              Cancel
            </button>
            <button 
              type="submit"
              className="bg-blue-600 hover:bg-blue-700 px-4 py-2 rounded-lg text-sm font-medium transition-colors"
            >
              Connect
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

function EditGatewayModal({ gateway, onClose, onSubmit }) {
  const [name, setName] = useState(gateway.name || '')
  const [token, setToken] = useState('')

  const handleSubmit = (e) => {
    e.preventDefault()
    onSubmit({ name: name.trim(), token: token.trim() || undefined })
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={onClose}>
      <div className="bg-bg-card border border-border-default rounded-xl p-6 w-full max-w-md" onClick={e => e.stopPropagation()}>
        <h2 className="text-lg font-semibold mb-4">Edit Gateway</h2>
        <form onSubmit={handleSubmit}>
          <div className="space-y-4">
            <div>
              <label className="block text-sm text-text-secondary mb-1">Gateway URL</label>
              <p className="text-text-muted text-sm bg-bg-dark border border-border-default rounded-lg px-3 py-2">{gateway.url}</p>
            </div>
            <div>
              <label className="block text-sm text-text-secondary mb-1">Display Name</label>
              <input 
                value={name} 
                onChange={e => setName(e.target.value)} 
                placeholder="Production Server" 
                className="w-full bg-bg-dark border border-border-default rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-blue-500" 
                autoFocus
              />
            </div>
            <div>
              <label className="block text-sm text-text-secondary mb-1">Auth Token</label>
              <input 
                type="password" 
                value={token} 
                onChange={e => setToken(e.target.value)} 
                placeholder="Leave blank to keep current" 
                className="w-full bg-bg-dark border border-border-default rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-blue-500" 
              />
              <p className="text-text-muted text-xs mt-1">Leave empty to keep existing token</p>
            </div>
          </div>
          <div className="flex justify-end gap-3 mt-6">
            <button 
              type="button"
              onClick={onClose} 
              className="px-4 py-2 text-sm text-text-secondary hover:text-text-primary transition-colors"
            >
              Cancel
            </button>
            <button 
              type="submit"
              className="bg-blue-600 hover:bg-blue-700 px-4 py-2 rounded-lg text-sm font-medium transition-colors"
            >
              Save
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

// Activity Panel - Real-time event feed
function ActivityPanel({ activity }) {
  const [collapsed, setCollapsed] = useState(false)
  
  const activityIcons = {
    system: <Wifi className="w-3 h-3 text-blue-400" />,
    warning: <AlertCircle className="w-3 h-3 text-amber-400" />,
    gateway: <Server className="w-3 h-3 text-purple-400" />,
    agent: <Bot className="w-3 h-3 text-cyan-400" />,
    chat: <MessageSquare className="w-3 h-3 text-green-400" />,
    sync: <RefreshCw className="w-3 h-3 text-text-muted" />,
    discovery: <Search className="w-3 h-3 text-blue-400" />
  }
  
  if (collapsed) {
    return (
      <div className="w-12 bg-bg-card border-l border-border-default flex flex-col items-center py-4">
        <button
          onClick={() => setCollapsed(false)}
          className="p-2 hover:bg-bg-hover rounded-lg text-text-muted hover:text-text-primary"
          title="Show activity"
        >
          <Activity className="w-5 h-5" />
        </button>
        {activity.length > 0 && (
          <span className="mt-2 text-xs text-green-400">{activity.length}</span>
        )}
      </div>
    )
  }
  
  return (
    <div className="w-80 bg-bg-card border-l border-border-default flex flex-col shrink-0">
      <div className="px-4 py-3 border-b border-border-default flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Activity className="w-4 h-4 text-text-muted" />
          <h2 className="font-semibold text-sm">Activity Feed</h2>
        </div>
        <button
          onClick={() => setCollapsed(true)}
          className="p-1 hover:bg-bg-hover rounded text-text-muted hover:text-text-primary"
        >
          <ChevronRight className="w-4 h-4" />
        </button>
      </div>
      <div className="flex-1 overflow-y-auto p-2 space-y-1">
        {activity.length === 0 ? (
          <p className="text-text-muted text-xs text-center py-8">No activity yet</p>
        ) : (
          activity.map(item => (
            <div key={item.id} className="p-2 rounded hover:bg-bg-hover text-xs group">
              <div className="flex items-start gap-2">
                <div className="mt-0.5">
                  {activityIcons[item.type] || <Zap className="w-3 h-3 text-text-muted" />}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-text-secondary truncate">{item.message}</p>
                  <p className="text-text-muted mt-0.5">{formatTimeAgo(item.timestamp)}</p>
                </div>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  )
}

// Agent List View - Alternative to grid
function AgentListView({ gateways, agents, onSelectAgent }) {
  return (
    <div className="card">
      <h3 className="font-semibold mb-4 flex items-center gap-2">
        <Bot className="w-5 h-5" />
        All Agents ({agents.length})
      </h3>
      <div className="divide-y divide-border-default">
        {agents.length === 0 ? (
          <p className="text-text-muted text-sm py-4 text-center">No agents found</p>
        ) : (
          agents.map(agent => {
            const gateway = gateways.find(g => g.id === agent.gatewayId)
            return (
              <div 
                key={agent.id}
                onClick={() => onSelectAgent?.(agent)}
                className="py-3 px-2 hover:bg-bg-hover cursor-pointer flex items-center gap-4 first:pt-0 last:pb-0"
              >
                <span className={`status-dot status-${agent.status || 'idle'} shrink-0`} />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-medium truncate">{agent.name}</span>
                    {agent.status === 'active' && (
                      <Zap className="w-3 h-3 text-green-400 animate-pulse" />
                    )}
                  </div>
                  <div className="flex items-center gap-3 text-xs text-text-muted mt-0.5">
                    <span>{gateway?.name || 'Unknown gateway'}</span>
                    {agent.channel && <span>• {agent.channel}</span>}
                    {agent.messageCount > 0 && <span>• {agent.messageCount} msgs</span>}
                  </div>
                </div>
                <div className="text-xs text-text-muted shrink-0">
                  {agent.lastActive ? formatTimeAgo(agent.lastActive) : 'Never'}
                </div>
                <Eye className="w-4 h-4 text-text-muted shrink-0" />
              </div>
            )
          })
        )}
      </div>
    </div>
  )
}

// Enhanced Agent Detail View - Full-featured agent management
function AgentDetailModal({ agent, gateway, onClose, socket }) {
  const [activeTab, setActiveTab] = useState('overview')
  const [sessionHistory, setSessionHistory] = useState([])
  const [loading, setLoading] = useState(false)
  const [actionLoading, setActionLoading] = useState(null)
  const [messageText, setMessageText] = useState('')
  const [copied, setCopied] = useState(null)
  
  // Fetch session history when tab changes
  useEffect(() => {
    if (activeTab === 'sessions' && socket) {
      setLoading(true)
      socket.emit('agent:getHistory', { agentId: agent.id, gatewayId: agent.gatewayId }, (response) => {
        setSessionHistory(response?.history || generateMockHistory())
        setLoading(false)
      })
    }
  }, [activeTab, agent.id, agent.gatewayId, socket])
  
  // Generate mock session history if none available
  const generateMockHistory = () => {
    const now = Date.now()
    return [
      { id: 1, type: 'message', role: 'user', content: 'Last user message...', timestamp: new Date(now - 60000).toISOString() },
      { id: 2, type: 'message', role: 'assistant', content: 'Last assistant response...', timestamp: new Date(now - 55000).toISOString() },
      { id: 3, type: 'tool_use', name: 'exec', timestamp: new Date(now - 50000).toISOString() },
    ]
  }
  
  // Copy to clipboard helper
  const copyToClipboard = (text, key) => {
    navigator.clipboard.writeText(text)
    setCopied(key)
    setTimeout(() => setCopied(null), 2000)
  }
  
  // Agent actions
  const handleAction = async (action) => {
    setActionLoading(action)
    socket?.emit(`agent:${action}`, { agentId: agent.id, gatewayId: agent.gatewayId }, (response) => {
      setActionLoading(null)
      // Show feedback
    })
    // Simulate for now
    setTimeout(() => setActionLoading(null), 1500)
  }
  
  const handleSendMessage = () => {
    if (!messageText.trim()) return
    socket?.emit('agent:sendMessage', { 
      agentId: agent.id, 
      gatewayId: agent.gatewayId, 
      message: messageText 
    })
    setMessageText('')
  }
  
  // Performance metrics (calculated or mocked)
  const metrics = {
    avgResponseTime: agent.avgResponseTime || '2.3s',
    successRate: agent.successRate || '98.5%',
    tokensUsed: agent.tokensUsed || '45.2K',
    cost: agent.cost || '$0.34',
    uptime: agent.uptime || '99.9%',
    sessionsToday: agent.sessionsToday || 12
  }
  
  const tabs = [
    { id: 'overview', label: 'Overview', icon: Eye },
    { id: 'sessions', label: 'Sessions', icon: History },
    { id: 'metrics', label: 'Metrics', icon: BarChart3 },
    { id: 'config', label: 'Config', icon: Settings },
    { id: 'actions', label: 'Actions', icon: Terminal }
  ]

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div className="bg-bg-card border border-border-default rounded-xl w-full max-w-3xl max-h-[85vh] flex flex-col overflow-hidden shadow-2xl" onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div className="px-6 py-4 border-b border-border-default flex items-center justify-between shrink-0">
          <div className="flex items-center gap-4">
            <div className={`w-12 h-12 rounded-xl flex items-center justify-center text-2xl ${
              agent.status === 'active' ? 'bg-green-500/20' :
              agent.status === 'error' ? 'bg-red-500/20' :
              'bg-gray-500/20'
            }`}>
              {agent.avatar || '🤖'}
            </div>
            <div>
              <h2 className="text-xl font-semibold flex items-center gap-2">
                {agent.name ? agent.name.charAt(0).toUpperCase() + agent.name.slice(1) : agent.agentId || 'Agent'}
                {agent.status === 'active' && <Zap className="w-4 h-4 text-green-400 animate-pulse" />}
              </h2>
              <p className="text-text-secondary text-sm flex items-center gap-2">
                <Server className="w-3 h-3" />
                {gateway?.name || 'Unknown gateway'}
                <span className="text-text-muted">•</span>
                <span className={`capitalize ${
                  agent.status === 'active' ? 'text-green-400' :
                  agent.status === 'error' ? 'text-red-400' :
                  'text-gray-400'
                }`}>{agent.status || 'idle'}</span>
                {agent.sessionCount > 0 && (
                  <>
                    <span className="text-text-muted">•</span>
                    <span>{agent.sessionCount} session{agent.sessionCount !== 1 ? 's' : ''}</span>
                  </>
                )}
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-2 hover:bg-bg-hover rounded-lg text-text-muted hover:text-text-primary transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>
        
        {/* Tab Navigation */}
        <div className="px-6 py-2 border-b border-border-default flex gap-1 shrink-0 overflow-x-auto">
          {tabs.map(tab => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`px-4 py-2 rounded-lg text-sm font-medium flex items-center gap-2 transition-colors whitespace-nowrap ${
                activeTab === tab.id
                  ? 'bg-blue-600 text-white'
                  : 'text-text-secondary hover:bg-bg-hover hover:text-text-primary'
              }`}
            >
              <tab.icon className="w-4 h-4" />
              {tab.label}
            </button>
          ))}
        </div>
        
        {/* Tab Content */}
        <div className="flex-1 overflow-y-auto p-6">
          {/* Overview Tab */}
          {activeTab === 'overview' && (
            <div className="space-y-6">
              <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
                <InfoCard label="Agent ID" value={agent.agentId || 'N/A'} copyable onCopy={() => copyToClipboard(agent.agentId, 'agentId')} copied={copied === 'agentId'} />
                <InfoCard label="Total Sessions" value={agent.sessionCount || agent.sessions?.length || 0} />
                <InfoCard label="Total Messages" value={agent.totalMessages || agent.messageCount || 0} />
                <InfoCard label="Status" value={agent.status || 'idle'} status={agent.status} />
              </div>
              
              <div className="border-t border-border-default pt-4">
                <h3 className="text-sm font-semibold text-text-secondary mb-3">Timestamps</h3>
                <div className="grid grid-cols-2 gap-4 text-sm">
                  <div>
                    <span className="text-text-muted">Last Active: </span>
                    <span className="text-text-primary">{agent.lastActive ? new Date(agent.lastActive).toLocaleString() : 'Never'}</span>
                  </div>
                  <div>
                    <span className="text-text-muted">Created: </span>
                    <span className="text-text-primary">{agent.createdAt ? new Date(agent.createdAt).toLocaleString() : 'Unknown'}</span>
                  </div>
                </div>
              </div>
              
              {/* Sessions List */}
              {agent.sessions && agent.sessions.length > 0 && (
                <div className="border-t border-border-default pt-4">
                  <h3 className="text-sm font-semibold text-text-secondary mb-3">Active Sessions</h3>
                  <div className="space-y-2">
                    {agent.sessions.map((session, idx) => (
                      <div key={session.sessionKey || idx} className={`bg-bg-hover rounded-lg p-3 border ${
                        session.status === 'active' ? 'border-green-500/30' : 'border-border-default'
                      }`}>
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-2">
                            <span className={`status-dot status-${session.status || 'idle'}`} />
                            <span className="font-medium text-sm">{session.label || session.sessionKey}</span>
                          </div>
                          <div className="flex items-center gap-3 text-xs text-text-muted">
                            {session.channel && (
                              <span className="flex items-center gap-1">
                                <MessageSquare className="w-3 h-3" />
                                {session.channel}
                              </span>
                            )}
                            {session.messageCount > 0 && (
                              <span>{session.messageCount} msgs</span>
                            )}
                            {session.lastActive && (
                              <span className="flex items-center gap-1">
                                <Clock className="w-3 h-3" />
                                {formatTimeAgo(session.lastActive)}
                              </span>
                            )}
                            <button
                              onClick={(e) => {
                                e.stopPropagation()
                                if (confirm(`Close session "${session.label || session.sessionKey}"?`)) {
                                  socket?.emit('session:close', { 
                                    sessionKey: session.sessionKey, 
                                    gatewayId: agent.gatewayId 
                                  }, (response) => {
                                    if (response?.error) {
                                      console.error('Failed to close session:', response.error)
                                    }
                                  })
                                }
                              }}
                              className="p-1 hover:bg-red-500/20 rounded text-text-muted hover:text-red-400 transition-colors"
                              title="Close session"
                            >
                              <X className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              
              {/* Quick Stats */}
              <div className="border-t border-border-default pt-4">
                <h3 className="text-sm font-semibold text-text-secondary mb-3">Quick Stats</h3>
                <div className="grid grid-cols-3 gap-3">
                  <div className="bg-bg-hover rounded-lg p-3 text-center">
                    <p className="text-2xl font-bold text-blue-400">{agent.sessionCount || agent.sessions?.length || 0}</p>
                    <p className="text-xs text-text-muted">Sessions</p>
                  </div>
                  <div className="bg-bg-hover rounded-lg p-3 text-center">
                    <p className="text-2xl font-bold text-green-400">{agent.sessions?.filter(s => s.status === 'active').length || 0}</p>
                    <p className="text-xs text-text-muted">Active Now</p>
                  </div>
                  <div className="bg-bg-hover rounded-lg p-3 text-center">
                    <p className="text-2xl font-bold text-purple-400">{agent.totalMessages || agent.messageCount || 0}</p>
                    <p className="text-xs text-text-muted">Messages</p>
                  </div>
                </div>
              </div>
            </div>
          )}
          
          {/* Sessions Tab */}
          {activeTab === 'sessions' && (
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-semibold text-text-secondary">
                  All Sessions ({agent.sessions?.length || 0})
                </h3>
                <div className="flex items-center gap-2 text-xs text-text-muted">
                  <span className="flex items-center gap-1">
                    <span className="w-2 h-2 rounded-full bg-green-500" />
                    {agent.sessions?.filter(s => s.status === 'active').length || 0} active
                  </span>
                  <span className="flex items-center gap-1">
                    <span className="w-2 h-2 rounded-full bg-gray-500" />
                    {agent.sessions?.filter(s => s.status !== 'active').length || 0} idle
                  </span>
                </div>
              </div>
              
              {(!agent.sessions || agent.sessions.length === 0) ? (
                <div className="text-center py-12 text-text-muted">
                  <History className="w-8 h-8 mx-auto mb-2 opacity-50" />
                  <p>No sessions found</p>
                  <p className="text-xs mt-1">Sessions will appear when the agent is active</p>
                </div>
              ) : (
                <div className="space-y-2">
                  {agent.sessions.map((session, idx) => (
                    <div key={session.sessionKey || idx} className={`bg-bg-hover rounded-lg p-4 border ${
                      session.status === 'active' ? 'border-green-500/30' : 'border-border-default'
                    }`}>
                      <div className="flex items-center justify-between mb-2">
                        <div className="flex items-center gap-2">
                          <span className={`status-dot status-${session.status || 'idle'}`} />
                          <span className="font-medium">{session.label || session.sessionKey}</span>
                          {session.status === 'active' && (
                            <span className="text-xs bg-green-500/20 text-green-400 px-2 py-0.5 rounded">Active</span>
                          )}
                        </div>
                        <button
                          onClick={(e) => {
                            e.stopPropagation()
                            if (confirm(`Close session "${session.label || session.sessionKey}"?`)) {
                              socket?.emit('session:close', { 
                                sessionKey: session.sessionKey, 
                                gatewayId: agent.gatewayId 
                              }, (response) => {
                                if (response?.error) {
                                  alert('Failed to close session: ' + response.error)
                                }
                              })
                            }
                          }}
                          className="p-1.5 hover:bg-red-500/20 rounded text-text-muted hover:text-red-400 transition-colors"
                          title="Close session"
                        >
                          <X className="w-4 h-4" />
                        </button>
                      </div>
                      <div className="flex items-center gap-4 text-xs text-text-muted">
                        {session.channel && (
                          <span className="flex items-center gap-1">
                            <MessageSquare className="w-3 h-3" />
                            {session.channel}
                          </span>
                        )}
                        {session.messageCount > 0 && (
                          <span className="flex items-center gap-1">
                            <MessageSquare className="w-3 h-3" />
                            {session.messageCount} messages
                          </span>
                        )}
                        {session.lastActive && (
                          <span className="flex items-center gap-1">
                            <Clock className="w-3 h-3" />
                            Last active: {formatTimeAgo(session.lastActive)}
                          </span>
                        )}
                      </div>
                      <div className="mt-2 text-xs text-text-muted font-mono bg-bg-dark rounded px-2 py-1 truncate">
                        {session.sessionKey}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
          
          {/* Metrics Tab */}
          {activeTab === 'metrics' && (
            <div className="space-y-6">
              <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
                <MetricCard label="Avg Response Time" value={metrics.avgResponseTime} icon={Clock} color="blue" />
                <MetricCard label="Success Rate" value={metrics.successRate} icon={CheckCircle2} color="green" />
                <MetricCard label="Tokens Used" value={metrics.tokensUsed} icon={Database} color="purple" />
                <MetricCard label="Est. Cost" value={metrics.cost} icon={BarChart3} color="amber" />
                <MetricCard label="Uptime" value={metrics.uptime} icon={Activity} color="cyan" />
                <MetricCard label="Sessions Today" value={metrics.sessionsToday} icon={Users} color="pink" />
              </div>
              
              <div className="border-t border-border-default pt-4">
                <h3 className="text-sm font-semibold text-text-secondary mb-3">Performance Over Time</h3>
                <div className="bg-bg-hover rounded-lg p-4 text-center text-text-muted text-sm">
                  <BarChart3 className="w-8 h-8 mx-auto mb-2 opacity-50" />
                  <p>Performance charts coming soon</p>
                </div>
              </div>
            </div>
          )}
          
          {/* Config Tab */}
          {activeTab === 'config' && (
            <div className="space-y-4">
              <h3 className="text-sm font-semibold text-text-secondary">Agent Configuration</h3>
              
              <div className="bg-bg-dark rounded-lg p-4 font-mono text-sm overflow-x-auto">
                <pre className="text-text-secondary">
{JSON.stringify({
  agentId: agent.agentId || 'N/A',
  name: agent.name,
  channel: agent.channel || 'N/A',
  model: agent.model || 'N/A',
  sessionKey: agent.sessionKey || 'N/A',
  gatewayId: agent.gatewayId,
  status: agent.status || 'idle',
  createdAt: agent.createdAt,
  lastActive: agent.lastActive
}, null, 2)}
                </pre>
              </div>
              
              <div className="border-t border-border-default pt-4">
                <h3 className="text-sm font-semibold text-text-secondary mb-3">Gateway Connection</h3>
                <div className="grid grid-cols-2 gap-4">
                  <InfoCard label="Gateway Name" value={gateway?.name || 'Unknown'} />
                  <InfoCard label="Gateway URL" value={gateway?.url || 'N/A'} copyable onCopy={() => copyToClipboard(gateway?.url, 'gwUrl')} copied={copied === 'gwUrl'} />
                  <InfoCard label="Gateway Status" value={gateway?.status || 'unknown'} status={gateway?.status} />
                  <InfoCard label="Last Health Check" value={gateway?.lastHealthCheck ? formatTimeAgo(gateway.lastHealthCheck) : 'Never'} />
                </div>
              </div>
            </div>
          )}
          
          {/* Actions Tab */}
          {activeTab === 'actions' && (
            <div className="space-y-6">
              <div>
                <h3 className="text-sm font-semibold text-text-secondary mb-3">Agent Controls</h3>
                <div className="grid grid-cols-3 gap-3">
                  <ActionButton
                    icon={RotateCcw}
                    label="Restart"
                    description="Restart agent session"
                    onClick={() => handleAction('restart')}
                    loading={actionLoading === 'restart'}
                    color="blue"
                  />
                  <ActionButton
                    icon={agent.status === 'active' ? Pause : Play}
                    label={agent.status === 'active' ? 'Pause' : 'Resume'}
                    description={agent.status === 'active' ? 'Pause agent activity' : 'Resume agent activity'}
                    onClick={() => handleAction(agent.status === 'active' ? 'pause' : 'resume')}
                    loading={actionLoading === 'pause' || actionLoading === 'resume'}
                    color={agent.status === 'active' ? 'amber' : 'green'}
                  />
                  <ActionButton
                    icon={RefreshCw}
                    label="Refresh"
                    description="Refresh agent data"
                    onClick={() => handleAction('refresh')}
                    loading={actionLoading === 'refresh'}
                    color="purple"
                  />
                </div>
              </div>
              
              <div className="border-t border-border-default pt-4">
                <h3 className="text-sm font-semibold text-text-secondary mb-3">Send Message to Agent</h3>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={messageText}
                    onChange={(e) => setMessageText(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && handleSendMessage()}
                    placeholder="Type a message to inject into the agent session..."
                    className="flex-1 bg-bg-dark border border-border-default rounded-lg px-4 py-2 text-sm focus:outline-none focus:border-blue-500"
                  />
                  <button
                    onClick={handleSendMessage}
                    disabled={!messageText.trim()}
                    className="bg-blue-600 hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed px-4 py-2 rounded-lg flex items-center gap-2 text-sm font-medium transition-colors"
                  >
                    <Send className="w-4 h-4" />
                    Send
                  </button>
                </div>
                <p className="text-xs text-text-muted mt-2">
                  Messages sent here will be injected into the agent's current session
                </p>
              </div>
              
              <div className="border-t border-border-default pt-4">
                <h3 className="text-sm font-semibold text-text-secondary mb-3 text-red-400">Danger Zone</h3>
                <button
                  onClick={() => handleAction('terminate')}
                  className="bg-red-500/10 border border-red-500/30 text-red-400 hover:bg-red-500/20 px-4 py-2 rounded-lg text-sm font-medium transition-colors flex items-center gap-2"
                >
                  <Trash2 className="w-4 h-4" />
                  Terminate Agent
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

// Info Card for detail view
function InfoCard({ label, value, copyable, onCopy, copied, status }) {
  return (
    <div className="bg-bg-hover rounded-lg p-3">
      <p className="text-text-muted text-xs uppercase tracking-wide mb-1">{label}</p>
      <div className="flex items-center gap-2">
        <p className={`text-text-primary truncate text-sm ${
          status === 'active' ? 'text-green-400' :
          status === 'error' ? 'text-red-400' :
          status === 'connected' ? 'text-green-400' :
          ''
        }`}>{value}</p>
        {copyable && (
          <button
            onClick={onCopy}
            className="p-1 hover:bg-bg-card rounded text-text-muted hover:text-text-primary shrink-0"
          >
            {copied ? <Check className="w-3 h-3 text-green-400" /> : <Copy className="w-3 h-3" />}
          </button>
        )}
      </div>
    </div>
  )
}

// Metric Card for metrics tab
function MetricCard({ label, value, icon: Icon, color }) {
  const colorClasses = {
    blue: 'text-blue-400 bg-blue-500/10',
    green: 'text-green-400 bg-green-500/10',
    purple: 'text-purple-400 bg-purple-500/10',
    amber: 'text-amber-400 bg-amber-500/10',
    cyan: 'text-cyan-400 bg-cyan-500/10',
    pink: 'text-pink-400 bg-pink-500/10'
  }
  
  return (
    <div className="bg-bg-hover rounded-lg p-4">
      <div className="flex items-center gap-3">
        <div className={`p-2 rounded-lg ${colorClasses[color]}`}>
          <Icon className="w-5 h-5" />
        </div>
        <div>
          <p className="text-lg font-bold text-text-primary">{value}</p>
          <p className="text-xs text-text-muted">{label}</p>
        </div>
      </div>
    </div>
  )
}

// Action Button for actions tab
function ActionButton({ icon: Icon, label, description, onClick, loading, color }) {
  const colorClasses = {
    blue: 'bg-blue-500/10 border-blue-500/30 text-blue-400 hover:bg-blue-500/20',
    green: 'bg-green-500/10 border-green-500/30 text-green-400 hover:bg-green-500/20',
    amber: 'bg-amber-500/10 border-amber-500/30 text-amber-400 hover:bg-amber-500/20',
    purple: 'bg-purple-500/10 border-purple-500/30 text-purple-400 hover:bg-purple-500/20'
  }
  
  return (
    <button
      onClick={onClick}
      disabled={loading}
      className={`border rounded-lg p-4 text-left transition-colors disabled:opacity-50 ${colorClasses[color]}`}
    >
      <div className="flex items-center gap-2 mb-1">
        {loading ? <Loader2 className="w-5 h-5 animate-spin" /> : <Icon className="w-5 h-5" />}
        <span className="font-medium">{label}</span>
      </div>
      <p className="text-xs text-text-muted">{description}</p>
    </button>
  )
}

function InfoItem({ label, value }) {
  return (
    <div>
      <p className="text-text-muted text-xs uppercase tracking-wide">{label}</p>
      <p className="text-text-primary mt-0.5 truncate">{value}</p>
    </div>
  )
}

// Helper functions
function formatTimeAgo(date) {
  if (!date) return 'Never'
  
  const seconds = Math.floor((new Date() - new Date(date)) / 1000)
  
  if (seconds < 10) return 'Just now'
  if (seconds < 60) return `${seconds}s ago`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`
  return `${Math.floor(seconds / 86400)}d ago`
}

export default App
