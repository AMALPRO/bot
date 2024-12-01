const { default: makeWASocket, DisconnectReason, useMultiFileAuthState } = require('@whiskeysockets/baileys');
const express = require('express');
const pino = require('pino');
const { Boom } = require('@hapi/boom');
const fs = require('fs');
const path = require('path');

// Configuration for multiple owners and bot settings
const CONFIG = {
    OWNERS: [
        '+917356008536'  // Ensure this is the correct full international number
    ],
    MAX_CONCURRENT_BROADCASTS: 3,
    BROADCAST_DELAY: 2000,
    RATE_LIMIT_DELAY: 5000,
    RATE_LIMIT_WINDOW: 5 * 60 * 1000,
    MAX_BROADCASTS_PER_WINDOW: 50,
    MESSAGE_TIMEOUT: 10000
};

const CREDENTIALS_PATH = 'auth_info_baileys/creds.json';

// Create Express app for port binding
const app = express();
const PORT = process.env.PORT || 3000;

// Health check route
app.get('/', (req, res) => {
    res.send('WhatsApp Bot is running');
});

// Start Express server
const server = app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});

// Store channels and groups data
let channels = [];
let groups = [];

// Broadcast tracking
let broadcastStats = {
    total: 0,
    success: 0,
    failed: 0,
    lastBroadcastTime: 0
};

async function connectToWhatsApp() {
    try {
        // Verify credentials exist
        const credentialsExist = fs.existsSync(CREDENTIALS_PATH);
        console.log('Credentials exist:', credentialsExist);

        const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
    
        const sock = makeWASocket({
            logger: pino({ level: 'warn' }),
            printQRInTerminal: false,
            auth: state,
            browser: ['WhatsApp Bot', 'Chrome', '20.0.0'],
            connectTimeoutMs: 60000,
            maxRetries: 5,
            retryRequestDelayMs: 5000,
            defaultQueryTimeoutMs: 60000,
        });

        // Connection event handlers (rest of the code remains the same as in previous script)
        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect } = update;
            console.log('Connection Update:', connection);

            if (connection === 'close') {
                const shouldReconnect = 
                    lastDisconnect?.error && 
                    (lastDisconnect.error instanceof Boom 
                        ? lastDisconnect.error.output.statusCode !== DisconnectReason.loggedOut 
                        : true);
                
                console.log('Connection closed. Reconnecting:', shouldReconnect);
                
                if (shouldReconnect) {
                    setTimeout(connectToWhatsApp, 1000);
                } else {
                    console.log('Connection permanently closed. Manual intervention required.');
                }
            } else if (connection === 'open') {
                console.log('Bot is now connected!');
                console.log('Bot User ID:', sock.user.id);
            }
        });

        // Rest of the methods (sendMessageWithRetry, isAdmin, etc.) remain the same as in previous script

        return sock;
    } catch (error) {
        console.error('Fatal error in WhatsApp connection:', error);
        // Attempt to reconnect after a delay
        setTimeout(connectToWhatsApp, 5000);
    }
}

// Global error handling
process.on('uncaughtException', (err) => {
    console.error('Uncaught Exception:', err);
    // Restart the bot process
    setTimeout(connectToWhatsApp, 1000);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
    // Restart the bot process
    setTimeout(connectToWhatsApp, 1000);
});

// Start the bot
connectToWhatsApp().catch(err => {
    console.error('Initial connection error:', err);
});
