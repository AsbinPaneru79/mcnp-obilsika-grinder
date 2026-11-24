require('./patchPrismarineChat');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const BotManager = require('./botManager');

const app = express();
const io = new Server({
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

const CONFIG_PATH = path.join(__dirname, 'config.json');

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Initialize Bot Manager
const botManager = new BotManager(CONFIG_PATH, (eventType, data) => {
  io.emit(eventType, data);
});

// REST API Endpoints
app.get('/api/status', (req, res) => {
  res.json(botManager.getStatus());
});

app.post('/api/start', (req, res) => {
  botManager.start();
  res.json({ success: true, message: 'Bot started' });
});

app.post('/api/stop', (req, res) => {
  botManager.stop();
  res.json({ success: true, message: 'Bot stopped' });
});

app.post('/api/rerun', (req, res) => {
  const result = botManager.rerunRoutine();
  res.json(result);
});

app.post('/api/chat', (req, res) => {
  const { message } = req.body;
  if (!message) {
    return res.status(400).json({ success: false, error: 'Message is required' });
  }
  const result = botManager.sendChat(message);
  res.json(result);
});

app.get('/api/config', (req, res) => {
  res.json(botManager.config);
});

app.post('/api/config', (req, res) => {
  const newConfig = req.body;
  const result = botManager.saveConfig(newConfig);
  if (result.success) {
    io.emit('config_updated', botManager.config);
    res.json({ success: true, config: botManager.config });
  } else {
    res.status(500).json({ success: false, error: result.error });
  }
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'ok',
    bot: botManager.config.username,
    state: botManager.state,
    uptime: Math.floor(process.uptime())
  });
});

// Socket.IO Events
io.on('connection', (socket) => {
  socket.emit('init', botManager.getStatus());

  socket.on('send_chat', (msg) => {
    botManager.sendChat(msg);
  });

  socket.on('start_bot', () => {
    botManager.start();
  });

  socket.on('stop_bot', () => {
    botManager.stop();
  });

  socket.on('save_config', (cfg) => {
    botManager.saveConfig(cfg);
    io.emit('config_updated', botManager.config);
  });
});

// Start multi-port listeners for Railway / Fly / Cloud deployment compatibility
const targetPorts = new Set();
if (process.env.PORT) {
  targetPorts.add(parseInt(process.env.PORT, 10));
}
targetPorts.add(3000);
targetPorts.add(8080);

targetPorts.forEach((port) => {
  try {
    const srv = http.createServer(app);
    io.attach(srv);
    srv.listen(port, '0.0.0.0', () => {
      console.log(`[Web Server] HTTP server and Dashboard listening on 0.0.0.0:${port}`);
    });
    srv.on('error', (err) => {
      if (err.code !== 'EADDRINUSE') {
        console.warn(`[Web Server] Warning on port ${port}:`, err.message);
      }
    });
  } catch (e) {
    // ignore
  }
});

// Automatically start bot on application launch
console.log(`[AutoStart] Launching ${botManager.config.username} bot on mcnp.network...`);
botManager.start();
