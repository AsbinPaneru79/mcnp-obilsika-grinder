# MCNP ObilSika Grinder ⛏️

An automated 24/7 Minecraft AFK bot tailored for player **`ObilSika_`** on the **`mcnp.network`** server.

Built with [Mineflayer](https://github.com/PrismarineJS/mineflayer), Express, and Socket.IO, this bot automatically handles login authentication, hotbar selection, GUI navigation to Survival mode, sitting & AFK commands, continuous keep-alive, and auto-reconnection.

---

## ⚡ What It Does (Step-by-Step)

1. **Joins Server:** Connects to `mcnp.network:25565` using offline auth with username **`ObilSika_`**.
2. **Auto-Login:** Immediately runs `/login tynorix` upon detecting the login prompt (with automatic timer fallback).
3. **Hotbar Selection:** Moves to the **2nd hotbar slot** (quickbar index 1).
4. **Right Click:** Right-clicks (activates) the held navigation item to pop open the Game Modes GUI.
5. **GUI Selection:** Identifies and clicks the **Blue Diamond Pickaxe** (Slot 11) in the 27-slot chest menu to transfer directly to the **Survival** realm.
6. **Sit & AFK:** Once transferred to Survival:
   - Sends `/sit` in chat to sit down.
   - Sends `/afk` in chat to toggle AFK status.
7. **Anti-AFK Keepalive:** Periodically executes subtle arm swings and yaw adjustments while sitting to prevent server inactivity / idle kicks.
8. **Auto-Reconnect:** If kicked, disconnected, or faced with network drops, automatically rejoins after 8 seconds and repeats the full sequence seamlessly.

---

## 🚀 Quick Start

### 1. Prerequisites
- **Node.js** v18+ (tested on Node v20/v24)
- **npm**

### 2. Installation
```bash
git clone https://github.com/AsbinPaneru79/mcnp-obilsika-grinder.git
cd mcnp-obilsika-grinder
npm install
```

### 3. Running the Bot

#### Mode A: Full Web Dashboard & Background Server (Recommended)
```bash
npm start
```
- Starts the bot immediately and hosts the interactive Web Dashboard on `http://localhost:3000` (or `8080`).
- View live server logs, bot health, send chat commands, or adjust configurations in real-time.

#### Mode B: Pure CLI / Headless Runner
```bash
npm run bot
```
- Runs the lightweight terminal script directly (`index.js`).

---

## ⚙️ Configuration

Settings can be customized via `config.json` or environment variables (`.env`):

| Variable | Default Value | Description |
| :--- | :--- | :--- |
| `MC_HOST` | `mcnp.network` | Target Minecraft server host |
| `MC_PORT` | `25565` | Target Minecraft server port |
| `MC_USERNAME` | `ObilSika_` | Bot's Minecraft username |
| `MC_PASSWORD` | `tynorix` | Password used for `/login` |
| `HOTBAR_SLOT` | `2` | Hotbar position to select (1-9) |
| `GUI_TARGET_ITEM` | `diamond_pickaxe` | Item identifier in the menu |
| `GUI_TARGET_SLOT` | `11` | Primary slot for the Diamond Pickaxe |
| `AUTO_RECONNECT` | `true` | Automatically reconnect on disconnect |
| `RECONNECT_DELAY_MS` | `8000` | Reconnection cooldown in milliseconds |
| `ANTI_AFK` | `true` | Keep-alive movement in Survival |
| `PORT` | `3000` | Web server & health-check port |

---

## 🌐 24/7 Cloud Deployment (Railway)

This repository includes full configuration for 1-click or git deployment to **Railway**:
1. Fork or push this repository to GitHub.
2. In Railway, click **New Project** -> **Deploy from GitHub repo**.
3. Select `mcnp-obilsika-grinder`.
4. Railway will automatically detect `railway.json` / `Procfile` and deploy the service 24/7!

---

## 📜 License
MIT License. Created for AsbinPaneru79 / ObilSika_.
