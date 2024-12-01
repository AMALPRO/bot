const express = require('express');
const { default: makeWASocket, DisconnectReason, useMultiFileAuthState } = require('@whiskeysockets/baileys');
const pino = require('pino');
const { Boom } = require('@hapi/boom');
const fs = require('fs');
const path = require('path');
const QRCode = require('qrcode');

// Configuration for multiple owners and bot settings
const CONFIG = {
    OWNERS: [
        '+917356008536'  // Ensure this is the correct full international number
    ],
    MAX_CONCURRENT_BROADCASTS: 3, // Reduced for better stability
    BROADCAST_DELAY: 2000, // Increased delay to 2 seconds between messages
    RATE_LIMIT_DELAY: 5000, // 5 seconds delay if rate limited
    RATE_LIMIT_WINDOW: 5 * 60 * 1000, // 5 minutes
    MAX_BROADCASTS_PER_WINDOW: 50,
    MESSAGE_TIMEOUT: 10000 // 10 seconds timeout for each message
};

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

// Global variables for QR code handling
let qrCodeData = null;

// Create Express app
const app = express();
const PORT = process.env.PORT || 3000;

// Serve static files and QR code endpoint
app.use(express.static('public'));

app.get('/qr', (req, res) => {
    if (qrCodeData) {
        res.send(`
            <!DOCTYPE html>
            <html>
            <head>
                <title>WhatsApp Bot QR Code</title>
                <style>
                    body { 
                        font-family: Arial, sans-serif; 
                        display: flex; 
                        justify-content: center; 
                        align-items: center; 
                        height: 100vh; 
                        margin: 0; 
                        background-color: #f0f2f5; 
                    }
                    .container { 
                        text-align: center; 
                        background: white; 
                        padding: 20px; 
                        border-radius: 10px; 
                        box-shadow: 0 4px 6px rgba(0,0,0,0.1); 
                    }
                    img { 
                        max-width: 300px; 
                        margin-bottom: 15px; 
                    }
                </style>
            </head>
            <body>
                <div class="container">
                    <h2>Scan QR Code to Connect</h2>
                    <img src="${qrCodeData}" alt="WhatsApp QR Code">
                    <p>Scan this QR code with your WhatsApp app to connect the bot</p>
                </div>
            </body>
            </html>
        `);
    } else {
        res.status(404).send('QR Code not available yet');
    }
});

async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
    
    const sock = makeWASocket({
        logger: pino({ level: 'warn' }), // Reduced logging
        printQRInTerminal: false, // Disable terminal QR
        auth: state,
        // Add browser configuration to reduce ban risk
        browser: ['WhatsApp Bot', 'Chrome', '20.0.0'],
        // Implement additional anti-ban measures
        connectTimeoutMs: 60000,
        maxRetries: 3,
    });

    // Enhanced message sending function with retry mechanism
    async function sendMessageWithRetry(sock, chatId, message, retries = 3) {
        for (let attempt = 1; attempt <= retries; attempt++) {
            try {
                // Prepare message options based on message type
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

                // Send message with a timeout
                const sendPromise = sock.sendMessage(chatId, msgOptions);
                const timeoutPromise = new Promise((_, reject) => 
                    setTimeout(() => reject(new Error('Message send timeout')), CONFIG.MESSAGE_TIMEOUT)
                );

                await Promise.race([sendPromise, timeoutPromise]);

                console.log(`Message sent successfully to ${chatId}`);
                return true;
            } catch (error) {
                console.error(`Send attempt ${attempt} failed for ${chatId}:`, error);

                // Implement exponential backoff
                await new Promise(resolve => 
                    setTimeout(resolve, CONFIG.RATE_LIMIT_DELAY * attempt)
                );

                // If it's the last retry, return false
                if (attempt === retries) {
                    console.error(`Failed to send message to ${chatId} after ${retries} attempts`);
                    return false;
                }
            }
        }
        return false;
    }

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            // Generate QR code as a data URL
            qrCodeData = await QRCode.toDataURL(qr, {
                errorCorrectionLevel: 'H',
                type: 'image/png',
                quality: 0.92,
                margin: 1,
            });
            console.log('QR Code updated. View at: /qr');
        }

        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect?.error instanceof Boom)?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log('Connection closed due to ', lastDisconnect?.error, ', reconnecting ', shouldReconnect);
            
            if (shouldReconnect) {
                connectToWhatsApp();
            }
        } else if (connection === 'open') {
            console.log('Bot is now connected!');
            console.log('Bot User ID:', sock.user.id);
            await updateChannelsAndGroupsList(sock);
            
            // Reset QR code when connected
            qrCodeData = null;
        }
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('messages.upsert', async ({ messages }) => {
        const m = messages[0];
        
        if (!m.message) return;
        
        const messageContent = m.message?.conversation || m.message?.extendedTextMessage?.text || '';
        const isReply = m.message?.extendedTextMessage?.contextInfo?.quotedMessage;
        
        // Determine sender (use participant for group messages, remoteJid for others)
        const sender = m.key.participant || m.key.remoteJid;
        console.log('Incoming Message Details:');
        console.log('Sender:', sender);
        console.log('Message Content:', messageContent);

        // Handle broadcast commands
        if (messageContent.startsWith('/broadcast') && isReply) {
            console.log('Broadcast command detected');
            
            // Enhanced admin check with detailed logging
            const adminCheckResult = await isAdmin(sock, sender);
            console.log('Admin Check Result:', adminCheckResult);

            if (adminCheckResult) {
                const repliedMessage = await getQuotedMessage(m);
                if (repliedMessage) {
                    // Reset broadcast stats
                    broadcastStats = {
                        total: 0,
                        success: 0,
                        failed: 0,
                        lastBroadcastTime: Date.now()
                    };

                    // Broadcast based on target
                    let results;
                    if (messageContent.includes('channels')) {
                        results = await broadcastToChannels(sock, repliedMessage, sendMessageWithRetry);
                    } else if (messageContent.includes('groups')) {
                        results = await broadcastToGroups(sock, repliedMessage, sendMessageWithRetry);
                    } else {
                        results = await broadcastToAll(sock, repliedMessage, sendMessageWithRetry);
                    }

                    // Send summary message
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

    // Updated broadcast function to use custom send message function
    async function broadcastWithRateLimit(sock, targets, message, sendFunc) {
        let successCount = 0;
        let failCount = 0;
        
        // Check rate limiting
        const now = Date.now();
        if (now - broadcastStats.lastBroadcastTime < CONFIG.RATE_LIMIT_WINDOW && 
            broadcastStats.total >= CONFIG.MAX_BROADCASTS_PER_WINDOW) {
            console.warn('Rate limit exceeded. Stopping broadcast.');
            return { success: 0, failed: targets.length };
        }

        // Process targets in smaller batches
        for (let i = 0; i < targets.length; i += CONFIG.MAX_CONCURRENT_BROADCASTS) {
            const batch = targets.slice(i, i + CONFIG.MAX_CONCURRENT_BROADCASTS);
            
            // Send messages concurrently in the batch
            const batchResults = await Promise.all(
                batch.map(async (target) => {
                    const result = await sendFunc(sock, target.id, message);
                    
                    // Add delay between messages
                    await new Promise(resolve => 
                        setTimeout(resolve, CONFIG.BROADCAST_DELAY)
                    );
                    
                    return result;
                })
            );

            // Update success and fail counts
            successCount += batchResults.filter(result => result).length;
            failCount += batchResults.filter(result => !result).length;
        }

        // Update global broadcast stats
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

    // Broadcast functions using the new rate-limited approach
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

    // Helper function to update channels and groups list
    async function updateChannelsAndGroupsList(sock) {
        try {
            const chats = await sock.groupFetchAllParticipating();
            
            // Reset arrays
            channels = [];
            groups = [];
            
            for (const chat of Object.values(chats)) {
                // Check if the chat has the channel property (new WhatsApp channels feature)
                if (chat.isChannel || chat.subject?.startsWith('Channel: ')) {
                    channels.push({
                        id: chat.id,
                        name: chat.subject
                    });
                } else {
                    // Regular groups
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

    // Function to get quoted message details
    async function getQuotedMessage(message) {
        try {
            const quotedMessage = message.message?.extendedTextMessage?.contextInfo?.quotedMessage;
            if (!quotedMessage) return null;

            // Text message
            if (quotedMessage.conversation) {
                return { text: quotedMessage.conversation };
            }

            // Extended text message
            if (quotedMessage.extendedTextMessage) {
                return { text: quotedMessage.extendedTextMessage.text };
            }

            // Image message
            if (quotedMessage.imageMessage) {
                return {
                    image: {
                        url: quotedMessage.imageMessage.url,
                        mimetype: quotedMessage.imageMessage.mimetype
                    },
                    caption: quotedMessage.imageMessage.caption || ''
                };
            }

            // Video message
            if (quotedMessage.videoMessage) {
                return {
                    video: {
                        url: quotedMessage.videoMessage.url,
                        mimetype: quotedMessage.videoMessage.mimetype
                    },
                    caption: quotedMessage.videoMessage.caption || ''
                };
            }

            // Document message
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

            // Audio message
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

    // Function to check admin status
    async function isAdmin(sock, userId) {
        try {
            // Normalize phone numbers by removing all non-digit characters
            const normalizeNumber = (num) => num.replace(/\D/g, '');
            
            console.log('Admin Check Debug:');
            console.log('Checking User ID:', userId);
            console.log('Bot User ID:', sock.user.id);
            console.log('Registered Owners:', CONFIG.OWNERS);
            
            // Normalize and compare numbers
            const normalizedUserId = normalizeNumber(userId);
            const normalizedOwners = CONFIG.OWNERS.map(normalizeNumber);
            
            console.log('Normalized User ID:', normalizedUserId);
            console.log('Normalized Owners:', normalizedOwners);
            
            // Check if the user is in the owners list
            const isOwner = normalizedOwners.includes(normalizedUserId);
            
            // Also check against the bot's own user ID
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

    // Start the Express server
    app.listen(PORT, () => {
        console.log(`Server running on port ${PORT}`);
        console.log(`QR Code can be viewed at: http://localhost:${PORT}/qr or your-render-deployment-url/qr`);
    });

    return sock;
}

// Ensure auth directory exists
if (!fs.existsSync('auth_info_baileys')) {
    fs.mkdirSync('auth_info_baileys');
}

// Start the bot
connectToWhatsApp().catch(console.error);
