import express from 'express';
import TelegramBot from 'node-telegram-bot-api';
import Web3 from 'web3';

const app = express();
app.use(express.json());

// Environment variables
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '7347310243:AAGYxgwO4jMaZVkZsCPxrUN9X_GE2emq73Y';
const INFURA_BSC_URL = process.env.INFURA_BSC_URL || 'https://bsc-dataseed.binance.org/';
const INFURA_ETH_URL = process.env.INFURA_ETH_URL || 'https://mainnet.infura.io/v3/b9998be18b6941e9bc6ebbb4f1b5dfa3';
const VERCEL_URL = process.env.VERCEL_URL || 'https://petstracker-7fbrsnu3b-miles-kenneth-napilan-isatus-projects.vercel.app';

// Validate environment variables
if (!TELEGRAM_BOT_TOKEN || !INFURA_BSC_URL || !INFURA_ETH_URL || !VERCEL_URL) {
  console.error('Missing critical environment variables. Please set TELEGRAM_BOT_TOKEN, INFURA_BSC_URL, INFURA_ETH_URL, and VERCEL_URL.');
  process.exit(1);
}

// Contract addresses
const PETS_BSC_ADDRESS = '0x4bdece4e422fa015336234e4fc4d39ae6dd75b01';
const PETS_ETH_ADDRESS = '0x98b794be9c4f49900c6193aaff20876e1f36043e';

// Initialize Web3 providers
let bscWeb3, ethWeb3, bscContract, ethContract;
try {
  bscWeb3 = new Web3(new Web3.providers.HttpProvider(INFURA_BSC_URL));
  ethWeb3 = new Web3(new Web3.providers.HttpProvider(INFURA_ETH_URL));
  console.log('Web3 providers initialized');
} catch (err) {
  console.error('Failed to initialize Web3 providers:', err);
  process.exit(1);
}

// ERC-20 Transfer ABI
const ERC20_ABI = [{
  anonymous: false,
  inputs: [
    { indexed: true, name: 'from', type: 'address' },
    { indexed: true, name: 'to', type: 'address' },
    { indexed: false, name: 'value', type: 'uint256' }
  ],
  name: 'Transfer',
  type: 'event'
}];

// Initialize contracts
try {
  bscContract = new bscWeb3.eth.Contract(ERC20_ABI, PETS_BSC_ADDRESS);
  ethContract = new ethWeb3.eth.Contract(ERC20_ABI, PETS_ETH_ADDRESS);
  console.log('Contracts initialized');
} catch (err) {
  console.error('Failed to initialize contracts:', err);
  process.exit(1);
}

// In-memory data
let transactions = [];
let activeChats = new Set();

// Categorize buy amounts
const categorizeBuy = (amount) => {
  if (!bscWeb3) return 'Unknown Buy';
  const tokens = bscWeb3.utils.fromWei(amount, 'ether');
  if (tokens < 1000) return 'MicroPets Buy';
  if (tokens < 10000) return 'Medium Bullish Buy';
  return 'Whale Buy';
};

// Initialize Telegram Bot with webhook
const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: false });
const webhookPath = `/api/bot/${TELEGRAM_BOT_TOKEN}`;
const webhookUrl = `${VERCEL_URL}${webhookPath}`;

// Retry logic for setting webhook
const setWebhookWithRetry = async (retries = 5) => {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      await bot.setWebHook(webhookUrl, {
        allowed_updates: ['message'],
        max_connections: 40,
        drop_pending_updates: true
      });
      console.log(`Webhook set to ${webhookUrl} on attempt ${attempt}`);
      const webhookInfo = await bot.getWebHookInfo();
      console.log('Webhook info:', JSON.stringify(webhookInfo, null, 2));
      return true;
    } catch (err) {
      console.error(`Failed to set webhook (attempt ${attempt}/${retries}):`, err.message);
      if (attempt === retries) {
        console.error('All attempts to set webhook failed. Continuing without webhook...');
        return false;
      }
      await new Promise(resolve => setTimeout(resolve, 5000 * attempt)); // Exponential backoff
    }
  }
};

// Webhook route
app.post(webhookPath, async (req, res) => {
  try {
    console.log('Received Telegram update:', JSON.stringify(req.body, null, 2));
    await bot.processUpdate(req.body);
    res.status(200).json({ ok: true });
  } catch (err) {
    console.error('Error processing Telegram update:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Fetch the latest transaction
const fetchLatestTransaction = async () => {
  const price = 0.01; // Hardcoded fallback due to CoinGecko issues
  let latestTx = null;

  // BSC transaction
  try {
    const bscBlock = await bscWeb3.eth.getBlockNumber();
    const bscEvents = await bscContract.getPastEvents('Transfer', {
      fromBlock: Number(bscBlock) - 5, // Small range to avoid rate limits
      toBlock: Number(bscBlock)
    });
    if (bscEvents.length > 0) {
      const event = bscEvents[bscEvents.length - 1];
      const { returnValues, transactionHash } = event;
      const { to, value } = returnValues;
      const amount = bscWeb3.utils.fromWei(value, 'ether');
      latestTx = {
        chain: 'BSC',
        to,
        amount,
        usdAmount: amount * price,
        category: categorizeBuy(value),
        timestamp: Date.now(),
        transactionHash
      };
    }
  } catch (err) {
    console.error('Error fetching latest BSC transaction:', err);
  }

  // Ethereum transaction
  try {
    const ethBlock = await ethWeb3.eth.getBlockNumber();
    const ethEvents = await ethContract.getPastEvents('Transfer', {
      fromBlock: Number(ethBlock) - 5, // Small range to avoid rate limits
      toBlock: Number(ethBlock)
    });
    if (ethEvents.length > 0) {
      const event = ethEvents[ethEvents.length - 1];
      const { returnValues, transactionHash } = event;
      const { to, value } = returnValues;
      const amount = ethWeb3.utils.fromWei(value, 'ether');
      const ethTx = {
        chain: 'Ethereum',
        to,
        amount,
        usdAmount: amount * price,
        category: categorizeBuy(value),
        timestamp: Date.now(),
        transactionHash
      };
      // Compare timestamps if BSC transaction exists
      if (!latestTx || ethTx.timestamp > latestTx.timestamp) {
        latestTx = ethTx;
      }
    }
  } catch (err) {
    console.error('Error fetching latest Ethereum transaction:', err);
  }

  if (latestTx) {
    transactions.push(latestTx);
    if (transactions.length > 100) transactions.shift();
  }
  return latestTx;
};

// Telegram commands
bot.onText(/\/start/, async (msg) => {
  const startTime = Date.now();
  const chatId = msg.chat.id;
  console.log(`Processing /start for chat ${chatId}`);
  activeChats.add(chatId);
  try {
    await bot.sendMessage(chatId, 'Welcome to PETS Tracker! Use /track to see the latest transaction.');
    console.log(`/start processed in ${Date.now() - startTime}ms`);
  } catch (err) {
    console.error(`Failed to send /start message to ${chatId}:`, err);
  }
});

bot.onText(/\/track/, async (msg) => {
  const startTime = Date.now();
  const chatId = msg.chat.id;
  console.log(`Processing /track for chat ${chatId}`);
  activeChats.add(chatId);
  try {
    const latestTx = await fetchLatestTransaction();
    let message = 'Tracking PETS buys. Latest transaction:\n';
    if (latestTx) {
      message += `${latestTx.chain} ${latestTx.category}: ${latestTx.amount} PETS ($${latestTx.usdAmount.toFixed(2)}) at ${new Date(latestTx.timestamp).toLocaleString()}\n`;
    } else {
      message += 'No recent transactions found.';
    }
    await bot.sendMessage(chatId, message);
    console.log(`/track processed in ${Date.now() - startTime}ms`);
  } catch (err) {
    console.error(`Failed to send /track message to ${chatId}:`, err);
    await bot.sendMessage(chatId, 'Error fetching latest transaction. Tracking started.');
  }
});

bot.onText(/\/stop/, async (msg) => {
  const startTime = Date.now();
  const chatId = msg.chat.id;
  console.log(`Processing /stop for chat ${chatId}`);
  activeChats.delete(chatId);
  try {
    await bot.sendMessage(chatId, 'Stopped tracking PETS buys.');
    console.log(`/stop processed in ${Date.now() - startTime}ms`);
  } catch (err) {
    console.error(`Failed to send /stop message to ${chatId}:`, err);
  }
});

bot.onText(/\/stats/, async (msg) => {
  const startTime = Date.now();
  const chatId = msg.chat.id;
  console.log(`Processing /stats for chat ${chatId}`);
  const lastFive = transactions.slice(-5);
  const summary = {
    'MicroPets Buy': 0,
    'Medium Bullish Buy': 0,
    'Whale Buy': 0
  };
  lastFive.forEach(tx => {
    summary[tx.category]++;
  });
  const message = `Last 5 Transactions Stats:\nMicroPets: ${summary['MicroPets Buy']}\nMedium: ${summary['Medium Bullish Buy']}\nWhale: ${summary['Whale Buy']}`;
  try {
    await bot.sendMessage(chatId, message);
    console.log(`/stats processed in ${Date.now() - startTime}ms`);
  } catch (err) {
    console.error(`Failed to send /stats message to ${chatId}:`, err);
  }
});

bot.onText(/\/help/, async (msg) => {
  const startTime = Date.now();
  const chatId = msg.chat.id;
  console.log(`Processing /help for chat ${chatId}`);
  try {
    await bot.sendMessage(chatId, 'Available commands:\n/start - Start the bot\n/track - Enable buy alerts\n/stop - Disable buy alerts\n/stats - View last 5 transaction stats\n/status - Check tracking status\n/help - Show this message');
    console.log(`/help processed in ${Date.now() - startTime}ms`);
  } catch (err) {
    console.error(`Failed to send /help message to ${chatId}:`, err);
  }
});

bot.onText(/\/status/, async (msg) => {
  const startTime = Date.now();
  const chatId = msg.chat.id;
  console.log(`Processing /status for chat ${chatId}`);
  const isTracking = activeChats.has(chatId);
  try {
    await bot.sendMessage(chatId, `Status: ${isTracking ? 'Tracking enabled' : 'Tracking disabled'}\nTotal tracked transactions: ${transactions.length}`);
    console.log(`/status processed in ${Date.now() - startTime}ms`);
  } catch (err) {
    console.error(`Failed to send /status message to ${chatId}:`, err);
  }
});

// Start webhook
setWebhookWithRetry()
  .catch(err => {
    console.error('Failed to initialize webhook after retries:', err);
    // Do not exit, allow the bot to continue running
  });

// API route for frontend
app.get('/api/transactions', (req, res) => {
  res.json(transactions);
});

export default app;
