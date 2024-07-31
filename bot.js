const { Telegraf, Markup } = require('telegraf');
const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { Api } = require('telegram');
const prompt = require('prompt-sync')();
const fs = require('fs');
const axios = require('axios');

const apiId = 22855880; // Your API ID
const apiHash = '94be7796163a78b7c57666ea89fd9e61'; // Your API Hash
const phoneNumber = '+918423272388'; // Your phone number
const sessionFile = 'session.json'; // File to save the session string
const channelsFile = 'trackedChannels.json'; // File to save tracked channels
const logGroupId = '@dwqxjK'; // Log group ID where data will be sent
const trackedChannels = {}; // Object to store track start times
const reportedContracts = new Set(); // Set to track reported contracts
const fetchInterval = 5000; // Check every 5 seconds
let stringSession = new StringSession(''); // New session to start with
let contractIntervals = {}; // Store intervals for each contract

// Read session from file if it exists
if (fs.existsSync(sessionFile)) {
    const sessionData = JSON.parse(fs.readFileSync(sessionFile));
    stringSession = new StringSession(sessionData.session); // Load saved session
}

// Load previously tracked channels from file
if (fs.existsSync(channelsFile)) {
    const channelsData = JSON.parse(fs.readFileSync(channelsFile));
    Object.keys(channelsData).forEach(channel => {
        trackedChannels[channel] = channelsData[channel]; // Load saved channel data
    });
}

// Initialize Telegram client
const client = new TelegramClient(stringSession, apiId, apiHash, { connectionRetries: 5 });
// Initialize the bot
const bot = new Telegraf('6864501211:AAEmQDRZphC3XuMI2R5HyyfDTuv3tKMyRI4'); // Replace with your bot's token

const startClient = async () => {
    console.log('Starting Telegram client...');
    try {
        await client.start({
            phoneNumber: async () => phoneNumber,
            password: async () => null, // Add your 2FA password if enabled
            phoneCode: async () => await prompt('Please enter the code you received: '),
            onError: (err) => console.error(err),
        });
        console.log('Client initialized successfully');
        const sessionString = client.session.save();
        console.log('Your session string is:', sessionString); // Print the session string
        fs.writeFileSync(sessionFile, JSON.stringify({ session: sessionString })); // Save the session string to a file
    } catch (error) {
        console.error('Failed to start Telegram client:', error);
        process.exit(1);
    }
};

// Utility function to join a channel
const joinChannel = async (target, ctx) => {
    try {
        await client.invoke(new Api.channels.JoinChannel({ channel: target }));
        trackedChannels[target] = Date.now(); // Track time when joined
        ctx.reply(`Successfully joined the channel: ${target}`);
        console.log(`Joined ${target} at ${new Date(trackedChannels[target]).toLocaleString()}`);
        fs.writeFileSync(channelsFile, JSON.stringify(trackedChannels, null, 2)); // Save updated channels data to file
    } catch (error) {
        console.error(`Error joining channel: ${error}`);
        ctx.reply(`Could not join ${target}. Please check the link or username.`);
    }
};

// Function to format numbers as currency without decimal points
const formatCurrency = (value) => {
    return `$${parseFloat(value).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
};

// Function to check for contract addresses in the message
const isContractAddress = (text) => {
    if (!text) return [];
    const regex = /\b(0x[a-fA-F0-9]{40})\b/g; // Matches 0x followed by exactly 40 hex characters
    return text.match(regex) || [];
};

// Function to fetch contract data from the API
const fetchContractData = async (contract) => {
    try {
        const response = await axios.get(`https://api.dexscreener.com/latest/dex/search?q=${contract}`);
        return response.data; // Return the API response
    } catch (error) {
        console.error(`Error fetching data for contract ${contract}:`, error);
        return null;
    }
};

// Function to calculate percentage change
const calculatePercentageChange = (initialValue, currentValue) => {
    if (initialValue === 0) return 'N/A';
    return ((currentValue - initialValue) / initialValue * 100).toFixed(2) + '%';
};

// Function to log the contract data in the log group
const logContractData = async (data, channelName, messageLink, address) => {
    const contractAddress = address; // Use the address fetched from the channel
    const contractLink = `https://etherscan.io/address/${contractAddress}`;
    
    // Store initial values when tracking starts
    const initialFdV = data.fdv;
    const initialLiquidity = data.liquidity.usd;
    const initialVolume24h = data.volume?.h24 || 'N/A';
    const sharingTime = new Date().toLocaleString(); // Store the time when the channel shared the message

    // Construct the message for the first log
    const liveDataMessage = `**[${data.baseToken.name}](${contractLink}) Under Tracking Boss 🫡**\n\n` +
        `**Symbol:** ${data.baseToken.symbol} **Chain:** ${data.chainId}\n\n` +
        `**FDV:** ${formatCurrency(data.fdv)} || ${formatCurrency(initialFdV)}\n` +
        `**Liquidity:** ${formatCurrency(data.liquidity.usd)} || ${formatCurrency(initialLiquidity)}\n` +
        `**Vol 24h:** ${formatCurrency(data.volume?.h24 || 0)}\n\n` +
        `${calculatePercentageChange(initialFdV, data.fdv)} since Tracking\n\n` +
        `**[${channelName}](https://t.me/${channelName})** shared this at ${sharingTime}\n\n` + // Corrected hyperlink format
        `**Last Updated At:** `; // Placeholder for last updated time

    // Inline button for stopping the report
    const stopButton = Markup.inlineKeyboard([
        Markup.button.url('Stop', 'https://t.me/xentdev') // Correct link here
    ]);

    // Send the message and pin it with no link preview
    const sentMessage = await bot.telegram.sendMessage(logGroupId, liveDataMessage, {
        parse_mode: 'Markdown',
        disable_web_page_preview: true, // Disable link preview
        reply_markup: stopButton // Attach the inline button
    });

    const pinnedMessageId = sentMessage.message_id; // Store the ID of the pinned message

    // Pin the message
    await bot.telegram.pinChatMessage(logGroupId, pinnedMessageId);

    // Set up interval for tracking this contract
    contractIntervals[address] = {
        intervalId: startRefreshingContractData(
            data.pairAddress,
            channelName,
            messageLink,
            pinnedMessageId,
            initialFdV,
            initialLiquidity,
            initialVolume24h,
            sharingTime,
            contractLink
        ),
        lastPinnedId: pinnedMessageId,
    };
};

// Function to fetch fresh contract data and update the pinned message
const startRefreshingContractData = (addressToProcess, channelName, messageLink, pinnedMessageId, initialFdV, initialLiquidity, initialVolume24h, sharingTime, contractLink) => {
    return setInterval(async () => {
        const data = await fetchContractData(addressToProcess);
        if (data && data.pairs.length > 0) {
            const updatedData = data.pairs[0]; // Refresh the data
            
            // Construct the updated message with refreshed live data
            const updatedMessage = `**[${updatedData.baseToken.name}](${contractLink}) Under Tracking Boss 🫡**\n\n` +
                `**Symbol:** ${updatedData.baseToken.symbol} **Chain:** ${updatedData.chainId}\n\n` +
                `**FDV:** ${formatCurrency(updatedData.fdv)} || ${formatCurrency(initialFdV)}\n` +
                `**Liquidity:** ${formatCurrency(updatedData.liquidity.usd)} || ${formatCurrency(initialLiquidity)}\n` +
                `**Vol 24h:** ${formatCurrency(updatedData.volume.h24 || 0)}\n\n` +
                `${calculatePercentageChange(initialFdV, updatedData.fdv)} since Tracking\n\n` +
                `**[${channelName}](https://t.me/${channelName})** shared this at ${sharingTime}\n\n` + // Corrected hyperlink format
                `**Last Updated At:** ${new Date().toLocaleString()}`; // Update last updated time

            // Edit the pinned message to include updated data
            await bot.telegram.editMessageText(logGroupId, pinnedMessageId, null, updatedMessage, {
                parse_mode: 'Markdown',
                disable_web_page_preview: true, // Disable link preview when updating
            });
        }
    }, 60000); // refresh interval - 1 minute
};

// Command to join a channel
bot.command('join', (ctx) => {
    const target = ctx.message.text.split(' ')[1]; // Get channel username
    if (!target || !target.startsWith('@')) {
        return ctx.reply('Please provide a valid channel username (e.g., @channelusername)!');
    }
    joinChannel(target, ctx);
});

// Automatically check for new messages in joined channels every 5 seconds
setInterval(async () => {
    for (const channel in trackedChannels) {
        try {
            const messages = await client.getMessages(channel, { limit: 1 }); // Get the last message
            if (messages.length > 0) {
                const lastMessage = messages[0].message || "";
                const messageDate = messages[0].date * 1000; // Convert date to milliseconds
                const joinTime = trackedChannels[channel];
                // Only process messages that come after the bot joined the channel
                if (messageDate > joinTime) {
                    const foundAddresses = isContractAddress(lastMessage); // Extract contract addresses
                    if (foundAddresses.length) {
                        const address = foundAddresses[0]; // Only take the first address for simplicity
                        if (!reportedContracts.has(address)) {
                            const data = await fetchContractData(address);
                            if (data && data.pairs.length > 0) {
                                const messageLink = `https://t.me/${channel}/message/${messages[0].id}`; // Generate message link
                                await logContractData(data.pairs[0], channel.substring(1), messageLink, address); // Pass channel name and message link
                                reportedContracts.add(address); // Mark this address as reported
                            } else {
                                console.log(`No data found for contract address: ${address}`);
                            }
                        }
                    } else {
                        console.log('No contract address found in the message.');
                    }
                }
            }
        } catch (error) {
            console.error(`Error checking messages from ${channel}:`, error);
        }
    }
}, fetchInterval); // Fetch interval set to 5000 ms (5 seconds)

// Start the script and the bot
startClient().then(() => {
    bot.launch(); // Launch the Telegram bot
    console.log('Bot is running\nTime saved for pre-joined channels:', new Date().toLocaleString());
}).catch(err => {
    console.error('Error while starting:', err);
});

// Error handling
process.on('unhandledRejection', (error) => {
    console.error('Unhandled promise rejection:', error);
});