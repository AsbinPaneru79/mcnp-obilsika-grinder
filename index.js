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
  username: process.env.MC_USERNAME || 'KrishhnaKazi',
  loginPassword: process.env.MC_PASSWORD || 'tynorix',
  version: process.env.MC_VERSION || false, // false auto-detects version

  hotbarSlot: parseInt(process.env.HOTBAR_SLOT, 10) || 2, // 2nd slot = index 1
  guiTargetItem: (process.env.GUI_TARGET_ITEM || 'diamond_pickaxe').toLowerCase(),
  guiTargetSlot: process.env.GUI_TARGET_SLOT !== undefined ? parseInt(process.env.GUI_TARGET_SLOT, 10) : 11,

  postCommands: [],
  postCommandsDelayMs: 4000,

  autoClicker: process.env.AUTO_CLICKER !== 'false',
  autoClickIntervalMs: parseInt(process.env.AUTO_CLICK_INTERVAL_MS, 10) || 60000,

  autoReconnect: process.env.AUTO_RECONNECT !== 'false',
  reconnectDelayMs: parseInt(process.env.RECONNECT_DELAY_MS, 10) || 8000,

  webPort: parseInt(process.env.PORT, 10) || 3000
};

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function normalizeMinecraftText(text) {
  if (!text) return '';
  const smallCaps = {
    'ᴀ': 'a', 'ʙ': 'b', 'ᴄ': 'c', 'ᴅ': 'd', 'ᴇ': 'e', 'ꜰ': 'f', 'ɢ': 'g',
    'ʜ': 'h', 'ɪ': 'i', 'ᴊ': 'j', 'ᴋ': 'k', 'ʟ': 'l', 'ᴍ': 'm', 'ɴ': 'n',
    'ᴏ': 'o', 'ᴘ': 'p', 'ǫ': 'q', 'ʀ': 'r', 'ꜱ': 's', 'ᴛ': 't', 'ᴜ': 'u',
    'ᴠ': 'v', 'ᴡ': 'w', 'x': 'x', 'ʏ': 'y', 'ᴢ': 'z'
  };
  return text
    .split('')
    .map(c => smallCaps[c] || c)
    .join('')
    .toLowerCase();
}

let bot = null;
let isReconnecting = false;
let menuRetryInterval = null;
let survivalTimer = null;
let afkCheckInterval = null;
let autoClickTimer = null;
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
  stopAutoClicker();
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

    const lower = normalizeMinecraftText(raw);

    // Check for register prompt or 'not registered' error
    if (lower.includes('/register') || lower.includes('please register') || lower.includes('type /register') || lower.includes('not registered') || lower.includes('need to register')) {
      if (!hasLoggedIn || lower.includes('not registered')) {
        console.log(`[Auth] Register prompt detected in chat! Executing /register...`);
        executeRegisterCommand(true);
      }
    }
    // Check for login prompt or 'already registered' message
    else if (lower.includes('/login') || lower.includes('please login') || lower.includes('type /login') || lower.includes('already registered')) {
      if (!hasLoggedIn || lower.includes('already registered')) {
        console.log(`[Auth] Login prompt detected in chat! Executing /login...`);
        executeLoginCommand(true);
      }
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

    // Detect Survival chat announcement to trigger auto-clicker
    if (!inSurvival && (lower.includes('dailyquests') || lower.includes('vote for us') || (hasClickedGui && lower.includes(CONFIG.username.toLowerCase())))) {
      console.log('[Bot] Survival arrival detected in chat! Triggering auto-clicker...');
      scheduleSurvivalCommands();
    }

    // Check for AFK status confirmations and cancellations
    if (lower.includes('now afk') || lower.includes('you are now afk')) {
      isAfk = true;
      console.log('[Anti-AFK] Server placed bot in AFK! Toggling /afk off & jumping to break AFK...');
      bot.chat('/afk');
      try {
        bot.setControlState('jump', true);
        setTimeout(() => { if (bot) bot.setControlState('jump', false); }, 300);
      } catch (e) {}
    } else if (lower.includes('no longer afk') || lower.includes('not afk')) {
      isAfk = false;
      console.log('[AFK] Confirmed: Bot is active and NOT AFK.');
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

  // Auto-respawn on death
  bot.on('death', () => {
    console.log('[Bot] Player died! Automatically respawning in 1.5 seconds...');
    isAfk = false;
    stopAutoClicker();
    setTimeout(() => {
      if (!bot) return;
      try {
        bot.respawn();
        console.log('[Bot] Respawn packet sent successfully.');
      } catch (err) {
        console.warn('[Bot] Failed to send respawn packet:', err.message);
      }

      // Resume auto-clicker after respawn in Survival
      setTimeout(() => {
        if (bot && inSurvival) {
          console.log('[Bot] Resuming auto-clicker after respawn...');
          startAutoClicker();
        }
      }, 3500);
    }, 1500);
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
function executeRegisterCommand(force = false) {
  if (!bot || (hasLoggedIn && !force)) return;
  console.log(`[Auth] Sending: /register ${CONFIG.loginPassword} ${CONFIG.loginPassword}`);
  bot.chat(`/register ${CONFIG.loginPassword} ${CONFIG.loginPassword}`);
  hasLoggedIn = true;
}

function executeLoginCommand(force = false) {
  if (!bot || (hasLoggedIn && !force)) return;
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

function startAutoClicker() {
  stopAutoClicker();
  if (!CONFIG.autoClicker) return;

  const intervalMs = CONFIG.autoClickIntervalMs || 60000;
  console.log(`[AutoClicker] Clicking once every ${intervalMs / 1000}s (safe anti-AFK & mob grinder).`);
  autoClickTimer = setInterval(() => {
    performLeftClick();
  }, intervalMs);
}

function stopAutoClicker() {
  if (autoClickTimer) {
    clearInterval(autoClickTimer);
    autoClickTimer = null;
  }
}

function performLeftClick() {
  if (!bot || !bot.entity || !inSurvival) return;
  try {
    const botEye = bot.entity.position.offset(0, 1.62, 0);

    // 1. Search for any nearby mob/hostile/animal to attack (radius up to 4.2 blocks)
    let bestTarget = null;
    let minDistance = 4.2;

    for (const id in bot.entities) {
      const e = bot.entities[id];
      if (!e || e === bot.entity) continue;
      if (e.type === 'player' || e.name === 'armor_stand' || e.name === 'item' || e.type === 'projectile') continue;
      
      const targetPos = e.position.offset(0, (e.height || 1) * 0.5, 0);
      const dist = botEye.distanceTo(targetPos);
      if (dist < minDistance) {
        minDistance = dist;
        bestTarget = e;
      }
    }

    if (bestTarget) {
      // Look directly at target and attack
      const targetEye = bestTarget.position.offset(0, (bestTarget.height || 1) * 0.5, 0);
      bot.lookAt(targetEye, false);
      bot.attack(bestTarget);
      console.log(`[AutoClicker] Attacked ${bestTarget.name || 'mob'} in reach.`);
    } else {
      // 2. No mob in range: swing arm cleanly (native animation)
      bot.swingArm('right');

      // Micro head rotation to fire PlayerMoveEvent and reset server idle timer
      const yaw = bot.entity.yaw + (Math.random() * 0.04 - 0.02);
      bot.look(yaw, bot.entity.pitch, false);
      console.log('[AutoClicker] Left-clicked / swung arm (60s cycle).');
    }
  } catch (err) {
    // Suppress minor swing errors
  }
}

function scheduleSurvivalCommands() {
  if (inSurvival && postCommandsSent) return;
  inSurvival = true;
  postCommandsSent = true;

  clearAllTimers();

  console.log('\n======================================================');
  console.log('[Bot] Arrived in Survival server! Starting anti-AFK clicker...');
  console.log('======================================================');

  // Allow 1.5 seconds for world chunks and player position to settle
  setTimeout(() => {
    if (!bot || !inSurvival) return;

    if (Array.isArray(CONFIG.postCommands) && CONFIG.postCommands.length > 0) {
      for (const cmd of CONFIG.postCommands) {
        console.log(`[Bot] Executing post-command: ${cmd}`);
        bot.chat(cmd);
      }
    }

    startAutoClicker();
  }, 1500);
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
