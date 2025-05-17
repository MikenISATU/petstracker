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
const BSCSCAN_API_KEY = process.env.INFURA_BSC_URL || 'https://bsc.nownodes.io/97a8bb57-9985-48b3-ad57-8054752cfcb5';
const ETHERSCAN_API_KEY = process.env.INFURA_ETH_URL || 'https://rpc.ankr.com/eth';
const CLOUDINARY_CLOUD_NAME = process.env.CLOUDINARY_CLOUD_NAME || 'da4k3yxhu';
const VERCEL_URL = process.env.VERCEL_URL || 'https://petstracker-8mqe0par9-miles-kenneth-napilan-isatus-projects.vercel.app';

// Validate environment variables
if (!TELEGRAM_BOT_TOKEN || !CLOUDINARY_CLOUD_NAME) {
  console.error('Missing critical environment variables: TELEGRAM_BOT_TOKEN or CLOUDINARY_CLOUD_NAME.');
  process.exit(1);
}
if (BSCSCAN_API_KEY === 'YOUR_BSCSCAN_API_KEY' || ETHERSCAN_API_KEY === 'YOUR_ETHERSCAN_API_KEY') {
  console.error('BSCSCAN_API_KEY or ETHERSCAN_API_KEY not set. Please provide valid API keys.');
  process.exit(1);
}
if (!VERCEL_URL.startsWith('https://')) {
  console.error('Invalid VERCEL_URL: Must start with https://');
  process.exit(1);
}

// Contract and target addresses (from bnbpets.py and ethpets.py)
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
let lastFetchTime = { BSC: 0, Ethereum: 0 };
const CACHE_DURATION = 5 * 60 * 1000; // 5 minutes

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
  video: `https://res.cloudinary.com/${CLOUDINARY_CLOUD_NAME}/video/upload/MEDIUMBUY_MPEG_e02zdz.mp4`,
  videoDisplay: '[Medium Buy Video]',
  timestamp: Date.now(),
  transactionHash: '0x' + Array.from({ length: 64 }, () => Math.floor(Math.random() * 16).toString(16)).join(''),
  tokenValue: chain === 'BSC' ? '$500.00' : '$1000.00',
  marketCap: '$10M',
  hodlerLast4: '5678',
});

// Fetch real-time prices from CoinGecko
const fetchPrices = async () => {
  try {
    const response = await axios.get('https://api.coingecko.com/api/v3/simple/price?ids=binancecoin,ethereum&vs_currencies=usd', {
      timeout: 15000,
      httpAgent,
    });
    return {
      bnbPrice: response.data.binancecoin.usd || 600,
      ethPrice: response.data.ethereum.usd || 2600,
    };
  } catch (error) {
    console.error('Error fetching prices:', error.message);
    return { bnbPrice: 600, ethPrice: 2600 };
  }
};

// Fetch transactions from BscScan/Etherscan
const fetchTransactions = async (chain) => {
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
        minTimeout: 5000,
        maxTimeout: 20000,
        factor: 2.5,
        onFailedAttempt: (error) => {
          console.error(`[${chain}] Fetch attempt ${error.attemptNumber} failed: ${error.message}`);
        },
      }
    );

    if (response.data.status === '1') {
      console.log(`[${chain}] Successfully fetched ${response.data.result.length} transactions.`);
      lastFetchTime[chain] = Date.now();
      return response.data.result.slice(0, 5);
    } else {
      console.error(`[${chain}] API Error: ${response.data.message} (Result: ${response.data.result})`);
      return [];
    }
  } catch (error) {
    console.error(`[${chain}] Error fetching transactions: ${error.message}`);
    return [];
  }
};

// Check if transaction is a DEX trade
const isDexTrade = async (txHash, chain) => {
  const url = chain === 'BSC'
    ? `https://bscscan.com/tx/${txHash}`
    : `https://etherscan.io/tx/${txHash}`;
  try {
    const response = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/58.0.3029.110 Safari/537.3',
      },
      timeout: 15000,
      httpAgent,
    });
    const $ = load(response.data);
    const executeBadge = $('*:contains("Execute")').length > 0 || $('*:contains("Unoswap2")').length > 0;
    return executeBadge;
  } catch (error) {
    console.error(`[${chain}] Error checking DEX trade for ${txHash}: ${error.message}`);
    return false;
  }
};

// Extract BNB/ETH value from transaction page
const extractTokenValue = async (txHash, chain) => {
  const url = chain === 'BSC'
    ? `https://bscscan.com/tx/${txHash}`
    : `https://etherscan.io/tx/${txHash}`;
  try {
    const response = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/58.0.3029.110 Safari/537.3',
      },
      timeout: 15000,
      httpAgent,
    });
    const $ = load(response.data);
    const valueSpans = $('[data-bs-toggle="tooltip"]');
    for (let i = 0; i < valueSpans.length; i++) {
      const valueText = $(valueSpans[i]).text().trim().replace(/,/g, '');
      if (/^\d+(\.\d+)?$/.test(valueText)) {
        return parseFloat(valueText);
      }
    }
    console.error(`[${chain}] No valid token value found for ${txHash}`);
    return null;
  } catch (error) {
    console.error(`[${chain}] Error extracting token value for ${txHash}: ${error.message}`);
    return null;
  }
};

// Get last 4 characters of holder address
const getHodlerLast4 = async (txHash, chain) => {
  const url = chain === 'BSC'
    ? `https://bscscan.com/tx/${txHash}`
    : `https://etherscan.io/tx/${txHash}`;
  try {
    const response = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/58.0.3029.110 Safari/537.3',
      },
      timeout: 15000,
      httpAgent,
    });
    const $ = load(response.data);
    const rows = $('.row.mb-4');
    for (let i = 0; i < rows.length; i++) {
      if ($(rows[i]).text().includes('From:')) {
        const fromAddress = $(rows[i]).find('a[href*="/address/"]').text().trim();
        return fromAddress.slice(-4);
      }
    }
    return 'N/A';
  } catch (error) {
    console.error(`[${chain}] Error extracting hodler address for ${txHash}: ${error.message}`);
    return 'N/A';
  }
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

// Video mapping
const categoryVideos = {
  'MicroPets Buy': 'SMALLBUY_b3px1p',
  'Medium Bullish Buy': 'MEDIUMBUY_MPEG_e02zdz',
  'Whale Buy': 'micropets_big_msapxz',
};

// Video display placeholders
const categoryVideoDisplays = {
  'MicroPets Buy': '[Small Buy Video]',
  'Medium Bullish Buy': '[Medium Buy Video]',
  'Whale Buy': '[Large Buy Video]',
};

// Get Cloudinary video URL
const getVideoUrl = (category) => {
  const publicId = categoryVideos[category] || 'default';
  return `https://res.cloudinary.com/${CLOUDINARY_CLOUD_NAME}/video/upload/${publicId}.mp4`;
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
        retries: 5,
        minTimeout: 2000,
        maxTimeout: 10000,
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
    await bot.sendVideo(chatId, videoUrl, {
      caption: message,
      parse_mode: 'MarkdownV2',
    });
    console.log(`Successfully sent /test video to chat ${chatId}`);
  } catch (err) {
    console.error(`Failed to send /test video to chat ${chatId}:`, err.message);
    try {
      await bot.sendMessage(chatId, message, { parse_mode: 'MarkdownV2' });
      console.log(`Successfully sent /test message to chat ${chatId}`);
    } catch (msgErr) {
      console.error(`Failed to send /test message to chat ${chatId}:`, msgErr.message);
    }
  }
});

// Process transaction
const processTransaction = async (tx, chain, prices) => {
  if (postedTransactions.has(tx.hash)) return;

  const isTrade = await isDexTrade(tx.hash, chain);
  if (!isTrade) return;

  const tokenValue = await extractTokenValue(tx.hash, chain);
  if (!tokenValue) return;

  const price = chain === 'BSC' ? prices.bnbPrice : prices.ethPrice;
  const usdValue = (tokenValue * price).toFixed(2);
  const tokens = (parseFloat(tx.value) / 1e18).toFixed(0);
  const category = categorizeBuy(tx.value);
  const videoUrl = getVideoUrl(category);
  const videoDisplay = categoryVideoDisplays[category] || '[Default Video]';
  const marketCap = await getMarketCap();
  const hodlerLast4 = await getHodlerLast4(tx.hash, chain);
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

  for (const chatId of activeChats) {
    const message = chain === 'BSC'
      ? `@MicroPetsBuy_bot\nMicroPets Buy - BNB Pair\n${escapeMarkdownV2(videoDisplay)}\n*💰 BNB Value*: ${escapeMarkdownV2(`$${usdValue}`)}\n*📊 Market Cap*: ${escapeMarkdownV2(marketCap)}\n*🧳 Holdings*: ${escapeMarkdownV2(tokens)} $PETS\n*👤 Holder*: ...${escapeMarkdownV2(hodlerLast4)}\n[BscScan](${scanUrl})\n\n📍 [Staking](https://pets.micropets.io/petdex) 📊 [Chart](https://www.dextools.io/app/en/bnb/pair-explorer/0x4bdece4e422fa015336234e4fc4d39ae6dd75b01) 🛍️ [Merch](https://micropets.store/) 💰 [Buy $PETS](https://pancakeswap.finance/swap?outputCurrency=${PETS_BSC_ADDRESS})`
      : `@MicroPetsBuy_bot\nMicroPets Buy - ETH Pair\n${escapeMarkdownV2(videoDisplay)}\n*💰 ETH Value*: ${escapeMarkdownV2(`$${usdValue}`)}\n*📊 Market Cap*: ${escapeMarkdownV2(marketCap)}\n*🧳 Holdings*: ${escapeMarkdownV2(tokens)} $PETS\n*👤 Holder*: ...${escapeMarkdownV2(hodlerLast4)}\n[Etherscan](${scanUrl})\n\n📍 [Staking](https://pets.micropets.io/petdex) 📊 [Chart](https://www.dextools.io/app/en/ether/pair-explorer/0x98b794be9c4f49900c6193aaff20876e1f36043e?t=1726815772329) 🛍️ [Merch](https://micropets.store/) 💰 [Buy $PETS](https://app.uniswap.org/swap?chain=mainnet&inputCurrency=NATIVE&outputCurrency=${PETS_ETH_ADDRESS})`;

    try {
      await bot.sendVideo(chatId, videoUrl, {
        caption: message,
        parse_mode: 'MarkdownV2',
      });
      console.log(`Successfully sent ${chain} video to chat ${chatId}`);
    } catch (err) {
      console.error(`Failed to send ${chain} video to chat ${chatId}:`, err.message);
      try {
        await bot.sendMessage(chatId, message, { parse_mode: 'MarkdownV2' });
        console.log(`Successfully sent ${chain} message to chat ${chatId}`);
      } catch (msgErr) {
        console.error(`Failed to send ${chain} message to chat ${chatId}:`, msgErr.message);
      }
    }
  }
};

// Polling function
const monitorTransactions = async () => {
  const pollInterval = 300 * 1000; // 5 minutes

  const pollWithRetry = async (fn, chain) => {
    return pRetry(
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
        minTimeout: 5000,
        maxTimeout: 30000,
        factor: 2.5,
        onFailedAttempt: (error) => {
          console.log(`[${chain}] Retry attempt ${error.attemptNumber} failed: ${error.message}`);
        },
      }
    );
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
      for (const tx of transactionsData) {
        if (tx.from.toLowerCase() !== (chain === 'BSC' ? PETS_BSC_TARGET_ADDRESS : PETS_ETH_TARGET_ADDRESS).toLowerCase()) {
          continue;
        }
        await processTransaction(tx, chain, prices);
      }
    } catch (err) {
      console.error(`[${chain}] Polling failed: ${err.message}`);
    }
  };

  setInterval(() => pollWithRetry(() => pollChain('BSC'), 'BSC').catch(err => console.error('BSC polling interval error:', err)), pollInterval);
  setInterval(() => pollWithRetry(() => pollChain('Ethereum'), 'Ethereum').catch(err => console.error('Ethereum polling interval error:', err)), pollInterval);

  await pollWithRetry(() => pollChain('BSC'), 'BSC').catch(err => console.error('Initial BSC poll failed:', err));
  await pollWithRetry(() => pollChain('Ethereum'), 'Ethereum').catch(err => console.error('Initial Ethereum poll failed:', err));
};

// Start webhook and monitoring
const startBot = async () => {
  try {
    const webhookSuccess = await setWebhook();
    if (!webhookSuccess) {
      console.warn('Webhook setup failed. Falling back to polling.');
      bot.polling = true; // Enable polling as fallback
      await bot.startPolling({ restart: true });
    }
    await monitorTransactions();
  } catch (err) {
    console.error('Failed to start bot:', err);
    process.exit(1);
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
