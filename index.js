const { default: makeWASocket, DisconnectReason, useMultiFileAuthState } = require('@whiskeysockets/baileys');
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
    // Check if credentials exist
    if (!fs.existsSync(CREDENTIALS_PATH)) {
        console.error('No credentials found! Please run the QR generator first and scan the QR code.');
        process.exit(1);
    }

    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
    
    const sock = makeWASocket({
        logger: pino({ level: 'warn' }),
        printQRInTerminal: false, // Disable QR printing in main bot
        auth: state,
        browser: ['WhatsApp Bot', 'Chrome', '20.0.0'],
        connectTimeoutMs: 60000,
        maxRetries: 3,
        // Add connection options for better stability
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

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;

        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect?.error instanceof Boom)?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log('Connection closed due to ', lastDisconnect?.error, ', reconnecting ', shouldReconnect);
            
            if (shouldReconnect) {
                connectToWhatsApp();
            } else {
                console.log('Connection closed. Please check your credentials and restart the bot.');
            }
        } else if (connection === 'open') {
            console.log('Bot is now connected!');
            console.log('Bot User ID:', sock.user.id);
            await updateChannelsAndGroupsList(sock);
        }
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('messages.upsert', async ({ messages }) => {
        const m = messages[0];
        
        if (!m.message) return;
        
        const messageContent = m.message?.conversation || m.message?.extendedTextMessage?.text || '';
        const isReply = m.message?.extendedTextMessage?.contextInfo?.quotedMessage;
        const sender = m.key.participant || m.key.remoteJid;

        console.log('Incoming Message Details:');
        console.log('Sender:', sender);
        console.log('Message Content:', messageContent);

        if (messageContent.startsWith('/broadcast') && isReply) {
            console.log('Broadcast command detected');
            
            const adminCheckResult = await isAdmin(sock, sender);
            console.log('Admin Check Result:', adminCheckResult);

            if (adminCheckResult) {
                const repliedMessage = await getQuotedMessage(m);
                if (repliedMessage) {
                    broadcastStats = {
                        total: 0,
                        success: 0,
                        failed: 0,
                        lastBroadcastTime: Date.now()
                    };

                    let results;
                    if (messageContent.includes('channels')) {
                        results = await broadcastToChannels(sock, repliedMessage, sendMessageWithRetry);
                    } else if (messageContent.includes('groups')) {
                        results = await broadcastToGroups(sock, repliedMessage, sendMessageWithRetry);
                    } else {
                        results = await broadcastToAll(sock, repliedMessage, sendMessageWithRetry);
                    }

                    await sock.sendMessage(m.key.remoteJid, {
                        text: `📊 Broadcast Summary:\n` +
                              `Total Targets: ${results.total}\n` +
                              `✅ Successful: ${results.success}\n` +
                              `❌ Failed: ${results.failed}`
                    });
                }
            } else {
                await sock.sendMessage(m.key.remoteJid, {
                    text: '❌ Only bot owners can use broadcast command.\n' +
                          `Your number: ${sender}\n` +
                          `Authorized numbers: ${CONFIG.OWNERS.join(', ')}`
                });
            }
        }
    });

    async function broadcastWithRateLimit(sock, targets, message, sendFunc) {
        let successCount = 0;
        let failCount = 0;
        
        const now = Date.now();
        if (now - broadcastStats.lastBroadcastTime < CONFIG.RATE_LIMIT_WINDOW && 
            broadcastStats.total >= CONFIG.MAX_BROADCASTS_PER_WINDOW) {
            console.warn('Rate limit exceeded. Stopping broadcast.');
            return { success: 0, failed: targets.length };
        }

        for (let i = 0; i < targets.length; i += CONFIG.MAX_CONCURRENT_BROADCASTS) {
            const batch = targets.slice(i, i + CONFIG.MAX_CONCURRENT_BROADCASTS);
            
            const batchResults = await Promise.all(
                batch.map(async (target) => {
                    const result = await sendFunc(sock, target.id, message);
                    await new Promise(resolve => 
                        setTimeout(resolve, CONFIG.BROADCAST_DELAY)
                    );
                    return result;
                })
            );

            successCount += batchResults.filter(result => result).length;
            failCount += batchResults.filter(result => !result).length;
        }

        broadcastStats.total += targets.length;
        broadcastStats.success += successCount;
        broadcastStats.failed += failCount;
        broadcastStats.lastBroadcastTime = Date.now();

        return { 
            success: successCount, 
            failed: failCount,
            total: targets.length
        };
    }

    async function broadcastToChannels(sock, message, sendFunc) {
        return await broadcastWithRateLimit(sock, channels, message, sendFunc);
    }

    async function broadcastToGroups(sock, message, sendFunc) {
        return await broadcastWithRateLimit(sock, groups, message, sendFunc);
    }

    async function broadcastToAll(sock, message, sendFunc) {
        const allTargets = [...channels, ...groups];
        return await broadcastWithRateLimit(sock, allTargets, message, sendFunc);
    }

    async function updateChannelsAndGroupsList(sock) {
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

    async function getQuotedMessage(message) {
        try {
            const quotedMessage = message.message?.extendedTextMessage?.contextInfo?.quotedMessage;
            if (!quotedMessage) return null;

            if (quotedMessage.conversation) {
                return { text: quotedMessage.conversation };
            }

            if (quotedMessage.extendedTextMessage) {
                return { text: quotedMessage.extendedTextMessage.text };
            }

            if (quotedMessage.imageMessage) {
                return {
                    image: {
                        url: quotedMessage.imageMessage.url,
                        mimetype: quotedMessage.imageMessage.mimetype
                    },
                    caption: quotedMessage.imageMessage.caption || ''
                };
            }

            if (quotedMessage.videoMessage) {
                return {
                    video: {
                        url: quotedMessage.videoMessage.url,
                        mimetype: quotedMessage.videoMessage.mimetype
                    },
                    caption: quotedMessage.videoMessage.caption || ''
                };
            }

            if (quotedMessage.documentMessage) {
                return {
                    document: {
                        url: quotedMessage.documentMessage.url,
                        mimetype: quotedMessage.documentMessage.mimetype,
                        fileName: quotedMessage.documentMessage.fileName
                    },
                    caption: quotedMessage.documentMessage.caption || ''
                };
            }

            if (quotedMessage.audioMessage) {
                return {
                    audio: {
                        url: quotedMessage.audioMessage.url,
                        mimetype: quotedMessage.audioMessage.mimetype
                    }
                };
            }

            return null;
        } catch (error) {
            console.error('Error getting quoted message:', error);
            return null;
        }
    }

    async function isAdmin(sock, userId) {
        try {
            const normalizeNumber = (num) => num.replace(/\D/g, '');
            
            console.log('Admin Check Debug:');
            console.log('Checking User ID:', userId);
            console.log('Bot User ID:', sock.user.id);
            console.log('Registered Owners:', CONFIG.OWNERS);
            
            const normalizedUserId = normalizeNumber(userId);
            const normalizedOwners = CONFIG.OWNERS.map(normalizeNumber);
            
            console.log('Normalized User ID:', normalizedUserId);
            console.log('Normalized Owners:', normalizedOwners);
            
            const isOwner = normalizedOwners.includes(normalizedUserId);
            const isBotSelf = normalizeNumber(sock.user.id) === normalizedUserId;

            if (isOwner || isBotSelf) {
                console.log('Admin access GRANTED');
                return true;
            }

            console.log('Admin access DENIED');
            return false;
        } catch (error) {
            console.error('Error checking admin status:', error);
            return false;
        }
    }

    // Ensure auth directory exists
    if (!fs.existsSync('auth_info_baileys')) {
        fs.mkdirSync('auth_info_baileys');
    }

    return sock;
}

// Error handling for the main process
process.on('uncaughtException', (err) => {
    console.error('Uncaught Exception:', err);
    // Optionally restart the bot here
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
    // Optionally restart the bot here
});

// Start the bot
connectToWhatsApp().catch(err => {
    console.error('Error in main bot process:', err);
    process.exit(1);
});
