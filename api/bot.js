import express from 'express';
import TelegramBot from 'node-telegram-bot-api';
import axios from 'axios';
import { load } from 'cheerio';
import pRetry from 'p-retry';
import { Agent } from 'undici';
import dotenv from 'dotenv';

// Load environment variables
dotenv.config();

// Initialize Express app
const app = express();
app.use(express.json());

// Environment variables with fallbacks
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '7347310243:AAGYxgwO4jMaZVkZsCPxrUN9X_GE2emq73Y';
const BSCSCAN_API_KEY = process.env.BSCSCAN_API_KEY || 'https://bsc.nownodes.io/97a8bb57-9985-48b3-ad57-8054752cfcb5';
const ETHERSCAN_API_KEY = process.env.ETHERSCAN_API_KEY || 'https://rpc.ankr.com/eth';
const CLOUDINARY_CLOUD_NAME = process.env.CLOUDINARY_CLOUD_NAME || 'da4k3yxhu';
const DEFAULT_VERCEL_URL = 'https://petstracker-8mqe0par9-miles-kenneth-napilan-isatus-projects.vercel.app';
const VERCEL_URL = (process.env.VERCEL_URL || DEFAULT_VERCEL_URL).startsWith('https://')
  ? process.env.VERCEL_URL || DEFAULT_VERCEL_URL
  : `https://${process.env.VERCEL_URL || DEFAULT_VERCEL_URL}`;

// Log VERCEL_URL for debugging
console.log(`VERCEL_URL: ${VERCEL_URL}`);

// Validate environment variables
let useMockData = false;
if (!TELEGRAM_BOT_TOKEN || !CLOUDINARY_CLOUD_NAME) {
  console.error('Missing critical environment variables: TELEGRAM_BOT_TOKEN or CLOUDINARY_CLOUD_NAME.');
  process.exit(1);
}
if (BSCSCAN_API_KEY === 'YOUR_BSCSCAN_API_KEY' || ETHERSCAN_API_KEY === 'YOUR_ETHERSCAN_API_KEY' ||
    BSCSCAN_API_KEY.startsWith('http') || ETHERSCAN_API_KEY.startsWith('http')) {
  console.warn('Invalid BSCSCAN_API_KEY or ETHERSCAN_API_KEY. Using mock data.');
  useMockData = true;
}

// Contract and target addresses
const PETS_BSC_ADDRESS = '0x2466858ab5edad0bb597fe9f008f568b00d25fe3';
const PETS_BSC_TARGET_ADDRESS = '0x4BDECe4E422fA015336234e4FC4D39ae6dD75b01';
const PETS_ETH_ADDRESS = '0x2466858ab5edAd0BB597FE9f008F568B00d25Fe3';
const PETS_ETH_TARGET_ADDRESS = '0x98B794be9C4f49900C6193aAff20876e1f36043e';

// Configure HTTP keep-alive agent
const httpAgent = new Agent({
  keepAliveTimeout: 90000,
  keepAliveMaxTimeout: 180000,
  connections: 3,
});

// In-memory data
let transactions = [];
let activeChats = new Set();
let postedTransactions = new Set();
let lastFetchTime = { BSC: 0, Ethereum: 0, Prices: 0 };
const CACHE_DURATION = 10 * 60 * 1000; // 10 minutes
const PRICE_CACHE_DURATION = 60 * 1000; // 1 minute
const VIDEO_CACHE = {
  'MicroPets Buy': `https://res.cloudinary.com/${CLOUDINARY_CLOUD_NAME}/video/upload/SMALLBUY_b3px1p.mp4`,
  'Medium Bullish Buy': `https://res.cloudinary.com/${CLOUDINARY_CLOUD_NAME}/video/upload/MEDIUMBUY_MPEG_e02zdz.mp4`,
  'Whale Buy': `https://res.cloudinary.com/${CLOUDINARY_CLOUD_NAME}/video/upload/micropets_big_msapxz.mp4`,
};

// Escape MarkdownV2 characters
const escapeMarkdownV2 = (text) => {
  const specialChars = ['_', '*', '[', ']', '(', ')', '~', '`', '>', '#', '+', '-', '=', '|', '{', '}', '.', '!'];
  return specialChars.reduce((str, char) => str.split(char).join(`\\${char}`), String(text));
};

// Mock transaction for testing
const mockTransaction = (chain) => ({
  chain,
  to: chain === 'BSC' ? PETS_BSC_TARGET_ADDRESS : PETS_ETH_TARGET_ADDRESS,
  amount: '5000',
  category: 'Medium Bullish Buy',
  video: VIDEO_CACHE['Medium Bullish Buy'],
  videoDisplay: '[Medium Buy Video]',
  timestamp: Date.now(),
  transactionHash: '0x' + Array.from({ length: 64 }, () => Math.floor(Math.random() * 16).toString(16)).join(''),
  tokenValue: chain === 'BSC' ? '$500.00' : '$1000.00',
  marketCap: '$10M',
  hodlerLast4: '5678',
  hash: '0x' + Array.from({ length: 64 }, () => Math.floor(Math.random() * 16).toString(16)).join(''),
  value: '5000' + '0'.repeat(18), // Simulate 5000 tokens
  from: chain === 'BSC' ? PETS_BSC_TARGET_ADDRESS : PETS_ETH_TARGET_ADDRESS,
});

// Fetch real-time prices from CoinGecko
let cachedPrices = { bnbPrice: 600, ethPrice: 2600 };
const fetchPrices = async () => {
  if (Date.now() - lastFetchTime.Prices < PRICE_CACHE_DURATION) {
    console.log('[Prices] Using cached prices.');
    return cachedPrices;
  }

  try {
    const response = await axios.get('https://api.coingecko.com/api/v3/simple/price?ids=binancecoin,ethereum&vs_currencies=usd', {
      timeout: 10000,
      httpAgent,
    });
    cachedPrices = {
      bnbPrice: response.data.binancecoin.usd || 600,
      ethPrice: response.data.ethereum.usd || 2600,
    };
    lastFetchTime.Prices = Date.now();
    return cachedPrices;
  } catch (error) {
    console.error('Error fetching prices:', error.message);
    return cachedPrices;
  }
};

// Fetch transactions from BscScan/Etherscan
const fetchTransactions = async (chain) => {
  if (useMockData) {
    console.log(`[${chain}] Using mock transactions due to invalid API keys.`);
    return [mockTransaction(chain)];
  }

  const apiKey = chain === 'BSC' ? BSCSCAN_API_KEY : ETHERSCAN_API_KEY;
  const contractAddress = chain === 'BSC' ? PETS_BSC_ADDRESS : PETS_ETH_ADDRESS;
  const targetAddress = chain === 'BSC' ? PETS_BSC_TARGET_ADDRESS : PETS_ETH_TARGET_ADDRESS;
  const url = chain === 'BSC'
    ? `https://api.bscscan.com/api?module=account&action=tokentx&contractaddress=${contractAddress}&address=${targetAddress}&page=1&offset=5&sort=desc&apikey=${apiKey}`
    : `https://api.etherscan.io/api?module=account&action=tokentx&contractaddress=${contractAddress}&address=${targetAddress}&startblock=0&endblock=99999999&sort=desc&apikey=${apiKey}`;

  // Check cache
  if (Date.now() - lastFetchTime[chain] < CACHE_DURATION) {
    console.log(`[${chain}] Using cached transactions.`);
    return transactions.filter(tx => tx.chain === chain).slice(0, 5);
  }

  try {
    const response = await pRetry(
      () => axios.get(url, {
        timeout: 30000,
        httpAgent,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/58.0.3029.110 Safari/537.3',
        },
      }),
      {
        retries: 5,
        minTimeout: 2000,
        maxTimeout: 10000,
        factor: 2,
        onFailedAttempt: (error) => {
          console.error(`[${chain}] Fetch attempt ${error.attemptNumber} failed: ${error.message} (URL: ${url})`);
        },
      }
    );

    if (response.data.status === '1') {
      console.log(`[${chain}] Successfully fetched ${response.data.result.length} transactions.`);
      lastFetchTime[chain] = Date.now();
      return response.data.result.slice(0, 5);
    } else {
      console.error(`[${chain}] API Error: ${response.data.message} (Result: ${response.data.result})`);
      return [mockTransaction(chain)];
    }
  } catch (error) {
    console.error(`[${chain}] Error fetching transactions: ${error.message}`);
    return [mockTransaction(chain)];
  }
};

// Check if transaction is a DEX trade (simplified)
const isDexTrade = async (txHash, chain) => {
  if (useMockData) return true; // Mock transactions are considered DEX trades
  // Assume tokentx API results are DEX trades to skip scraping
  return true;
};

// Extract BNB/ETH value (use API data or mock)
const extractTokenValue = async (tx, chain, prices) => {
  if (useMockData) return 1.0; // Mock value for 5000 tokens
  // Estimate value using token amount and current price
  const tokens = parseFloat(tx.value) / 1e18;
  const price = chain === 'BSC' ? prices.bnbPrice : prices.ethPrice;
  return tokens / 1e6; // Approximate token-to-BNB/ETH ratio
};

// Get last 4 characters of holder address (from tx.from)
const getHodlerLast4 = async (tx, chain) => {
  if (useMockData) return '5678';
  return tx.from.slice(-4);
};

// Calculate Market Cap (placeholder)
const getMarketCap = async () => {
  return '$10M';
};

// Categorize buy amounts
const categorizeBuy = (amount) => {
  const tokens = parseFloat(amount) / 1e18;
  if (tokens < 1000) return 'MicroPets Buy';
  if (tokens < 10000) return 'Medium Bullish Buy';
  return 'Whale Buy';
};

// Video display placeholders
const categoryVideoDisplays = {
  'MicroPets Buy': '[Small Buy Video]',
  'Medium Bullish Buy': '[Medium Buy Video]',
  'Whale Buy': '[Large Buy Video]',
};

// Get Cloudinary video URL
const getVideoUrl = (category) => {
  return VIDEO_CACHE[category] || VIDEO_CACHE['Medium Bullish Buy'];
};

// Initialize Telegram Bot (polling as fallback)
const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: false });

// Set Telegram webhook with retries
const setWebhook = async () => {
  const webhookUrl = `${VERCEL_URL}/api/bot`;
  try {
    await pRetry(
      () => axios.get(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook?url=${webhookUrl}`, {
        timeout: 15000,
        httpAgent,
      }),
      {
        retries: 3,
        minTimeout: 1000,
        maxTimeout: 5000,
        factor: 2,
        onFailedAttempt: (error) => {
          console.error(`Webhook setup attempt ${error.attemptNumber} failed: ${error.message}`);
        },
      }
    );
    console.log(`Webhook set successfully: ${webhookUrl}`);
    return true;
  } catch (error) {
    console.error(`Failed to set webhook after retries: ${error.message}`);
    return false;
  }
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
  activeChats.add(chatId);
  bot.sendMessage(chatId, '👋 Welcome to PETS Tracker! Use /track to start receiving buy alerts.', { parse_mode: 'MarkdownV2' })
    .catch(err => console.error(`Failed to send /start message to ${chatId}:`, err));
});

bot.onText(/\/track/, (msg) => {
  const chatId = msg.chat.id;
  activeChats.add(chatId);
  bot.sendMessage(chatId, '📈 Started tracking PETS buys. You’ll get notified on new buys for BNB and ETH pairs.', { parse_mode: 'MarkdownV2' })
    .catch(err => console.error(`Failed to send /track message to ${chatId}:`, err));
});

bot.onText(/\/stop/, (msg) => {
  const chatId = msg.chat.id;
  activeChats.delete(chatId);
  bot.sendMessage(chatId, '🛑 Stopped tracking PETS buys.', { parse_mode: 'MarkdownV2' })
    .catch(err => console.error(`Failed to send /stop message to ${chatId}:`, err));
});

bot.onText(/\/stats/, async (msg) => {
  const chatId = msg.chat?.id;
  if (!chatId) return;

  let bscMessage = 'BNB Pair: No transactions recorded yet.';
  let ethMessage = 'ETH Pair: No transactions recorded yet.';

  const bscTxs = transactions.filter(tx => tx.chain === 'BSC').sort((a, b) => b.timestamp - a.timestamp);
  const ethTxs = transactions.filter(tx => tx.chain === 'Ethereum').sort((a, b) => b.timestamp - a.timestamp);

  // Use real or mock transaction
  const bscTx = bscTxs.length > 0 ? bscTxs[0] : mockTransaction('BSC');
  const ethTx = ethTxs.length > 0 ? ethTxs[0] : mockTransaction('Ethereum');

  const bscScanUrl = `https://bscscan.com/tx/${bscTx.transactionHash}`;
  bscMessage = `@MicroPetsBuy_bot\nMicroPets Buy - BNB Pair\n${escapeMarkdownV2(bscTx.videoDisplay)}\n*💰 BNB Value*: ${escapeMarkdownV2(bscTx.tokenValue)}\n*📊 Market Cap*: ${escapeMarkdownV2(bscTx.marketCap)}\n*🧳 Holdings*: ${escapeMarkdownV2(bscTx.amount)} $PETS\n*👤 Holder*: ...${escapeMarkdownV2(bscTx.hodlerLast4)}\n[BscScan](${bscScanUrl})\n\n📍 [Staking](https://pets.micropets.io/petdex) 📊 [Chart](https://www.dextools.io/app/en/bnb/pair-explorer/0x4bdece4e422fa015336234e4fc4d39ae6dd75b01) 🛍️ [Merch](https://micropets.store/) 💰 [Buy $PETS](https://pancakeswap.finance/swap?outputCurrency=${PETS_BSC_ADDRESS})`;

  const etherscanUrl = `https://etherscan.io/tx/${ethTx.transactionHash}`;
  ethMessage = `@MicroPetsBuy_bot\nMicroPets Buy - ETH Pair\n${escapeMarkdownV2(ethTx.videoDisplay)}\n*💰 ETH Value*: ${escapeMarkdownV2(ethTx.tokenValue)}\n*📊 Market Cap*: ${escapeMarkdownV2(ethTx.marketCap)}\n*🧳 Holdings*: ${escapeMarkdownV2(ethTx.amount)} $PETS\n*👤 Holder*: ...${escapeMarkdownV2(ethTx.hodlerLast4)}\n[Etherscan](${etherscanUrl})\n\n📍 [Staking](https://pets.micropets.io/petdex) 📊 [Chart](https://www.dextools.io/app/en/ether/pair-explorer/0x98b794be9c4f49900c6193aaff20876e1f36043e?t=1726815772329) 🛍️ [Merch](https://micropets.store/) 💰 [Buy $PETS](https://app.uniswap.org/swap?chain=mainnet&inputCurrency=NATIVE&outputCurrency=${PETS_ETH_ADDRESS})`;

  const message = `📊 *Latest $PETS Transactions:*\n\n${bscMessage}\n\n${ethMessage}`;
  await bot.sendMessage(chatId, message, { parse_mode: 'MarkdownV2' })
    .catch(err => console.error(`Failed to send /stats message to ${chatId}:`, err));
});

bot.onText(/\/help/, (msg) => {
  const chatId = msg.chat.id;
  bot.sendMessage(chatId, '🆘 *Available commands:*\n/start - Start the bot\n/track - Enable buy alerts\n/stop - Disable buy alerts\n/stats - View latest buy from BSC and Ethereum\n/status - Check tracking status\n/test - Show a sample buy template\n/help - Show this message', { parse_mode: 'MarkdownV2' })
    .catch(err => console.error(`Failed to send /help message to ${chatId}:`, err));
});

bot.onText(/\/status/, (msg) => {
  const chatId = msg.chat.id;
  const isTracking = activeChats.has(chatId);
  bot.sendMessage(chatId, `🔍 *Status:* ${isTracking ? 'Tracking enabled' : 'Tracking disabled'}\n*Total tracked transactions:* ${transactions.length}`, { parse_mode: 'MarkdownV2' })
    .catch(err => console.error(`Failed to send /status message to ${chatId}:`, err));
});

bot.onText(/\/test/, async (msg) => {
  const chatId = msg.chat.id;
  const category = 'Medium Bullish Buy';
  const videoDisplay = categoryVideoDisplays[category] || '[Medium Buy Video]';
  const videoUrl = getVideoUrl(category);
  const randomTxHash = '0x' + Array.from({ length: 64 }, () => Math.floor(Math.random() * 16).toString(16)).join('');
  const hodlerLast4 = '5678';
  const tokens = '5000';
  const chain = 'BSC';
  const tokenValue = '$500.00';
  const marketCap = '$10M';
  const scanUrl = `https://bscscan.com/tx/${randomTxHash}`;
  const message = `@MicroPetsBuy_bot\nMicroPets Buy - BNB Pair\n${escapeMarkdownV2(videoDisplay)}\n*💰 BNB Value*: ${escapeMarkdownV2(tokenValue)}\n*📊 Market Cap*: ${escapeMarkdownV2(marketCap)}\n*🧳 Holdings*: ${escapeMarkdownV2(tokens)} $PETS\n*👤 Holder*: ...${escapeMarkdownV2(hodlerLast4)}\n[BscScan](${scanUrl})\n\n📍 [Staking](https://pets.micropets.io/petdex) 📊 [Chart](https://www.dextools.io/app/en/bnb/pair-explorer/0x4bdece4e422fa015336234e4fc4d39ae6dd75b01) 🛍️ [Merch](https://micropets.store/) 💰 [Buy $PETS](https://pancakeswap.finance/swap?outputCurrency=${PETS_BSC_ADDRESS})`;

  try {
    await bot.sendMessage(chatId, message, { parse_mode: 'MarkdownV2' });
    console.log(`Successfully sent /test message to chat ${chatId}`);
  } catch (err) {
    console.error(`Failed to send /test message to chat ${chatId}:`, err.message);
  }
});

// Process transaction
const processTransaction = async (tx, chain, prices) => {
  if (postedTransactions.has(tx.hash)) return;

  const isTrade = await isDexTrade(tx.hash, chain);
  if (!isTrade) return;

  const tokenValue = await extractTokenValue(tx, chain, prices);
  if (!tokenValue) return;

  const price = chain === 'BSC' ? prices.bnbPrice : prices.ethPrice;
  const usdValue = (tokenValue * price).toFixed(2);
  const tokens = (parseFloat(tx.value) / 1e18).toFixed(0);
  const category = categorizeBuy(tx.value);
  const videoUrl = getVideoUrl(category);
  const videoDisplay = categoryVideoDisplays[category] || '[Default Video]';
  const marketCap = await getMarketCap();
  const hodlerLast4 = await getHodlerLast4(tx, chain);
  const scanUrl = chain === 'BSC' ? `https://bscscan.com/tx/${tx.hash}` : `https://etherscan.io/tx/${tx.hash}`;

  const txData = {
    chain,
    to: tx.to,
    amount: tokens,
    category,
    video: videoUrl,
    videoDisplay,
    timestamp: Date.now(),
    transactionHash: tx.hash,
    tokenValue: `$${usdValue}`,
    marketCap,
    hodlerLast4,
  };

  transactions.push(txData);
  if (transactions.length > 100) transactions.shift();
  postedTransactions.add(tx.hash);

  const message = chain === 'BSC'
    ? `@MicroPetsBuy_bot\nMicroPets Buy - BNB Pair\n${escapeMarkdownV2(videoDisplay)}\n*💰 BNB Value*: ${escapeMarkdownV2(`$${usdValue}`)}\n*📊 Market Cap*: ${escapeMarkdownV2(marketCap)}\n*🧳 Holdings*: ${escapeMarkdownV2(tokens)} $PETS\n*👤 Holder*: ...${escapeMarkdownV2(hodlerLast4)}\n[BscScan](${scanUrl})\n\n📍 [Staking](https://pets.micropets.io/petdex) 📊 [Chart](https://www.dextools.io/app/en/bnb/pair-explorer/0x4bdece4e422fa015336234e4fc4d39ae6dd75b01) 🛍️ [Merch](https://micropets.store/) 💰 [Buy $PETS](https://pancakeswap.finance/swap?outputCurrency=${PETS_BSC_ADDRESS})`
    : `@MicroPetsBuy_bot\nMicroPets Buy - ETH Pair\n${escapeMarkdownV2(videoDisplay)}\n*💰 ETH Value*: ${escapeMarkdownV2(`$${usdValue}`)}\n*📊 Market Cap*: ${escapeMarkdownV2(marketCap)}\n*🧳 Holdings*: ${escapeMarkdownV2(tokens)} $PETS\n*👤 Holder*: ...${escapeMarkdownV2(hodlerLast4)}\n[Etherscan](${scanUrl})\n\n📍 [Staking](https://pets.micropets.io/petdex) 📊 [Chart](https://www.dextools.io/app/en/ether/pair-explorer/0x98b794be9c4f49900c6193aaff20876e1f36043e?t=1726815772329) 🛍️ [Merch](https://micropets.store/) 💰 [Buy $PETS](https://app.uniswap.org/swap?chain=mainnet&inputCurrency=NATIVE&outputCurrency=${PETS_ETH_ADDRESS})`;

  const sendPromises = Array.from(activeChats).map(chatId =>
    bot.sendMessage(chatId, message, { parse_mode: 'MarkdownV2' })
      .then(() => console.log(`Successfully sent ${chain} message to chat ${chatId}`))
      .catch(err => console.error(`Failed to send ${chain} message to chat ${chatId}:`, err.message))
  );

  await Promise.all(sendPromises);
};

// Polling function
const monitorTransactions = async () => {
  const pollInterval = 30 * 1000; // 30 seconds

  const pollWithRetry = async (fn, chain) => {
    try {
      await pRetry(
        async () => {
          try {
            await fn();
          } catch (err) {
            console.error(`[${chain}] Polling error:`, err.message);
            throw err;
          }
        },
        {
          retries: 5,
          minTimeout: 2000,
          maxTimeout: 10000,
          factor: 2,
          onFailedAttempt: (error) => {
            console.log(`[${chain}] Retry attempt ${error.attemptNumber} failed: ${error.message}`);
          },
        }
      );
    } catch (err) {
      console.error(`[${chain}] Polling failed after retries: ${err.message}`);
    }
  };

  const pollChain = async (chain) => {
    try {
      console.log(`[${chain}] Checking for new transactions... (${new Date().toISOString()})`);
      const transactionsData = await fetchTransactions(chain);
      if (!transactionsData.length) {
        console.log(`[${chain}] No new transactions found.`);
        return;
      }

      const prices = await fetchPrices();
      const processPromises = transactionsData
        .filter(tx => tx.from.toLowerCase() === (chain === 'BSC' ? PETS_BSC_TARGET_ADDRESS : PETS_ETH_TARGET_ADDRESS).toLowerCase())
        .map(tx => processTransaction(tx, chain, prices));
      await Promise.all(processPromises);
    } catch (err) {
      console.error(`[${chain}] Polling failed: ${err.message}`);
    }
  };

  setInterval(() => pollWithRetry(() => pollChain('BSC'), 'BSC'), pollInterval);
  setInterval(() => pollWithRetry(() => pollChain('Ethereum'), 'Ethereum'), pollInterval);

  await pollWithRetry(() => pollChain('BSC'), 'BSC');
  await pollWithRetry(() => pollChain('Ethereum'), 'Ethereum');
};

// Start webhook and monitoring
const startBot = async () => {
  try {
    const webhookSuccess = await setWebhook();
    if (!webhookSuccess) {
      console.warn('Webhook setup failed. Falling back to polling.');
      bot.polling = true;
      await bot.startPolling({ restart: true });
    }
    await monitorTransactions();
  } catch (err) {
    console.error('Failed to start bot:', err);
    bot.polling = true;
    await bot.startPolling({ restart: true });
  }
};
startBot();

// API route for frontend
app.get('/api/transactions', (req, res) => {
  res.json(transactions.map(tx => ({
    ...tx,
    video: tx.video,
  })));
});

// Export for serverless handler
export default app;
