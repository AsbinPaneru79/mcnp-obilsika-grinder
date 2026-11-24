/**
 * MCNP Playtime & Survival AFK Grinder
 * Dedicated for: ObilSika_ on mcnp.network
 *
 * Sequence:
 * 1. Connect to mcnp.network (auth: offline)
 * 2. Authenticate via /login tynorix
 * 3. Switch to 2nd hotbar slot (slot index 1)
 * 4. Right-click held item to open Game Modes GUI
 * 5. Locate and click the blue Diamond Pickaxe (Slot 11) to transfer to Survival
 * 6. Send /afk in chat to toggle AFK mode
 * 7. Auto-reconnect indefinitely upon kick/disconnect/error
 *
 * Anti-Cheat Protection:
 * - Removed /sit to avoid sitting vehicle position locks and anticheat conflicts
 * - Relies on server-native /afk for safe, permanent 24/7 playtime grinding
 */

require('./patchPrismarineChat');
try { require('dotenv').config(); } catch (e) {}
const http = require('http');
const mineflayer = require('mineflayer');

// Configuration
const CONFIG = {
  host: process.env.MC_HOST || 'mcnp.network',
  port: parseInt(process.env.MC_PORT, 10) || 25565,
  username: process.env.MC_USERNAME || '_ObilSika_',
  loginPassword: process.env.MC_PASSWORD || 'tynorix',
  version: process.env.MC_VERSION || false, // false auto-detects version

  hotbarSlot: parseInt(process.env.HOTBAR_SLOT, 10) || 2, // 2nd slot = index 1
  guiTargetItem: (process.env.GUI_TARGET_ITEM || 'diamond_pickaxe').toLowerCase(),
  guiTargetSlot: process.env.GUI_TARGET_SLOT !== undefined ? parseInt(process.env.GUI_TARGET_SLOT, 10) : 11,

  postCommands: ['/afk'],
  postCommandsDelayMs: 4000,

  autoReconnect: process.env.AUTO_RECONNECT !== 'false',
  reconnectDelayMs: parseInt(process.env.RECONNECT_DELAY_MS, 10) || 8000,

  webPort: parseInt(process.env.PORT, 10) || 3000
};

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let bot = null;
let isReconnecting = false;
let menuRetryInterval = null;
let survivalTimer = null;
let afkCheckInterval = null;
let isAfk = false;

// State flags
let hasLoggedIn = false;
let hasClickedGui = false;
let inSurvival = false;
let postCommandsSent = false;
let isNavigating = false;

// 1. Lightweight Web Server for Health Checks (Railway / Fly.io / UptimeRobot)
function handleHealthCheck(req, res) {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  const status = {
    bot: CONFIG.username,
    server: `${CONFIG.host}:${CONFIG.port}`,
    status: bot && bot.entity ? 'ONLINE' : (isReconnecting ? 'RECONNECTING' : 'OFFLINE'),
    inSurvival: inSurvival,
    uptimeSeconds: Math.floor(process.uptime()),
    timestamp: new Date().toISOString()
  };
  res.end(JSON.stringify(status, null, 2));
}

const primaryServer = http.createServer(handleHealthCheck);
primaryServer.listen(CONFIG.webPort, '0.0.0.0', () => {
  console.log(`[Web Server] HTTP health-check listening on 0.0.0.0:${CONFIG.webPort}`);
});

// Secondary port listener (if port is 3000, listen also on 8080 and vice versa)
const secondaryPort = CONFIG.webPort === 8080 ? 3000 : 8080;
try {
  const secondaryServer = http.createServer(handleHealthCheck);
  secondaryServer.listen(secondaryPort, '0.0.0.0', () => {
    console.log(`[Web Server] Secondary listener active on 0.0.0.0:${secondaryPort}`);
  });
  secondaryServer.on('error', () => {});
} catch (e) {}

function clearAllTimers() {
  if (menuRetryInterval) {
    clearInterval(menuRetryInterval);
    menuRetryInterval = null;
  }
  if (survivalTimer) {
    clearTimeout(survivalTimer);
    survivalTimer = null;
  }
  if (afkCheckInterval) {
    clearInterval(afkCheckInterval);
    afkCheckInterval = null;
  }
  isAfk = false;
}

// 2. Main Bot Factory
function createBot() {
  if (bot) {
    bot.removeAllListeners();
    bot = null;
  }

  clearAllTimers();
  hasLoggedIn = false;
  hasClickedGui = false;
  inSurvival = false;
  postCommandsSent = false;
  isNavigating = false;

  console.log(`\n======================================================`);
  console.log(`[Bot] Connecting to ${CONFIG.host}:${CONFIG.port} as "${CONFIG.username}"...`);
  console.log(`======================================================`);

  bot = mineflayer.createBot({
    host: CONFIG.host,
    port: CONFIG.port,
    username: CONFIG.username,
    version: CONFIG.version || undefined,
    auth: 'offline',
    checkTimeoutInterval: 60000
  });

  // Login packet received
  bot.on('login', () => {
    console.log(`[Bot] Connected to server protocol. Preparing authentication...`);

    // Backup login trigger in case server does not broadcast /login in chat
    setTimeout(() => {
      if (bot && !hasLoggedIn) {
        console.log(`[Auth] Auto-login timer fired. Sending /login command...`);
        executeLoginCommand();
      }
    }, 2500);
  });

  // Chat message listener
  bot.on('message', async (jsonMsg) => {
    const raw = jsonMsg.toString().trim();
    if (raw) {
      console.log(`[Chat] ${raw}`);
    }

    const lower = raw.toLowerCase();

    // Check for register prompt
    if ((lower.includes('/register') || lower.includes('please register') || lower.includes('type /register')) && !hasLoggedIn) {
      console.log(`[Auth] Register prompt detected in chat! Executing register...`);
      executeRegisterCommand();
    }
    // Check for login prompt
    else if ((lower.includes('/login') || lower.includes('please login') || lower.includes('type /login')) && !hasLoggedIn) {
      console.log(`[Auth] Login prompt detected in chat! Executing login...`);
      executeLoginCommand();
    }

    // Check for auth success
    if (lower.includes('successful') || lower.includes('logged in') || lower.includes('registered') || lower.includes('welcome back')) {
      console.log(`[Auth] Auth confirmed! Proceeding to Lobby routine...`);
      setTimeout(() => {
        if (!hasClickedGui && bot) {
          startLobbyRoutine();
        }
      }, 2000);
    }

    // Detect Survival chat announcement to trigger /afk
    if (hasClickedGui && !inSurvival) {
      if (lower.includes('dailyquests') || lower.includes('vote for us') || lower.includes(CONFIG.username.toLowerCase())) {
        console.log('[Bot] Survival arrival detected in chat! Triggering /afk routine...');
        scheduleSurvivalCommands();
      }
    }

    // Check for AFK status confirmations and cancellations
    if (lower.includes('now afk') || lower.includes('you are now afk')) {
      isAfk = true;
      console.log('[AFK] Confirmed: Bot is NOW AFK on the server!');
    } else if (lower.includes('no longer afk') || lower.includes('not afk')) {
      isAfk = false;
      console.log('[AFK] Server indicates AFK cancelled. Re-sending /afk in 2s...');
      setTimeout(() => {
        if (bot && inSurvival) sendAfk();
      }, 2000);
    }
  });

  // Spawn event (Triggers on Lobby join and Survival join)
  bot.on('spawn', () => {
    console.log('[Bot] World spawn event detected.');

    if (hasClickedGui) {
      console.log('[Bot] Arrived in Survival world spawn! Triggering /afk routine...');
      scheduleSurvivalCommands();
      return;
    }

    if (!hasLoggedIn) {
      executeLoginCommand();
    }

    if (!hasClickedGui) {
      // In Lobby / Auth
      setTimeout(() => {
        if (!hasClickedGui && bot) {
          startLobbyRoutine();
        }
      }, 2500);
    }
  });

  // Server transfer detection (BungeeCord / Velocity server switch)
  bot.on('respawn', () => {
    console.log('[Bot] Server transfer / respawn packet received.');

    if (hasClickedGui) {
      console.log('[Bot] Transferred to Survival server!');
      scheduleSurvivalCommands();
    } else {
      console.log('[Bot] Transferred to Lobby server. Starting menu selector routine...');
      setTimeout(() => {
        if (!hasClickedGui && bot) {
          startLobbyRoutine();
        }
      }, 2500);
    }
  });

  // Chest GUI Handler (Matches the 27-slot GAMEMODES selector)
  bot.on('windowOpen', async (window) => {
    const title = window.title || 'Chest GUI';
    console.log(`[GUI] Window opened: "${title}" (${window.slots.length} slots)`);

    if (menuRetryInterval) {
      clearInterval(menuRetryInterval);
      menuRetryInterval = null;
    }

    // Allow window items to populate from the server
    await delay(1000);

    if (!bot || hasClickedGui) return;

    let targetSlot = CONFIG.guiTargetSlot !== null ? CONFIG.guiTargetSlot : 11;
    let foundItem = null;

    // Scan window slots dynamically for diamond_pickaxe
    for (let i = 0; i < window.slots.length; i++) {
      const item = window.slots[i];
      if (!item) continue;
      const name = (item.name || '').toLowerCase();
      if (name.includes(CONFIG.guiTargetItem)) {
        targetSlot = i;
        foundItem = item;
        console.log(`[GUI] Detected target "${item.name}" at slot ${i}!`);
        break;
      }
    }

    if (!foundItem && window.slots[11]) {
      targetSlot = 11;
      console.log(`[GUI] Using primary target slot 11 (Diamond Pickaxe from screenshot layout)`);
    }

    console.log(`[GUI] Clicking slot ${targetSlot} (Blue Diamond Pickaxe) to join Survival...`);
    try {
      hasClickedGui = true;
      await bot.clickWindow(targetSlot, 0, 0); // Mode 0, button 0 = left click
      console.log('[GUI] Click registered! Waiting for Survival transfer...');

      // Fallback survival command scheduler (in case respawn packet is swallowed)
      survivalTimer = setTimeout(() => {
        if (!inSurvival && bot) {
          scheduleSurvivalCommands();
        }
      }, CONFIG.postCommandsDelayMs);

    } catch (err) {
      console.error(`[GUI] Click failed: ${err.message}`);
      // Retry once after 1 second if window is still open
      setTimeout(async () => {
        if (!inSurvival && bot && bot.currentWindow) {
          console.log(`[GUI] Retrying click on slot ${targetSlot}...`);
          try {
            await bot.clickWindow(targetSlot, 0, 0);
            hasClickedGui = true;
          } catch (e) {
            console.error(`[GUI] Retry click failed: ${e.message}`);
          }
        }
      }, 1000);
    }
  });

  // Disconnect, Kick, and Error Handling
  bot.on('kicked', (reason) => {
    const r = typeof reason === 'object' ? JSON.stringify(reason) : String(reason);
    console.warn(`[Bot] Kicked from server: ${r}`);
    triggerReconnect();
  });

  bot.on('error', (err) => {
    console.error(`[Bot] Connection error: ${err.message}`);
    triggerReconnect();
  });

  bot.on('end', (reason) => {
    console.warn(`[Bot] Disconnected from server: ${reason || 'Connection lost'}`);
    triggerReconnect();
  });
}

// 3. Helper Functions
function executeRegisterCommand() {
  if (!bot || hasLoggedIn) return;
  console.log(`[Auth] Sending: /register ${CONFIG.loginPassword} ${CONFIG.loginPassword}`);
  bot.chat(`/register ${CONFIG.loginPassword} ${CONFIG.loginPassword}`);
  hasLoggedIn = true;
}

function executeLoginCommand() {
  if (!bot || hasLoggedIn) return;
  console.log(`[Auth] Sending: /login ${CONFIG.loginPassword}`);
  bot.chat(`/login ${CONFIG.loginPassword}`);
  hasLoggedIn = true;
}

function startLobbyRoutine() {
  if (hasClickedGui || menuRetryInterval) return;

  const quickBarIndex = Math.max(0, Math.min(8, CONFIG.hotbarSlot - 1)); // Slot 2 = quickbar index 1
  let attempts = 0;

  const attemptOpenMenu = () => {
    if (!bot || hasClickedGui || inSurvival) {
      if (menuRetryInterval) {
        clearInterval(menuRetryInterval);
        menuRetryInterval = null;
      }
      return;
    }

    attempts++;
    console.log(`[Lobby] [Attempt ${attempts}/8] Selecting 2nd hotbar slot (index ${quickBarIndex}) & activating item...`);

    try {
      bot.setQuickBarSlot(quickBarIndex);

      setTimeout(() => {
        if (!bot || hasClickedGui) return;
        try {
          bot.activateItem(); // Right click held item cleanly without forcing look packets
        } catch (e) {
          console.warn(`[Lobby] Error activating item: ${e.message}`);
        }
      }, 400);

    } catch (err) {
      console.error(`[Lobby] Failed to set quickbar slot: ${err.message}`);
    }

    if (attempts >= 8) {
      console.warn('[Lobby] Max attempts reached for opening GUI.');
      if (menuRetryInterval) {
        clearInterval(menuRetryInterval);
        menuRetryInterval = null;
      }
    }
  };

  attemptOpenMenu();
  menuRetryInterval = setInterval(attemptOpenMenu, 2500);
}

function sendAfk() {
  if (!bot) return;
  console.log('[Bot] Sending: /afk');
  bot.chat('/afk');
}

function scheduleSurvivalCommands() {
  if (inSurvival && postCommandsSent) return;
  inSurvival = true;
  postCommandsSent = true;

  clearAllTimers();

  console.log('\n======================================================');
  console.log('[Bot] Arrived in Survival server! Scheduling /afk command...');
  console.log('======================================================');

  // Allow 3.5 seconds for world chunks and player position to fully settle
  setTimeout(() => {
    if (!bot) return;
    sendAfk();

    // Backup check after 5 seconds: if not confirmed AFK, send /afk again
    setTimeout(() => {
      if (bot && inSurvival && !isAfk) {
        console.log('[Bot] AFK not confirmed yet, sending /afk backup...');
        sendAfk();
      }
    }, 5000);
  }, 3500);

  // Periodic AFK guard: every 10 minutes, verify /afk
  if (afkCheckInterval) clearInterval(afkCheckInterval);
  afkCheckInterval = setInterval(() => {
    if (bot && inSurvival && !isAfk) {
      console.log('[Bot] Periodic check: Re-asserting /afk status...');
      sendAfk();
    }
  }, 10 * 60 * 1000);
}

function triggerReconnect() {
  if (isReconnecting) return;
  isReconnecting = true;
  clearAllTimers();

  if (bot) {
    try { bot.quit(); } catch (e) {}
    bot = null;
  }

  if (!CONFIG.autoReconnect) {
    console.log('[Bot] Auto-reconnect is disabled.');
    return;
  }

  console.log(`[Bot] Reconnecting in ${CONFIG.reconnectDelayMs / 1000} seconds...`);
  setTimeout(() => {
    isReconnecting = false;
    createBot();
  }, CONFIG.reconnectDelayMs);
}

// Start bot
createBot();
