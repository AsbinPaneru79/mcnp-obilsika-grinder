require('./patchPrismarineChat');
const mineflayer = require('mineflayer');
const fs = require('fs');
const path = require('path');

class BotManager {
  constructor(configPath, onEvent) {
    this.configPath = configPath;
    this.onEvent = onEvent || (() => {});
    this.bot = null;
    this.config = this.loadConfig();
    this.isManualStop = false;
    this.reconnectTimer = null;
    this.antiAfkTimer = null;
    this.menuRetryInterval = null;
    this.survivalTimer = null;
    this.afkCheckInterval = null;
    this.isAfk = false;
    this.state = 'offline';
    
    // Stage flags
    this.loginSent = false;
    this.inLobby = false;
    this.hasClickedGui = false;
    this.inSurvival = false;
    this.postCommandsSent = false;

    this.chatHistory = [];
    this.actionLogs = [];
  }

  loadConfig() {
    try {
      if (fs.existsSync(this.configPath)) {
        const raw = fs.readFileSync(this.configPath, 'utf8');
        return JSON.parse(raw);
      }
    } catch (err) {
      console.error('Failed to load config.json:', err);
    }
    return {
      host: 'mcnp.network',
      port: 25565,
      username: '_ObilSika_',
      auth: 'offline',
      version: false,
      password: 'tynorix',
      autoLogin: true,
      loginDelayMs: 2500,
      hotbarSlot: 2,
      useItemAfterSwitch: true,
      useItemDelayMs: 1500,
      guiTargetMode: 'name_or_slot',
      guiTargetItem: 'diamond_pickaxe',
      guiTargetSlot: 11,
      postCommands: ['/afk'],
      postCommandsDelayMs: 4000,
      autoReconnect: true,
      reconnectDelayMs: 8000,
      antiAfk: false,
      antiAfkIntervalMs: 30000
    };
  }

  saveConfig(newConfig) {
    try {
      this.config = { ...this.config, ...newConfig };
      fs.writeFileSync(this.configPath, JSON.stringify(this.config, null, 2), 'utf8');
      this.log('system', 'Configuration saved successfully.');
      return { success: true, config: this.config };
    } catch (err) {
      this.log('error', `Failed to save configuration: ${err.message}`);
      return { success: false, error: err.message };
    }
  }

  log(type, text) {
    const entry = {
      timestamp: new Date().toLocaleTimeString(),
      type,
      text
    };
    this.actionLogs.push(entry);
    if (this.actionLogs.length > 300) this.actionLogs.shift();
    this.onEvent('log', entry);
    console.log(`[${entry.timestamp}] [${type.toUpperCase()}] ${text}`);
  }

  updateState(newState, details = '') {
    this.state = newState;
    this.onEvent('state', { state: this.state, details });
    this.log('status', `Status: ${newState.toUpperCase()} ${details ? `- ${details}` : ''}`);
  }

  clearTimers() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.menuRetryInterval) {
      clearInterval(this.menuRetryInterval);
      this.menuRetryInterval = null;
    }
    if (this.survivalTimer) {
      clearTimeout(this.survivalTimer);
      this.survivalTimer = null;
    }
    if (this.afkCheckInterval) {
      clearInterval(this.afkCheckInterval);
      this.afkCheckInterval = null;
    }
    this.isAfk = false;
    this.stopAntiAfk();
  }

  start() {
    if (this.bot) {
      this.log('warn', 'Bot is already running or connecting.');
      return;
    }

    this.clearTimers();
    this.isManualStop = false;
    this.loginSent = false;
    this.inLobby = false;
    this.hasClickedGui = false;
    this.inSurvival = false;
    this.postCommandsSent = false;

    this.updateState('connecting', `Connecting to ${this.config.host}:${this.config.port} as ${this.config.username}`);

    const botOptions = {
      host: this.config.host,
      port: parseInt(this.config.port, 10) || 25565,
      username: this.config.username,
      auth: this.config.auth || 'offline',
      checkTimeoutInterval: 60000,
      hideErrors: false
    };

    if (this.config.version && typeof this.config.version === 'string' && this.config.version.trim() !== '') {
      botOptions.version = this.config.version.trim();
    }

    try {
      this.bot = mineflayer.createBot(botOptions);
      this.bindBotEvents();
    } catch (err) {
      this.log('error', `Bot creation error: ${err.message}`);
      this.updateState('error', err.message);
      this.handleAutoReconnect();
    }
  }

  stop() {
    this.isManualStop = true;
    this.clearTimers();
    if (this.bot) {
      this.log('system', 'Stopping bot by user request...');
      try {
        this.bot.quit();
      } catch (e) {
        // ignore
      }
      this.bot = null;
    }
    this.updateState('stopped', 'Bot manually stopped');
  }

  bindBotEvents() {
    const bot = this.bot;

    bot.on('login', () => {
      this.log('minecraft', `Bot connected to protocol. Preparing authentication...`);
      this.updateState('logging_in', 'Connected to Auth Gateway');

      // Auto login backup timer: If no chat prompt is detected within 2.5 seconds, send login command anyway
      setTimeout(() => {
        if (this.bot && !this.loginSent) {
          this.log('system', 'Auto-login backup timer fired. Executing login command...');
          this.executeLoginCommand();
        }
      }, parseInt(this.config.loginDelayMs, 10) || 2500);
    });

    bot.on('spawn', () => {
      const pos = bot.entity?.position ? bot.entity.position.floored() : 'unknown';
      this.log('minecraft', `Bot world spawn detected at ${pos}`);

      if (!this.loginSent) {
        this.executeLoginCommand();
      }

      // If we clicked GUI and arrive in Survival
      if (this.hasClickedGui) {
        this.log('system', 'World spawn in Survival detected! Triggering /afk routine...');
        this.scheduleSurvivalCommands();
        return;
      }

      // If we haven't clicked GUI yet, start lobby routine
      setTimeout(() => {
        if (!this.hasClickedGui && this.bot) {
          this.startLobbyRoutine();
        }
      }, 2500);
    });

    // Detect server transfer (e.g. Auth -> Lobby or Lobby -> Survival)
    bot.on('respawn', () => {
      this.log('minecraft', 'Server transfer / respawn packet received.');

      if (this.hasClickedGui) {
        this.log('system', 'Server transfer to Survival detected! Triggering /afk routine...');
        this.scheduleSurvivalCommands();
      } else {
        this.log('system', 'Transferred to Lobby. Initializing server selector sequence...');
        setTimeout(() => {
          if (!this.hasClickedGui && this.bot) {
            this.startLobbyRoutine();
          }
        }, 2500);
      }
    });

    bot.on('message', (jsonMsg) => {
      const plainText = jsonMsg.toString().trim();
      if (!plainText) return;

      const chatEntry = {
        timestamp: new Date().toLocaleTimeString(),
        text: plainText
      };
      this.chatHistory.push(chatEntry);
      if (this.chatHistory.length > 300) this.chatHistory.shift();
      this.onEvent('chat', chatEntry);

      const lower = plainText.toLowerCase();

      // Check for /register prompt
      if ((lower.includes('/register') || lower.includes('please register') || lower.includes('type /register')) && !this.loginSent) {
        this.log('system', 'Server requested /register. Executing...');
        this.executeRegisterCommand();
      }
      // Check for /login prompt
      else if ((lower.includes('/login') || lower.includes('please login') || lower.includes('type /login')) && !this.loginSent) {
        this.log('system', 'Server requested /login. Executing...');
        this.executeLoginCommand();
      }

      // Check for login / register success
      if (lower.includes('successful') || lower.includes('logged in') || lower.includes('registered') || lower.includes('welcome back') || lower.includes('auth')) {
        this.log('system', 'Auth acknowledged. Moving to Lobby...');
        this.inLobby = true;
        setTimeout(() => {
          if (!this.hasClickedGui && this.bot) {
            this.startLobbyRoutine();
          }
        }, 2500);
      }

      // Detect Survival join announcements to guarantee /afk is sent
      if (this.hasClickedGui && !this.inSurvival) {
        if (lower.includes('dailyquests') || lower.includes('vote for us') || lower.includes(this.config.username.toLowerCase())) {
          this.log('system', 'Survival arrival confirmed via chat. Triggering /afk...');
          this.scheduleSurvivalCommands();
        }
      }

      // Detect AFK state confirmations and cancellations
      if (lower.includes('now afk') || lower.includes('you are now afk')) {
        this.isAfk = true;
        this.log('system', 'AFK mode confirmed active: ' + plainText);
        this.updateState('in_survival', 'AFK Active');
      } else if (lower.includes('no longer afk') || lower.includes('not afk')) {
        this.isAfk = false;
        this.log('warn', 'Server indicates AFK cancelled. Re-sending /afk in 2s...');
        setTimeout(() => {
          if (this.bot && this.inSurvival) {
            this.sendAfk();
          }
        }, 2000);
      }
    });

    // Window open event (Chest GUI)
    bot.on('windowOpen', (window) => {
      this.handleWindowOpen(window);
    });

    bot.on('kicked', (reason) => {
      let kickReason = '';
      try {
        kickReason = typeof reason === 'string' ? reason : JSON.stringify(reason);
      } catch (e) {
        kickReason = 'Unknown kick reason';
      }
      this.log('error', `Bot was kicked: ${kickReason}`);
      this.updateState('kicked', kickReason);
    });

    bot.on('end', (reason) => {
      this.log('warn', `Connection ended: ${reason || 'Disconnected'}`);
      this.clearTimers();
      this.bot = null;
      if (!this.isManualStop) {
        this.updateState('offline', 'Disconnected');
        this.handleAutoReconnect();
      } else {
        this.updateState('stopped', 'Stopped by user');
      }
    });

    bot.on('error', (err) => {
      this.log('error', `Bot error: ${err.message}`);
      this.updateState('error', err.message);
    });
  }

  executeRegisterCommand() {
    if (!this.bot || this.loginSent) return;
    const pwd = this.config.password || 'tynorix';
    this.log('command', `Sending: /register ${pwd} ${pwd}`);
    this.bot.chat(`/register ${pwd} ${pwd}`);
    this.loginSent = true;
  }

  executeLoginCommand() {
    if (!this.bot || this.loginSent) return;
    const pwd = this.config.password || 'tynorix';
    this.log('command', `Sending: /login ${pwd}`);
    this.bot.chat(`/login ${pwd}`);
    this.loginSent = true;
  }

  startLobbyRoutine() {
    if (this.hasClickedGui || this.menuRetryInterval) return;

    this.log('action', 'Starting Lobby Routine: Selecting Server Selector Item...');
    this.updateState('opening_menu', 'Selecting Hotbar Item in Lobby');

    const slotNumber = parseInt(this.config.hotbarSlot, 10) || 2;
    const quickBarIndex = Math.max(0, Math.min(8, slotNumber - 1));

    let attempts = 0;

    const attemptOpenMenu = () => {
      if (!this.bot || this.hasClickedGui || this.inSurvival) {
        if (this.menuRetryInterval) {
          clearInterval(this.menuRetryInterval);
          this.menuRetryInterval = null;
        }
        return;
      }

      attempts++;
      this.log('action', `[Attempt ${attempts}/8] Switching to hotbar slot ${slotNumber} (index ${quickBarIndex}) & activating item...`);

      try {
        // Set hotbar slot (slot 2 = index 1)
        this.bot.setQuickBarSlot(quickBarIndex);

        setTimeout(() => {
          if (!this.bot || this.hasClickedGui) return;
          try {
            this.bot.activateItem(); // Right click held item cleanly
          } catch (e) {
            this.log('warn', `Error activating item: ${e.message}`);
          }
        }, 400);

      } catch (err) {
        this.log('error', `Failed to set hotbar slot: ${err.message}`);
      }

      if (attempts >= 8) {
        this.log('warn', 'Max attempts reached for opening server selector.');
        if (this.menuRetryInterval) {
          clearInterval(this.menuRetryInterval);
          this.menuRetryInterval = null;
        }
      }
    };

    attemptOpenMenu();
    this.menuRetryInterval = setInterval(attemptOpenMenu, 2500);
  }

  handleWindowOpen(window) {
    if (this.menuRetryInterval) {
      clearInterval(this.menuRetryInterval);
      this.menuRetryInterval = null;
    }

    const title = window.title || 'Chest';
    const totalSlots = window.slots.length;
    this.log('minecraft', `Server Selector GUI opened: "${title}" (${totalSlots} slots)`);
    this.updateState('clicking_item', `GUI "${title}" open`);

    // Give the server 800ms to send slot items
    setTimeout(async () => {
      if (!this.bot || this.hasClickedGui) return;

      const targetSlot = parseInt(this.config.guiTargetSlot, 10) !== undefined ? parseInt(this.config.guiTargetSlot, 10) : 11;
      const targetItemName = (this.config.guiTargetItem || 'diamond_pickaxe').toLowerCase();

      let clickIndex = targetSlot;

      // Scan window items to see if target item is located at another slot
      for (let i = 0; i < window.slots.length; i++) {
        const item = window.slots[i];
        if (!item) continue;
        const itemName = (item.name || '').toLowerCase();
        if (itemName.includes(targetItemName)) {
          clickIndex = i;
          this.log('action', `Found target "${item.name}" at slot ${i}!`);
          break;
        }
      }

      this.log('action', `Clicking slot ${clickIndex} (Diamond Pickaxe) to join Survival...`);

      try {
        await this.bot.clickWindow(clickIndex, 0, 0);
        this.hasClickedGui = true;
        this.updateState('transferring', `Clicked slot ${clickIndex}. Joining Survival...`);

        // Schedule survival commands after transfer delay
        const delay = parseInt(this.config.postCommandsDelayMs, 10) || 5000;
        this.survivalTimer = setTimeout(() => {
          if (!this.inSurvival && this.bot) {
            this.scheduleSurvivalCommands();
          }
        }, delay);

      } catch (err) {
        this.log('error', `Failed to click slot ${clickIndex}: ${err.message}`);
        setTimeout(async () => {
          if (!this.hasClickedGui && this.bot && this.bot.currentWindow) {
            this.log('action', `Retrying click on slot ${clickIndex}...`);
            try {
              await this.bot.clickWindow(clickIndex, 0, 0);
              this.hasClickedGui = true;
            } catch (e) {
              this.log('error', `Retry click failed: ${e.message}`);
            }
          }
        }, 1000);
      }
    }, 800);
  }

  scheduleSurvivalCommands() {
    if (this.inSurvival && this.postCommandsSent) return;
    this.inSurvival = true;
    this.postCommandsSent = true;

    if (this.menuRetryInterval) {
      clearInterval(this.menuRetryInterval);
      this.menuRetryInterval = null;
    }

    this.log('system', 'Bot entered Survival server! Preparing /afk command...');
    this.updateState('in_survival', 'Survival Mode Active');

    // Wait 3.5 seconds for chunks and player entity to settle
    setTimeout(() => {
      if (!this.bot) return;
      this.sendAfk();

      // Backup check: If not confirmed AFK after 5 seconds, send /afk again
      setTimeout(() => {
        if (this.bot && this.inSurvival && !this.isAfk) {
          this.log('system', 'AFK not yet confirmed, re-sending /afk backup...');
          this.sendAfk();
        }
      }, 5000);
    }, 3500);

    // Periodic AFK maintenance: every 10 minutes, verify AFK status
    if (this.afkCheckInterval) clearInterval(this.afkCheckInterval);
    this.afkCheckInterval = setInterval(() => {
      if (this.bot && this.inSurvival && !this.isAfk) {
        this.log('system', 'Periodic check: Re-asserting /afk status...');
        this.sendAfk();
      }
    }, 10 * 60 * 1000);
  }

  sendAfk() {
    if (!this.bot) return { success: false, error: 'Bot is not connected' };
    this.log('command', 'Sending: /afk');
    this.bot.chat('/afk');
    return { success: true, message: 'Sent /afk command' };
  }

  startAntiAfk() {
    // Disabled to avoid LPX Malicious Location Spoof while sitting
    this.stopAntiAfk();
  }

  stopAntiAfk() {
    if (this.antiAfkTimer) {
      clearInterval(this.antiAfkTimer);
      this.antiAfkTimer = null;
    }
  }

  handleAutoReconnect() {
    if (this.isManualStop || !this.config.autoReconnect) {
      return;
    }

    const delay = parseInt(this.config.reconnectDelayMs, 10) || 8000;
    this.log('system', `Auto-reconnect scheduled in ${delay / 1000}s...`);

    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => {
      if (!this.isManualStop) {
        this.log('system', 'Reconnecting now...');
        this.start();
      }
    }, delay);
  }

  sendChat(msg) {
    if (!this.bot) {
      return { success: false, error: 'Bot is not currently connected.' };
    }
    const clean = msg.trim();
    if (!clean) {
      return { success: false, error: 'Message cannot be empty.' };
    }
    this.log('user_chat', `Manual command sent: ${clean}`);
    this.bot.chat(clean);
    return { success: true };
  }

  rerunRoutine() {
    if (!this.bot) {
      this.start();
      return { success: true, message: 'Bot started and executing routine.' };
    }
    this.hasClickedGui = false;
    this.inSurvival = false;
    this.postCommandsSent = false;
    this.log('system', 'Manually re-running Lobby -> Survival routine...');
    this.startLobbyRoutine();
    return { success: true, message: 'Routine restarted.' };
  }

  getStatus() {
    return {
      state: this.state,
      isAfk: this.isAfk,
      isManualStop: this.isManualStop,
      botUsername: this.config.username,
      host: this.config.host,
      port: this.config.port,
      health: this.bot?.health || null,
      food: this.bot?.food || null,
      position: this.bot?.entity?.position ? this.bot.entity.position.floored() : null,
      config: this.config,
      recentLogs: this.actionLogs.slice(-50),
      recentChat: this.chatHistory.slice(-50)
    };
  }
}

module.exports = BotManager;
