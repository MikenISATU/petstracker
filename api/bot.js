import express from 'express';
import TelegramBot from 'node-telegram-bot-api';
import Web3 from 'web3';
import https from 'https';

console.log('Web3 import:', Web3); // Debug log to verify import

const app = express();
app.use(express.json());

// Load environment variables safely
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '7347310243:AAGYxgwO4jMaZVkZsCPxrUN9X_GE2emq73Y';
const INFURA_BSC_URL = process.env.INFURA_BSC_URL || 'https://bsc-dataseed.binance.org/';
const INFURA_ETH_URL = process.env.INFURA_ETH_URL || 'https://mainnet.infura.io/v3/b9998be18b6941e9bc6ebbb4f1b5dfa3';
const VERCEL_URL = process.env.VERCEL_URL || 'https://petstokenbuy-eid20nn7i-miles-kenneth-napilan-isatus-projects.vercel.app/';
const DISABLE_BSC_POLLING = process.env.DISABLE_BSC_POLLING === 'true';

// Validate environment variables
if (!TELEGRAM_BOT_TOKEN || !INFURA_BSC_URL || !INFURA_ETH_URL || !VERCEL_URL) {
  console.error('Missing critical environment variables. Please check configuration.');
  process.exit(1);
}

// Contract addresses
const PETS_BSC_ADDRESS = '0x4bdece4e422fa015336234e4fc4d39ae6dd75b01';
const PETS_ETH_ADDRESS = '0x98b794be9c4f49900c6193aaff20876e1f36043e';

// DEX router addresses
const PANCAKESWAP_ROUTER = '0x10ED43C718714eb63d5aA57B78B54704E256024E';
const UNISWAP_ROUTER = '0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D';

// Initialize Web3 providers with HttpProvider
let bscWeb3, ethWeb3;
try {
  bscWeb3 = new Web3(new Web3.providers.HttpProvider(INFURA_BSC_URL));
  console.log('bscWeb3 initialized:', !!bscWeb3);
} catch (err) {
  console.error('Failed to initialize bscWeb3:', err);
  process.exit(1);
}

try {
  ethWeb3 = new Web3(new Web3.providers.HttpProvider(INFURA_ETH_URL));
  console.log('ethWeb3 initialized:', !!ethWeb3);
} catch (err) {
  console.error('Failed to initialize ethWeb3:', err);
  process.exit(1);
}

// ERC-20 Transfer ABI (for events only)
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
let bscContract, ethContract;
try {
  bscContract = new bscWeb3.eth.Contract(ERC20_ABI, PETS_BSC_ADDRESS);
  console.log('bscContract initialized:', !!bscContract);
} catch (err) {
  console.error('Failed to initialize bscContract:', err);
  process.exit(1);
}

try {
  ethContract = new ethWeb3.eth.Contract(ERC20_ABI, PETS_ETH_ADDRESS);
  console.log('ethContract initialized:', !!ethContract);
} catch (err) {
  console.error('Failed to initialize ethContract:', err);
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

// Video mapping
const categoryVideos = {
  'MicroPets Buy': '/videos/micropets_small.mp4',
  'Medium Bullish Buy': '/videos/micropets_medium.mp4',
  'Whale Buy': '/videos/micropets_whale.mp4'
};

// Detect DEX trade
const isDexTrade = async (txHash, chain) => {
  const web3 = chain === 'BSC' ? bscWeb3 : ethWeb3;
  const router = chain === 'BSC' ? PANCAKESWAP_ROUTER : UNISWAP_ROUTER;
  if (!web3) return false;
  try {
    const tx = await web3.eth.getTransaction(txHash);
    return tx && tx.to?.toLowerCase() === router.toLowerCase();
  } catch (err) {
    console.error(`[DEX Check Error] Chain: ${chain}, TxHash: ${txHash}, Error:`, err);
    return false;
  }
};

// Initialize Telegram Bot
const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: false }); // Webhook preferred

// Set webhook with retries and verify status
const setWebhook = async (retries = 5, delay = 3000, timeout = 10000) => {
  const webhookUrl = `${VERCEL_URL}/api/bot`;
  const setUrl = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook?url=${encodeURIComponent(webhookUrl)}`;
  const getUrl = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getWebhookInfo`;

  const makeRequest = (url) => {
    return new Promise((resolve, reject) => {
      const req = https.get(url, { timeout }, (res) => {
        let data = '';
        res.on('data', (chunk) => data += chunk);
        res.on('end', () => {
          try {
            const result = JSON.parse(data);
            resolve(result);
          } catch (err) {
            reject(new Error(`Error parsing response: ${err.message}`));
          }
        });
      });
      req.on('error', (err) => reject(err));
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Request timed out'));
      });
    });
  };

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      console.log(`Attempt ${attempt} to set webhook: ${webhookUrl}`);
      const setResult = await makeRequest(setUrl);
      if (setResult.ok) {
        // Verify webhook status
        const webhookInfo = await makeRequest(getUrl);
        if (webhookInfo.ok && webhookInfo.result.url === webhookUrl) {
          console.log(`Webhook verified and active: ${webhookUrl}`);
          return true;
        } else {
          console.warn(`Webhook set but not verified. Info: ${JSON.stringify(webhookInfo)}`);
        }
      } else {
        console.error(`Webhook setup failed: ${JSON.stringify(setResult)}`);
      }
    } catch (err) {
      console.error(`Error setting webhook (attempt ${attempt}): ${err.message}`, err);
      if (attempt < retries) {
        console.log(`Retrying in ${delay / 1000} seconds...`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }

  console.error('All webhook setup attempts failed. Falling back to polling (1s interval).');
  console.log(`Manual webhook setup command: curl -X GET "${setUrl}"`);
  bot._polling = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: { interval: 1000 } });
  return false;
};

// Telegram webhook route
app.post('/api/bot', (req, res) => {
  try {
    console.log('Received Telegram update:', JSON.stringify(req.body));
    bot.processUpdate(req.body);
    res.sendStatus(200);
  } catch (err) {
    console.error('Error processing Telegram update:', err);
    res.sendStatus(500);
  }
});

// Telegram commands
bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  const startTime = Date.now();
  console.log(`Processing /start for chat ${chatId}`);
  activeChats.add(chatId);
  bot.sendMessage(chatId, 'Welcome to PETS Tracker! Use /track to start receiving buy alerts.')
    .then(() => console.log(`/start response sent to ${chatId} in ${Date.now() - startTime}ms`))
    .catch(err => console.error(`Failed to send /start message to ${chatId}:`, err));
});

bot.onText(/\/track/, (msg) => {
  const chatId = msg.chat.id;
  const startTime = Date.now();
  console.log(`Processing /track for chat ${chatId}`);
  activeChats.add(chatId);
  bot.sendMessage(chatId, 'Started tracking PETS buys. You’ll get notified on new buys.')
    .then(() => console.log(`/track response sent to ${chatId} in ${Date.now() - startTime}ms`))
    .catch(err => console.error(`Failed to send /track message to ${chatId}:`, err));
});

bot.onText(/\/stop/, (msg) => {
  const chatId = msg.chat.id;
  const startTime = Date.now();
  console.log(`Processing /stop for chat ${chatId}`);
  activeChats.delete(chatId);
  bot.sendMessage(chatId, 'Stopped tracking PETS buys.')
    .then(() => console.log(`/stop response sent to ${chatId} in ${Date.now() - startTime}ms`))
    .catch(err => console.error(`Failed to send /stop message to ${chatId}:`, err));
});

bot.onText(/\/stats/, async (msg) => {
  const chatId = msg.chat.id;
  const startTime = Date.now();
  console.log(`Processing /stats for chat ${chatId}`);
  const lastTx = transactions.slice(-1)[0]; // Get the most recent transaction
  let message = 'Most Recent Transaction:\n\n';
  if (!lastTx) {
    message += 'No transactions recorded yet.';
    bot.sendMessage(chatId, message)
      .then(() => console.log(`/stats response sent to ${chatId} in ${Date.now() - startTime}ms`))
      .catch(err => console.error(`Failed to send /stats message to ${chatId}:`, err));
  } else {
    const date = new Date(lastTx.timestamp).toISOString();
    message += `Chain: ${lastTx.chain}\n`;
    message += `To Address: ${lastTx.to}\n`;
    message += `Amount: ${lastTx.amount} PETS\n`;
    message += `Category: ${lastTx.category}\n`;
    message += `Pair Trade: ${lastTx.isPairTrade ? 'Yes' : 'No'}\n`;
    message += `Timestamp: ${date}`;
    try {
      await bot.sendVideo(chatId, `${VERCEL_URL}${lastTx.video}`, {
        caption: message
      });
      console.log(`/stats video and message sent to ${chatId} in ${Date.now() - startTime}ms`);
    } catch (err) {
      console.error(`Failed to send /stats video to ${chatId}:`, err);
      bot.sendMessage(chatId, `${message}\n(Note: Video failed to send. Check server logs.)`)
        .then(() => console.log(`/stats fallback message sent to ${chatId} in ${Date.now() - startTime}ms`))
        .catch(err => console.error(`Failed to send /stats fallback message to ${chatId}:`, err));
    }
  }
});

bot.onText(/\/help/, (msg) => {
  const chatId = msg.chat.id;
  const startTime = Date.now();
  console.log(`Processing /help for chat ${chatId}`);
  bot.sendMessage(chatId, 'Available commands:\n/start - Start the bot\n/track - Enable buy alerts\n/stop - Disable buy alerts\n/stats - View most recent transaction\n/status - Check tracking status\n/help - Show this message\n/setwebhook - Manually set webhook')
    .then(() => console.log(`/help response sent to ${chatId} in ${Date.now() - startTime}ms`))
    .catch(err => console.error(`Failed to send /help message to ${chatId}:`, err));
});

bot.onText(/\/status/, (msg) => {
  const chatId = msg.chat.id;
  const startTime = Date.now();
  console.log(`Processing /status for chat ${chatId}`);
  const isTracking = activeChats.has(chatId);
  bot.sendMessage(chatId, `Status: ${isTracking ? 'Tracking enabled' : 'Tracking disabled'}\nTotal tracked transactions: ${transactions.length}`)
    .then(() => console.log(`/status response sent to ${chatId} in ${Date.now() - startTime}ms`))
    .catch(err => console.error(`Failed to send /status message to ${chatId}:`, err));
});

bot.onText(/\/setwebhook/, async (msg) => {
  const chatId = msg.chat.id;
  const startTime = Date.now();
  console.log(`Processing /setwebhook for chat ${chatId}`);
  try {
    const success = await setWebhook(3, 2000, 8000);
    bot.sendMessage(chatId, success ? 'Webhook set successfully!' : 'Failed to set webhook. Check logs for details.')
      .then(() => console.log(`/setwebhook response sent to ${chatId} in ${Date.now() - startTime}ms`))
      .catch(err => console.error(`Failed to send /setwebhook message to ${chatId}:`, err));
  } catch (err) {
    console.error(`Error in /setwebhook: ${err.message}`);
    bot.sendMessage(chatId, 'Error setting webhook. Check logs.')
      .then(() => console.log(`/setwebhook response sent to ${chatId} in ${Date.now() - startTime}ms`))
      .catch(err => console.error(`Failed to send /setwebhook message to ${chatId}:`, err));
  }
});

// Polling function with rate limit handling
const monitorTransactions = async () => {
  const pollInterval = 120 * 1000; // Poll every 120 seconds
  const maxBlocksPerPoll = 3; // Limit to 3 blocks per poll
  let retryDelay = 5000; // Initial retry delay for rate limits

  const pollBsc = async () => {
    if (DISABLE_BSC_POLLING) {
      console.log('BSC polling disabled via DISABLE_BSC_POLLING.');
      return;
    }
    try {
      const latestBlock = await bscWeb3.eth.getBlockNumber();
      if (lastBscBlock === 0) lastBscBlock = latestBlock - BigInt(maxBlocksPerPoll);

      const fromBlock = lastBscBlock;
      const toBlock = latestBlock > fromBlock + BigInt(maxBlocksPerPoll) ? fromBlock + BigInt(maxBlocksPerPoll) : latestBlock;

      if (fromBlock >= toBlock) {
        console.log('No new blocks to poll on BSC.');
        return;
      }

      const events = await bscContract.getPastEvents('Transfer', {
        fromBlock: Number(fromBlock),
        toBlock: Number(toBlock)
      });

      for (const event of events) {
        const { returnValues, transactionHash } = event;
        const { to, value } = returnValues;
        const isPairTrade = await isDexTrade(transactionHash, 'BSC');
        const category = categorizeBuy(value);
        const tx = {
          chain: 'BSC',
          to,
          amount: bscWeb3.utils.fromWei(value, 'ether'),
          category,
          video: categoryVideos[category] || '/videos/default.mp4',
          timestamp: Date.now(),
          isPairTrade,
          transactionHash
        };

        // Deduplicate by transactionHash
        if (!transactions.some(t => t.transactionHash === tx.transactionHash)) {
          transactions.push(tx);
          if (transactions.length > 100) transactions.shift();

          for (const chatId of activeChats) {
            try {
              await bot.sendVideo(chatId, `${VERCEL_URL}${tx.video}`, {
                caption: `🚀 New ${category} on BSC${isPairTrade ? ' (Pair Trade)' : ''}!\nTo: ${to}\nAmount: ${tx.amount} PETS`
              });
            } catch (err) {
              console.error(`Failed to send video to chat ${chatId}:`, err);
            }
          }
        }
      }

      lastBscBlock = toBlock + BigInt(1);
      retryDelay = 5000; // Reset retry delay on success
    } catch (err) {
      console.error('Error polling BSC Transfer events:', err.message);
      if (err.message.includes('limit exceeded')) {
        console.warn('Persistent rate limits detected. Strongly recommend using a dedicated BSC node provider (e.g., Infura, QuickNode, Ankr) to avoid throttling. Alternatively, set DISABLE_BSC_POLLING=true.');
        console.log(`Rate limit hit. Retrying in ${retryDelay / 1000} seconds.`);
        await new Promise(resolve => setTimeout(resolve, retryDelay));
        retryDelay = Math.min(retryDelay * 2, 120000); // Exponential backoff, max 120s
      }
    }
  };

  const pollEth = async () => {
    try {
      const latestBlock = await ethWeb3.eth.getBlockNumber();
      if (lastEthBlock === 0) lastEthBlock = latestBlock - BigInt(maxBlocksPerPoll);

      const fromBlock = lastEthBlock;
      const toBlock = latestBlock > fromBlock + BigInt(maxBlocksPerPoll) ? fromBlock + BigInt(maxBlocksPerPoll) : latestBlock;

      if (fromBlock >= toBlock) {
        console.log('No new blocks to poll on Ethereum.');
        return;
      }

      const events = await ethContract.getPastEvents('Transfer', {
        fromBlock: Number(fromBlock),
        toBlock: Number(toBlock)
      });

      for (const event of events) {
        const { returnValues, transactionHash } = event;
        const { to, value } = returnValues;
        const isPairTrade = await isDexTrade(transactionHash, 'Ethereum');
        const category = categorizeBuy(value);
        const tx = {
          chain: 'Ethereum',
          to,
          amount: ethWeb3.utils.fromWei(value, 'ether'),
          category,
          video: categoryVideos[category] || '/videos/default.mp4',
          timestamp: Date.now(),
          isPairTrade,
          transactionHash
        };

        // Deduplicate by transactionHash
        if (!transactions.some(t => t.transactionHash === tx.transactionHash)) {
          transactions.push(tx);
          if (transactions.length > 100) transactions.shift();

          for (const chatId of activeChats) {
            try {
              await bot.sendVideo(chatId, `${VERCEL_URL}${tx.video}`, {
                caption: `🚀 New ${category} on Ethereum${isPairTrade ? ' (Pair Trade)' : ''}!\nTo: ${to}\nAmount: ${tx.amount} PETS`
              });
            } catch (err) {
              console.error(`Failed to send video to chat ${chatId}:`, err);
            }
          }
        }
      }

      lastEthBlock = toBlock + BigInt(1);
      retryDelay = 5000; // Reset retry delay on success
    } catch (err) {
      console.error('Error polling Ethereum Transfer events:', err.message);
      if (err.message.includes('limit exceeded')) {
        console.log(`Rate limit hit. Retrying in ${retryDelay / 1000} seconds.`);
        await new Promise(resolve => setTimeout(resolve, retryDelay));
        retryDelay = Math.min(retryDelay * 2, 120000); // Exponential backoff, max 120s
      }
    }
  };

  // Run polling loops
  if (!DISABLE_BSC_POLLING) setInterval(pollBsc, pollInterval);
  setInterval(pollEth, pollInterval);

  // Run immediately on start
  if (!DISABLE_BSC_POLLING) await pollBsc();
  await pollEth();
};

// Start monitoring and webhook setup
try {
  setWebhook().then(() => monitorTransactions());
} catch (err) {
  console.error('Failed to start application:', err);
  process.exit(1);
}

// API route for frontend
app.get('/api/transactions', (req, res) => {
  res.json(transactions.map(tx => ({
    ...tx,
    video: `${VERCEL_URL}${tx.video}`
  })));
});

// Export for serverless handler
export default app;
