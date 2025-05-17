

import express from 'express';
import TelegramBot from 'node-telegram-bot-api';
import axios from 'axios';
import cheerio from 'cheerio';
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
if (!TELEGRAM_BOT_TOKEN || !BSCSCAN_API_KEY || !ETHERSCAN_API_KEY || !CLOUDINARY_CLOUD_NAME) {
  console.error('Missing critical environment variables. Please check configuration.');
  process.exit(1);
}

// Contract and target addresses (from bnbpets.py and ethpets.py)
const PETS_BSC_ADDRESS = '0x2466858ab5edad0bb597fe9f008f568b00d25fe3';
const PETS_BSC_TARGET_ADDRESS = '0x4BDECe4E422fA015336234e4FC4D39ae6dD75b01';
const PETS_ETH_ADDRESS = '0x2466858ab5edAd0BB597FE9f008F568B00d25Fe3';
const PETS_ETH_TARGET_ADDRESS = '0x98B794be9C4f49900C6193aAff20876E1F36043e';

// Configure HTTP keep-alive agent
const httpAgent = new Agent({
  keepAliveTimeout: 30000,
  keepAliveMaxTimeout: 60000,
});

// In-memory data
let transactions = [];
let activeChats = new Set();
let postedTransactions = new Set();

// Fetch real-time prices from CoinGecko (from get_bnb_to_usd/get_eth_to_usd)
const fetchPrices = async () => {
  try {
    const response = await axios.get('https://api.coingecko.com/api/v3/simple/price?ids=binancecoin,ethereum&vs_currencies=usd', {
      timeout: 10000,
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

// Fetch transactions from BscScan/Etherscan (from fetch_transactions)
const fetchTransactions = async (chain) => {
  const apiKey = chain === 'BSC' ? BSCSCAN_API_KEY : ETHERSCAN_API_KEY;
  const contractAddress = chain === 'BSC' ? PETS_BSC_ADDRESS : PETS_ETH_ADDRESS;
  const targetAddress = chain === 'BSC' ? PETS_BSC_TARGET_ADDRESS : PETS_ETH_TARGET_ADDRESS;
  const url = chain === 'BSC'
    ? `https://api.bscscan.com/api?module=account&action=tokentx&contractaddress=${contractAddress}&address=${targetAddress}&page=1&offset=50&sort=desc&apikey=${apiKey}`
    : `https://api.etherscan.io/api?module=account&action=tokentx&contractaddress=${contractAddress}&address=${targetAddress}&startblock=0&endblock=99999999&sort=desc&apikey=${apiKey}`;

  try {
    const response = await axios.get(url, { timeout: 10000, httpAgent });
    if (response.data.status === '1') {
      return response.data.result.slice(0, 20); // Limit to 20 most recent transactions
    } else {
      console.error(`[${chain}] API Error: ${response.data.message}`);
      return [];
    }
  } catch (error) {
    console.error(`[${chain}] Error fetching transactions: ${error.message}`);
    return [];
  }
};

// Check if transaction is a DEX trade (from check_execute_function)
const isDexTrade = async (txHash, chain) => {
  const url = chain === 'BSC'
    ? `https://bscscan.com/tx/${txHash}`
    : `https://etherscan.io/tx/${txHash}`;
  try {
    const response = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/58.0.3029.110 Safari/537.3',
      },
      timeout: 10000,
      httpAgent,
    });
    const $ = cheerio.load(response.data);
    const executeBadge = $('*:contains("Execute")').length > 0 || $('*:contains("Unoswap2")').length > 0;
    return executeBadge;
  } catch (error) {
    console.error(`[${chain}] Error checking DEX trade for ${txHash}: ${error.message}`);
    return false;
  }
};

// Extract BNB/ETH value from transaction page (from extract_bnb_value/extract_eth_value)
const extractTokenValue = async (txHash, chain) => {
  const url = chain === 'BSC'
    ? `https://bscscan.com/tx/${txHash}`
    : `https://etherscan.io/tx/${txHash}`;
  try {
    const response = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/58.0.3029.110 Safari/537.3',
      },
      timeout: 10000,
      httpAgent,
    });
    const $ = cheerio.load(response.data);
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

// Get last 4 characters of holder address (from get_hodler_last_4)
const getHodlerLast4 = async (txHash, chain) => {
  const url = chain === 'BSC'
    ? `https://bscscan.com/tx/${txHash}`
    : `https://etherscan.io/tx/${txHash}`;
  try {
    const response = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/58.0.3029.110 Safari/537.3',
      },
      timeout: 10000,
      httpAgent,
    });
    const $ = cheerio.load(response.data);
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

// Calculate Market Cap (placeholder, as in ethpets.py)
const getMarketCap = async (chain) => {
  return '$10M'; // Placeholder due to unreliable scraping
};

// Categorize buy amounts (from categorizeBuy in original)
const categorizeBuy = (amount) => {
  const tokens = parseFloat(amount) / 1e18;
  if (tokens < 1000) return 'MicroPets Buy';
  if (tokens < 10000) return 'Medium Bullish Buy';
  return 'Whale Buy';
};

// Video mapping (from original)
const categoryVideos = {
  'MicroPets Buy': 'SMALLBUY_b3px1p',
  'Medium Bullish Buy': 'MEDIUMBUY_MPEG_e02zdz',
  'Whale Buy': 'micropets_big_msapxz',
};

// Video display placeholders (from original)
const categoryVideoDisplays = {
  'MicroPets Buy': '[Small Buy Video]',
  'Medium Bullish Buy': '[Medium Buy Video]',
  'Whale Buy': '[Large Buy Video]',
};

// Get Cloudinary video URL (from original)
const getVideoUrl = (category) => {
  const publicId = categoryVideos[category] || 'default';
  return `https://res.cloudinary.com/${CLOUDINARY_CLOUD_NAME}/video/upload/${publicId}.mp4`;
};

// Initialize Telegram Bot (from original)
const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });
console.warn('Polling enabled as fallback. Set webhook for production:');
console.log(`curl -X GET "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook?url=${VERCEL_URL}/api/bot"`);

// Telegram webhook route (from original)
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

// Telegram commands (from original, adapted)
bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  activeChats.add(chatId);
  bot.sendMessage(chatId, '👋 Welcome to PETS Tracker! Use /track to start receiving buy alerts.')
    .catch(err => console.error(`Failed to send /start message to ${chatId}:`, err));
});

bot.onText(/\/track/, (msg) => {
  const chatId = msg.chat.id;
  activeChats.add(chatId);
  bot.sendMessage(chatId, '📈 Started tracking PETS buys. You’ll get notified on new buys for BNB and ETH pairs.')
    .catch(err => console.error(`Failed to send /track message to ${chatId}:`, err));
});

bot.onText(/\/stop/, (msg) => {
  const chatId = msg.chat.id;
  activeChats.delete(chatId);
  bot.sendMessage(chatId, '🛑 Stopped tracking PETS buys.')
    .catch(err => console.error(`Failed to send /stop message to ${chatId}:`, err));
});

bot.onText(/\/stats/, async (msg) => {
  const chatId = msg.chat?.id;
  if (!chatId) return;
  let bscMessage = 'BNB Pair: No transactions recorded yet.';
  let ethMessage = 'ETH Pair: No transactions recorded yet.';

  const bscTxs = transactions.filter(tx => tx.chain === 'BSC').sort((a, b) => b.timestamp - a.timestamp);
  if (bscTxs.length > 0) {
    const tx = bscTxs[0];
    const bscScanUrl = `https://bscscan.com/tx/${tx.transactionHash}`;
    bscMessage = `@MicroPetsBuy_bot\nMicroPets Buy - BNB Pair\n${tx.videoDisplay}\n**💰 BNB Value**: ${tx.tokenValue}\n**📊 Market Cap**: ${tx.marketCap}\n**🧳 Holdings**: ${tx.amount} $PETS\n**👤 Holder**: ...${tx.hodlerLast4}\n[BscScan](${bscScanUrl})\n\n📍 [Staking](https://pets.micropets.io/petdex)  📊 [Chart](https://www.dextools.io/app/en/bnb/pair-explorer/0x4bdece4e422fa015336234e4fc4d39ae6dd75b01)  🛍️ [Merch](https://micropets.store/)  💰 [Buy $PETS](https://pancakeswap.finance/swap?outputCurrency=${PETS_BSC_ADDRESS})`;
  }

  const ethTxs = transactions.filter(tx => tx.chain === 'Ethereum').sort((a, b) => b.timestamp - a.timestamp);
  if (ethTxs.length > 0) {
    const tx = ethTxs[0];
    const etherscanUrl = `https://etherscan.io/tx/${tx.transactionHash}`;
    ethMessage = `@MicroPetsBuy_bot\nMicroPets Buy - ETH Pair\n${tx.videoDisplay}\n**💰 ETH Value**: ${tx.tokenValue}\n**📊 Market Cap**: ${tx.marketCap}\n**🧳 Holdings**: ${tx.amount} $PETS\n**👤 Holder**: ...${tx.hodlerLast4}\n[Etherscan](${etherscanUrl})\n\n📍 [Staking](https://pets.micropets.io/petdex)  📊 [Chart](https://www.dextools.io/app/en/ether/pair-explorer/0x98b794be9c4f49900c6193aaff20876e1f36043e?t=1726815772329)  🛍️ [Merch](https://micropets.store/)  💰 [Buy $PETS](https://app.uniswap.org/swap?chain=mainnet&inputCurrency=NATIVE&outputCurrency=${PETS_ETH_ADDRESS})`;
  }

  const message = `📊 *Latest $PETS Transactions:*\n\n${bscMessage}\n\n${ethMessage}`;
  await bot.sendMessage(chatId, message, { parse_mode: 'Markdown' })
    .catch(err => console.error(`Failed to send /stats message to ${chatId}:`, err));
});

bot.onText(/\/help/, (msg) => {
  const chatId = msg.chat.id;
  bot.sendMessage(chatId, '🆘 *Available commands:*\n/start - Start the bot\n/track - Enable buy alerts\n/stop - Disable buy alerts\n/stats - View latest buy from BSC and Ethereum\n/status - Check tracking status\n/test - Show a sample buy template\n/help - Show this message', { parse_mode: 'Markdown' })
    .catch(err => console.error(`Failed to send /help message to ${chatId}:`, err));
});

bot.onText(/\/status/, (msg) => {
  const chatId = msg.chat.id;
  const isTracking = activeChats.has(chatId);
  bot.sendMessage(chatId, `🔍 *Status:* ${isTracking ? 'Tracking enabled' : 'Tracking disabled'}\n*Total tracked transactions:* ${transactions.length}`, { parse_mode: 'Markdown' })
    .catch(err => console.error(`Failed to send /status message to ${chatId}:`, err));
});

bot.onText(/\/test/, async (msg) => {
  const chatId = msg.chat.id;
  const categories = ['MicroPets Buy', 'Medium Bullish Buy', 'Whale Buy'];
  const category = categories[Math.floor(Math.random() * categories.length)];
  const videoDisplay = categoryVideoDisplays[category] || '[Default Video]';
  const videoUrl = getVideoUrl(category);
  const randomTxHash = '0x' + Array.from({ length: 64 }, () => Math.floor(Math.random() * 16).toString(16)).join('');
  const toAddress = '0x1234567890abcdef1234567890abcdef12345678';
  const hodlerLast4 = '5678';
  const tokens = category === 'MicroPets Buy' ? '500' : category === 'Medium Bullish Buy' ? '5000' : '15000';
  const chain = Math.random() > 0.5 ? 'BSC' : 'Ethereum';
  const tokenValue = chain === 'BSC' ? '$500.00' : '$1000.00';
  const marketCap = '$10M';
  const scanUrl = chain === 'BSC' ? `https://bscscan.com/tx/${randomTxHash}` : `https://etherscan.io/tx/${randomTxHash}`;
  const message = chain === 'BSC'
    ? `@MicroPetsBuy_bot\nMicroPets Buy - BNB Pair\n${videoDisplay}\n**💰 BNB Value**: ${tokenValue}\n**📊 Market Cap**: ${marketCap}\n**🧳 Holdings**: ${tokens} $PETS\n**👤 Holder**: ...${hodlerLast4}\n[BscScan](${scanUrl})\n\n📍 [Staking](https://pets.micropets.io/petdex)  📊 [Chart](https://www.dextools.io/app/en/bnb/pair-explorer/0x4bdece4e422fa015336234e4fc4d39ae6dd75b01)  🛍️ [Merch](https://micropets.store/)  💰 [Buy $PETS](https://pancakeswap.finance/swap?outputCurrency=${PETS_BSC_ADDRESS})`
    : `@MicroPetsBuy_bot\nMicroPets Buy - ETH Pair\n${videoDisplay}\n**💰 ETH Value**: ${tokenValue}\n**📊 Market Cap**: ${marketCap}\n**🧳 Holdings**: ${tokens} $PETS\n**👤 Holder**: ...${hodlerLast4}\n[Etherscan](${scanUrl})\n\n📍 [Staking](https://pets.micropets.io/petdex)  📊 [Chart](https://www.dextools.io/app/en/ether/pair-explorer/0x98b794be9c4f49900c6193aaff20876e1f36043e?t=1726815772329)  🛍️ [Merch](https://micropets.store/)  💰 [Buy $PETS](https://app.uniswap.org/swap?chain=mainnet&inputCurrency=NATIVE&outputCurrency=${PETS_ETH_ADDRESS})`;

  try {
    await bot.sendVideo(chatId, videoUrl, {
      caption: message,
      parse_mode: 'Markdown',
    });
    console.log(`Successfully sent /test video to chat ${chatId}`);
  } catch (err) {
    console.error(`Failed to send /test video to chat ${chatId}:`, err.message);
    await bot.sendMessage(chatId, `${message}\n\n⚠️ Video unavailable, please check bot configuration.`, {
      parse_mode: 'Markdown',
    });
  }
});

// Process transaction (adapted from process_transaction)
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
  const marketCap = await getMarketCap(chain);
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
      ? `@MicroPetsBuy_bot\nMicroPets Buy - BNB Pair\n${videoDisplay}\n**💰 BNB Value**: $${usdValue}\n**📊 Market Cap**: ${marketCap}\n**🧳 Holdings**: ${tokens} $PETS\n**👤 Holder**: ...${hodlerLast4}\n[BscScan](${scanUrl})\n\n📍 [Staking](https://pets.micropets.io/petdex)  📊 [Chart](https://www.dextools.io/app/en/bnb/pair-explorer/0x4bdece4e422fa015336234e4fc4d39ae6dd75b01)  🛍️ [Merch](https://micropets.store/)  💰 [Buy $PETS](https://pancakeswap.finance/swap?outputCurrency=${PETS_BSC_ADDRESS})`
      : `@MicroPetsBuy_bot\nMicroPets Buy - ETH Pair\n${videoDisplay}\n**💰 ETH Value**: $${usdValue}\n**📊 Market Cap**: ${marketCap}\n**🧳 Holdings**: ${tokens} $PETS\n**👤 Holder**: ...${hodlerLast4}\n[Etherscan](${scanUrl})\n\n📍 [Staking](https://pets.micropets.io/petdex)  📊 [Chart](https://www.dextools.io/app/en/ether/pair-explorer/0x98b794be9c4f49900c6193aaff20876e1f36043e?t=1726815772329)  🛍️ [Merch](https://micropets.store/)  💰 [Buy $PETS](https://app.uniswap.org/swap?chain=mainnet&inputCurrency=NATIVE&outputCurrency=${PETS_ETH_ADDRESS})`;

    try {
      await bot.sendVideo(chatId, videoUrl, {
        caption: message,
        parse_mode: 'Markdown',
      });
      console.log(`Successfully sent ${chain} video to chat ${chatId}`);
    } catch (err) {
      console.error(`Failed to send ${chain} video to chat ${chatId}:`, err.message);
      await bot.sendMessage(chatId, `${message}\n\n⚠️ Video unavailable, please check bot configuration.`, {
        parse_mode: 'Markdown',
      });
    }
  }
};

// Polling function (from monitor_transactions)
const monitorTransactions = async () => {
  const pollInterval = 60 * 1000; // 60 seconds, as in Python scripts

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
        retries: 3,
        minTimeout: 2000,
        maxTimeout: 16000,
        factor: 2,
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

// Start monitoring
try {
  monitorTransactions();
} catch (err) {
  console.error('Failed to start transaction monitoring:', err);
  process.exit(1);
}

// API route for frontend (from original)
app.get('/api/transactions', (req, res) => {
  res.json(transactions.map(tx => ({
    ...tx,
    video: tx.video,
  })));
});

// Export for serverless handler
export default app;
