/**
 * MCNP Bot - Prismarine-Chat Compatibility Patch
 * 
 * Prevents unhandled crashes from modern Bungee/Velocity server chat formatting:
 * "Error: unknown chat format code: [object Object]" (thrown before login codec)
 */

try {
  const prismarineChat = require('prismarine-chat');
  const originalLoader = prismarineChat;

  const patchedLoader = function (registry) {
    const ChatMessage = originalLoader(registry);
    const origFromNetwork = ChatMessage.fromNetwork;

    ChatMessage.fromNetwork = function (type, params) {
      try {
        return origFromNetwork.call(this, type, params);
      } catch (err) {
        if (err.message && err.message.includes('unknown chat format code')) {
          let contentText = '';
          if (params) {
            if (params.content) {
              contentText = typeof params.content === 'object'
                ? (params.content.text || params.content.translate || JSON.stringify(params.content))
                : String(params.content);
            } else if (params.sender || params.target) {
              contentText = String(params.sender || params.target);
            }
          }
          return new ChatMessage({ text: contentText });
        }
        throw err;
      }
    };

    return ChatMessage;
  };

  // Preserve all helper functions and properties like processNbtMessage
  Object.assign(patchedLoader, originalLoader);

  require.cache[require.resolve('prismarine-chat')].exports = patchedLoader;
} catch (e) {
  // ignore if module resolution fails in non-standard runtimes
}

// Global process error handlers to ensure 24/7 container uptime on Railway
process.on('uncaughtException', (err) => {
  if (err.message && err.message.includes('unknown chat format code')) {
    console.warn('[Chat Protection] Suppressed server chat format error:', err.message);
    return;
  }
  console.error('[Process Error] Uncaught Exception:', err);
});

process.on('unhandledRejection', (reason) => {
  console.warn('[Process Error] Unhandled Rejection:', reason);
});
