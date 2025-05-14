import express from 'express';
import TelegramBot from 'node-telegram-bot-api';
import Web3 from 'web3';
import axios from 'axios';

const app = express();
app.use(express.json());

// Environment variables
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '7347310243:AAGYxgwO4jMaZVkZsCPxrUN9X_GE2emq73Y';
const INFURA_BSC_URL = process.env.INFURA_BSC_URL || 'https://bsc-dataseed.binance.org/';
const INFURA_ETH_URL = process.env.INFURA_ETH_URL || 'https://mainnet.infura.io/v3/b9998be18b6941e9bc6ebbb4f1b5dfa3';
const VERCEL_URL = process.env.VERCEL_URL || 'https://petstracker-ieefindlr-miles-kenneth-napilan-isatus-projects.vercel.app/';

// Validate environment variables
if (!TELEGRAM_BOT_TOKEN || !INFURA_BSC_URL || !INFURA_ETH_URL || !VERCEL_URL) {
  console.error('Missing critical environment variables. Please set TELEGRAM_BOT_TOKEN, INFURA_BSC_URL, INFURA_ETH_URL, and VERCEL_URL.');
  process.exit(1);
}

// Contract addresses
const PETS_BSC_ADDRESS = '0x4bdece4e422fa015336234e4fc4d39ae6dd75b01';
const PETS_ETH_ADDRESS = '0x98b794be9c4f49900c6193aaff20876e1f36043e';
const PANCAKESWAP_ROUTER = '0x10ED43C718714eb63d5aA57B78B54704E256024E';
const UNISWAP_ROUTER = '0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D';

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
let lastBscBlock = 0;
let lastEthBlock = 0;

// Categorize buy amounts
const categorizeBuy = (amount) => {
  if (!bscWeb3) return 'Unknown Buy';
  const tokens = bscWeb3.utils.fromWei(amount, 'ether');
  if (tokens < 1000) return 'MicroPets Buy';
  if (tokens < 10000) return 'Medium Bullish Buy';
  return 'Whale Buy';
};

// Video mapping (assumes videos in /public/videos)
const categoryVideos = {
  'MicroPets Buy': '/videos/micropets_small.mp4',
  'Medium Bullish Buy': '/videos/micropets_medium.mp4',
  'Whale Buy': '/videos/micropets_whale.mp4'
};

// Detect DEX trade
const isDexTrade = async (txHash, chain) => {
  const web3 = chain === 'BSC' ? bscWeb3 : ethWeb3;
  const router = chain === 'BSC' ? PANCAKESWAP_ROUTER : UNISWAP_ROUTER;
  try {
    const tx = await web3.eth.getTransaction(txHash);
    return tx && tx.to?.toLowerCase() === router.toLowerCase();
  } catch (err) {
    console.error(`[DEX Check Error] Chain: ${chain}, TxHash: ${txHash}, Error:`, err);
    return false;
  }
};

// Fetch PETS price in USD from CoinGecko with retry logic
const getPetsPrice = async (retries = 3) => {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const response = await axios.get('https://api.coingecko.com/api/v3/simple/price?ids=micropets&vs_currencies=usd', {
        timeout: 5000 // 5-second timeout
      });
      return response.data.micropets?.usd || 0.01; // Fallback price
    } catch (err) {
      console.error(`Failed to fetch PETS price (attempt ${attempt}/${retries}):`, err.message);
      if (attempt === retries) return 0.01; // Final fallback
      await new Promise(resolve => setTimeout(resolve, 2000 * attempt)); // Exponential backoff
    }
  }
};

// Initialize Telegram Bot with webhook
const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: false });
const webhookPath = `/api/bot/${TELEGRAM_BOT_TOKEN}`;
const webhookUrl = `${VERCEL_URL}${webhookPath}`;

// Set webhook on startup
const setWebhook = async () => {
  try {
    await bot.setWebHook(webhookUrl, {
      allowed_updates: ['message'],
      max_connections: 40,
      drop_pending_updates: true
    });
    console.log(`Webhook set to ${webhookUrl}`);
    const webhookInfo = await bot.getWebHookInfo();
    console.log('Webhook info:', JSON.stringify(webhookInfo, null, 2));
  } catch (err) {
    console.error('Failed to set webhook:', err);
    process.exit(1);
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

// Telegram commands
bot.onText(/\/start/, async (msg) => {
  const startTime = Date.now();
  const chatId = msg.chat.id;
  console.log(`Processing /start for chat ${chatId}`);
  activeChats.add(chatId);
  try {
    await bot.sendMessage(chatId, 'Welcome to PETS Tracker! Use /track to start receiving buy alerts.');
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
    const recentTxs = await fetchRecentTransactions();
    let message = 'Started tracking PETS buys. Recent transactions:\n';
    if (recentTxs.length === 0) {
      message += 'No recent transactions found.';
    } else {
      for (const tx of recentTxs) {
        message += `${tx.chain} ${tx.category}: ${tx.amount} PETS ($${tx.usdAmount.toFixed(2)}) at ${new Date(tx.timestamp).toLocaleString()}\n`;
      }
    }
    await bot.sendMessage(chatId, message);
    console.log(`/track processed in ${Date.now() - startTime}ms`);
  } catch (err) {
    console.error(`Failed to send /track message to ${chatId}:`, err);
    await bot.sendMessage(chatId, 'Error fetching recent transactions. Tracking started.');
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
    'Whale Buy': 0,
    pairTrades: 0
  };
  lastFive.forEach(tx => {
    summary[tx.category]++;
    if (tx.isPairTrade) summary.pairTrades++;
  });
  const message = `Last 5 Transactions Stats:\nMicroPets: ${summary['MicroPets Buy']}\nMedium: ${summary['Medium Bullish Buy']}\nWhale: ${summary['Whale Buy']}\nPair Trades: ${summary.pairTrades}`;
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

// Fetch recent transactions
const fetchRecentTransactions = async () => {
  const transactions = [];
  const price = await getPetsPrice();

  // BSC transactions
  try {
    const bscBlock = await bscWeb3.eth.getBlockNumber();
    const bscEvents = await bscContract.getPastEvents('Transfer', {
      fromBlock: Number(bscBlock) - 20, // Reduced to avoid rate limits
      toBlock: Number(bscBlock)
    });
    for (const event of bscEvents.slice(-2)) {
      const { returnValues, transactionHash } = event;
      const { to, value } = returnValues;
      const amount = bscWeb3.utils.fromWei(value, 'ether');
      const isPairTrade = await isDexTrade(transactionHash, 'BSC');
      transactions.push({
        chain: 'BSC',
        to,
        amount,
        usdAmount: amount * price,
        category: categorizeBuy(value),
        timestamp: Date.now(),
        isPairTrade,
        transactionHash
      });
    }
  } catch (err) {
    console.error('Error fetching BSC transactions:', err);
  }

  // Ethereum transactions
  try {
    const ethBlock = await ethWeb3.eth.getBlockNumber();
    const ethEvents = await ethContract.getPastEvents('Transfer', {
      fromBlock: Number(ethBlock) - 20, // Reduced to avoid rate limits
      toBlock: Number(ethBlock)
    });
    for (const event of ethEvents.slice(-2)) {
      const { returnValues, transactionHash } = event;
      const { to, value } = returnValues;
      const amount = ethWeb3.utils.fromWei(value, 'ether');
      const isPairTrade = await isDexTrade(transactionHash, 'Ethereum');
      transactions.push({
        chain: 'Ethereum',
        to,
        amount,
        usdAmount: amount * price,
        category: categorizeBuy(value),
        timestamp: Date.now(),
        isPairTrade,
        transactionHash
      });
    }
  } catch (err) {
    console.error('Error fetching Ethereum transactions:', err);
  }

  return transactions.sort((a, b) => b.timestamp - a.timestamp).slice(0, 4);
};

// Monitor transactions
const monitorTransactions = async () => {
  const pollInterval = 30 * 1000; // Poll every 30 seconds
  const maxBlocksPerPoll = 10; // Reduced to avoid rate limits

  const pollChain = async (chain, web3, contract, lastBlock, router) => {
    try {
      const latestBlock = await web3.eth.getBlockNumber();
      if (lastBlock === 0) lastBlock = latestBlock - BigInt(maxBlocksPerPoll);

      const fromBlock = lastBlock;
      const toBlock = latestBlock > fromBlock + BigInt(maxBlocksPerPoll) ? fromBlock + BigInt(maxBlocksPerPoll) : latestBlock;

      if (fromBlock >= toBlock) {
        console.log(`No new blocks to poll on ${chain}.`);
        return lastBlock;
      }

      const events = await contract.getPastEvents('Transfer', {
        fromBlock: Number(fromBlock),
        toBlock: Number(toBlock)
      });

      const price = await getPetsPrice();
      for (const event of events) {
        const { returnValues, transactionHash } = event;
        const { to, value } = returnValues;
        const isPairTrade = await isDexTrade(transactionHash, chain);
        const amount = web3.utils.fromWei(value, 'ether');
        const category = categorizeBuy(value);
        const tx = {
          chain,
          to,
          amount,
          usdAmount: amount * price,
          category,
          video: categoryVideos[category] || '/videos/default.mp4',
          timestamp: Date.now(),
          isPairTrade,
          transactionHash
        };

        if (!transactions.some(t => t.transactionHash === tx.transactionHash)) {
          transactions.push(tx);
          if (transactions.length > 100) transactions.shift();

          for (const chatId of activeChats) {
            try {
              await bot.sendVideo(chatId, `${VERCEL_URL}${tx.video}`, {
                caption: `🚀 New ${category} on ${chain}${isPairTrade ? ' (Pair Trade)' : ''}!\nTo: ${to}\nAmount: ${tx.amount} PETS ($${tx.usdAmount.toFixed(2)})`
              });
            } catch (err) {
              console.error(`Failed to send video to chat ${chatId}:`, err);
            }
          }
        }
      }

      return toBlock + BigInt(1);
    } catch (err) {
      console.error(`Error polling ${chain} Transfer events:`, err.message);
      if (err.message.includes('limit exceeded')) {
        console.log(`Rate limit hit on ${chain}. Retrying in 15 seconds.`);
        await new Promise(resolve => setTimeout(resolve, 15000)); // Increased retry delay
      }
      return lastBlock;
    }
  };

  const poll = async () => {
    lastBscBlock = await pollChain('BSC', bscWeb3, bscContract, lastBscBlock, PANCAKESWAP_ROUTER);
    lastEthBlock = await pollChain('Ethereum', ethWeb3, ethContract, lastEthBlock, UNISWAP_ROUTER);
  };

  setInterval(poll, pollInterval);
  await poll();
};

// Start webhook and monitoring
Promise.all([setWebhook(), monitorTransactions()])
  .catch(err => {
    console.error('Failed to initialize bot or monitoring:', err);
    process.exit(1);
  });

// API route for frontend
app.get('/api/transactions', (req, res) => {
  res.json(transactions.map(tx => ({
    ...tx,
    video: `${VERCEL_URL}${tx.video}`
  })));
});

export default app;
