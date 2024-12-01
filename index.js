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

        // Enhanced message sending function with retry mechanism
        async function sendMessageWithRetry(sock, chatId, message, retries = 3) {
            for (let attempt = 1; attempt <= retries; attempt++) {
                try {
                    let msgOptions;
                    if (message.text) {
                        msgOptions = { text: message.text };
                    } else if (message.image) {
                        msgOptions = { 
                            image: { url: message.image.url },
                            caption: message.caption || ''
                        };
                    } else if (message.video) {
                        msgOptions = { 
                            video: { url: message.video.url },
                            caption: message.caption || ''
                        };
                    } else if (message.document) {
                        msgOptions = { 
                            document: { url: message.document.url },
                            mimetype: message.document.mimetype,
                            fileName: message.document.fileName
                        };
                    } else if (message.audio) {
                        msgOptions = { 
                            audio: { url: message.audio.url },
                            mimetype: message.audio.mimetype
                        };
                    } else {
                        msgOptions = { text: 'Broadcast message' };
                    }

                    const sendPromise = sock.sendMessage(chatId, msgOptions);
                    const timeoutPromise = new Promise((_, reject) => 
                        setTimeout(() => reject(new Error('Message send timeout')), CONFIG.MESSAGE_TIMEOUT)
                    );

                    await Promise.race([sendPromise, timeoutPromise]);
                    console.log(`Message sent successfully to ${chatId}`);
                    return true;
                } catch (error) {
                    console.error(`Send attempt ${attempt} failed for ${chatId}:`, error);
                    await new Promise(resolve => 
                        setTimeout(resolve, CONFIG.RATE_LIMIT_DELAY * attempt)
                    );
                    if (attempt === retries) {
                        console.error(`Failed to send message to ${chatId} after ${retries} attempts`);
                        return false;
                    }
                }
            }
            return false;
        }

        // Connection event handler
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
                
                // Update channels and groups list
                try {
                    const chats = await sock.groupFetchAllParticipating();
                    
                    channels = [];
                    groups = [];

                    for (const chat of Object.values(chats)) {
                        if (chat.isChannel || chat.subject?.startsWith('Channel: ')) {
                            channels.push({
                                id: chat.id,
                                name: chat.subject
                            });
                        } else {
                            groups.push({
                                id: chat.id,
                                name: chat.subject
                            });
                        }
                    }

                    console.log(`Updated lists: ${channels.length} channels and ${groups.length} groups found`);
                } catch (error) {
                    console.error('Error updating channels and groups list:', error);
                }
            }
        });

        // Credentials update handler
        sock.ev.on('creds.update', saveCreds);

        // Message handling
        sock.ev.on('messages.upsert', async ({ messages }) => {
            const m = messages[0];

            if (!m.message) return;

            const messageContent = m.message?.conversation || m.message?.extendedTextMessage?.text || '';
            const isReply = m.message?.extendedTextMessage?.contextInfo?.quotedMessage;
            const sender = m.key.participant || m.key.remoteJid;

            console.log('Incoming Message Details:');
            console.log('Sender:', sender);
            console.log('Message Content:', messageContent);

            // Add your message handling logic here
            // For example, broadcast command handling
        });

        // Ensure auth directory exists
        if (!fs.existsSync('auth_info_baileys')) {
            fs.mkdirSync('auth_info_baileys');
        }

        return sock;
    } catch (error) {
        console.error('Fatal error in WhatsApp connection:', error);
        // Attempt to reconnect after a delay
        setTimeout(connectToWhatsApp, 5000);
        throw error;
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

// Graceful shutdown
process.on('SIGTERM', () => {
    console.log('SIGTERM received. Shutting down gracefully.');
    server.close(() => {
        console.log('HTTP server closed.');
        process.exit(0);
    });
});

// Start the bot
connectToWhatsApp().catch(err => {
    console.error('Initial connection error:', err);
});
