import express from 'express';
import TelegramBot from 'node-telegram-bot-api';
import Web3 from 'web3';
import pRetry from 'p-retry';
import { Agent } from 'undici';
import axios from 'axios';

console.log('Web3 import:', Web3);

const app = express();
app.use(express.json());

// Load environment variables safely
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '7347310243:AAGYxgwO4jMaZVkZsCPxrUN9X_GE2emq73Y';
const INFURA_BSC_URL = process.env.INFURA_BSC_URL || 'https://bsc.nownodes.io/97a8bb57-9985-48b3-ad57-8054752cfcb5';
const INFURA_ETH_URL = process.env.INFURA_ETH_URL || 'https://rpc.ankr.com/eth';
const CLOUDINARY_CLOUD_NAME = process.env.CLOUDINARY_CLOUD_NAME || 'da4k3yxhu';
const VERCEL_URL = process.env.VERCEL_URL || 'https://petstracker-8mqe0par9-miles-kenneth-napilan-isatus-projects.vercel.app';

// Validate environment variables
if (!TELEGRAM_BOT_TOKEN || !INFURA_BSC_URL || !INFURA_ETH_URL || !CLOUDINARY_CLOUD_NAME) {
  console.error('Missing critical environment variables. Please check configuration.');
  process.exit(1);
}

// Contract addresses
const PETS_BSC_ADDRESS = '0x4bdece4e422fa015336234e4fc4d39ae6dd75b01';
const PETS_ETH_ADDRESS = '0x98b794be9c4f49900c6193aaff20876e1f36043e';

// DEX router addresses
const PANCAKESWAP_ROUTER = '0x10ED43C718714eb63d5aA57B78B54704E256024E';
const UNISWAP_ROUTER = '0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D';

// Configure HTTP keep-alive agent
const httpAgent = new Agent({
  keepAliveTimeout: 30000,
  keepAliveMaxTimeout: 60000,
});

// Initialize Web3 providers
let bscWeb3, ethWeb3;
try {
  bscWeb3 = new Web3(new Web3.providers.HttpProvider(INFURA_BSC_URL, {
    agent: { http: httpAgent },
    timeout: 30000,
  }));
  console.log('bscWeb3 initialized:', !!bscWeb3);
} catch (err) {
  console.error('Failed to initialize bscWeb3:', err);
  process.exit(1);
}

try {
  ethWeb3 = new Web3(new Web3.providers.HttpProvider(INFURA_ETH_URL, {
    agent: { http: httpAgent },
    timeout: 30000,
  }));
  console.log('ethWeb3 initialized:', !!ethWeb3);
} catch (err) {
  console.error('Failed to initialize ethWeb3:', err);
  process.exit(1);
}

// ERC-20 ABI (extended for totalSupply)
const ERC20_ABI = [
  {
    anonymous: false,
    inputs: [
      { indexed: true, name: 'from', type: 'address' },
      { indexed: true, name: 'to', type: 'address' },
      { indexed: false, name: 'value', type: 'uint256' }
    ],
    name: 'Transfer',
    type: 'event'
  },
  {
    constant: true,
    inputs: [],
    name: 'totalSupply',
    outputs: [{ name: '', type: 'uint256' }],
    type: 'function'
  }
];

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

// Fetch real-time prices from CoinGecko
const fetchPrices = async () => {
  try {
    const response = await axios.get('https://api.coingecko.com/api/v3/simple/price?ids=binancecoin,ethereum&vs_currencies=usd');
    return {
      bnbPrice: response.data.binancecoin.usd || 600, // Fallback to $600 if API fails
      ethPrice: response.data.ethereum.usd || 2600 // Fallback to $2600 if API fails
    };
  } catch (error) {
    console.error('Error fetching prices:', error.message);
    return { bnbPrice: 600, ethPrice: 2600 }; // Default fallback prices
  }
};

// Calculate value in USD based on BNB or ETH spent
const getTokenValue = async (amountInPETS, chain) => {
  const web3 = chain === 'BSC' ? bscWeb3 : ethWeb3;
  if (!web3) return '$0.00';
  const tokens = web3.utils.fromWei(amountInPETS, 'ether');
  const { bnbPrice, ethPrice } = await fetchPrices();
  const pricePerPETS = chain === 'BSC' ? 0.0001 : 0.00001; // Placeholder PETS price in BNB or ETH
  const tokenAmount = parseFloat(tokens) * pricePerPETS; // Amount in BNB or ETH
  const usdPrice = chain === 'BSC' ? bnbPrice : ethPrice;
  const usdValue = (tokenAmount * usdPrice).toFixed(2);
  return `$${usdValue}`;
};

// Calculate Market Cap (still in USD for consistency)
const getMarketCap = async (chain) => {
  try {
    const contract = chain === 'BSC' ? bscContract : ethContract;
    const web3 = chain === 'BSC' ? bscWeb3 : ethWeb3;
    const totalSupply = await contract.methods.totalSupply().call();
    const tokens = web3.utils.fromWei(totalSupply, 'ether');
    const { bnbPrice, ethPrice } = await fetchPrices();
    const pricePerPETS = 0.01; // Placeholder; replace with real price feed if available
    const marketCap = (parseFloat(tokens) * pricePerPETS).toFixed(2);
    return `$${marketCap}`;
  } catch (err) {
    console.error(`Error calculating market cap for ${chain}:`, err.message);
    return '$10M';
  }
};

// Categorize buy amounts
const categorizeBuy = (amount, web3) => {
  if (!web3) return 'Unknown Buy';
  const tokens = web3.utils.fromWei(amount, 'ether');
  if (tokens < 1000) return 'MicroPets Buy';
  if (tokens < 10000) return 'Medium Bullish Buy';
  return 'Whale Buy';
};

// Video mapping (Cloudinary public IDs)
const categoryVideos = {
  'MicroPets Buy': 'SMALLBUY_b3px1p',
  'Medium Bullish Buy': 'MEDIUMBUY_MPEG_e02zdz',
  'Whale Buy': 'micropets_big_msapxz'
};

// Video display placeholders
const categoryVideoDisplays = {
  'MicroPets Buy': '[Small Buy Video]',
  'Medium Bullish Buy': '[Medium Buy Video]',
  'Whale Buy': '[Large Buy Video]'
};

// Get Cloudinary video URL
const getVideoUrl = (category) => {
  const publicId = categoryVideos[category] || 'default';
  return `https://res.cloudinary.com/${CLOUDINARY_CLOUD_NAME}/video/upload/${publicId}.mp4`;
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
const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });
console.warn('Polling enabled as fallback. Set webhook for production:');
console.log(`curl -X GET "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook?url=${VERCEL_URL}/api/bot"`);

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
  console.log(`Processing /start for chat ${chatId}`);
  activeChats.add(chatId);
  bot.sendMessage(chatId, '👋 Welcome to PETS Tracker! Use /track to start receiving buy alerts.')
    .catch(err => console.error(`Failed to send /start message to ${chatId}:`, err));
});

bot.onText(/\/track/, (msg) => {
  const chatId = msg.chat.id;
  console.log(`Processing /track for chat ${chatId}`);
  activeChats.add(chatId);
  bot.sendMessage(chatId, '📈 Started tracking PETS buys. You’ll get notified on new buys for BNB and ETH pairs.')
    .catch(err => console.error(`Failed to send /track message to ${chatId}:`, err));
});

bot.onText(/\/stop/, (msg) => {
  const chatId = msg.chat.id;
  console.log(`Processing /stop for chat ${chatId}`);
  activeChats.delete(chatId);
  bot.sendMessage(chatId, '🛑 Stopped tracking PETS buys.')
    .catch(err => console.error(`Failed to send /stop message to ${chatId}:`, err));
});

bot.onText(/\/stats/, async (msg) => {
  const chatId = msg.chat?.id;
  if (!chatId) {
    console.error('Invalid message object in /stats:', msg);
    return;
  }
  console.log(`Processing /stats for chat ${chatId}`);
  let bscMessage = 'BNB Pair: No transactions recorded yet.';
  let ethMessage = 'ETH Pair: No transactions recorded yet.';

  try {
    const latestBscBlock = await bscWeb3.eth.getBlockNumber();
    const events = await bscContract.getPastEvents('Transfer', {
      fromBlock: 0,
      toBlock: Number(latestBscBlock)
    });
    const lastEvent = events.sort((a, b) => Number(b.blockNumber - a.blockNumber))[0];
    if (lastEvent) {
      const { returnValues, transactionHash } = lastEvent;
      const { to, value } = returnValues;
      const isPairTrade = await isDexTrade(transactionHash, 'BSC');
      const category = categorizeBuy(value, bscWeb3);
      const videoDisplay = categoryVideoDisplays[category] || '[Default Video]';
      const tokenValue = await getTokenValue(value, 'BSC');
      const marketCap = await getMarketCap('BSC');
      const tokens = bscWeb3.utils.fromWei(value, 'ether');
      const bscScanUrl = `https://bscscan.com/tx/${transactionHash}`;
      bscMessage = `@MicroPetsBuy_bot\nMicroPets Buy - BNB Pair\n${videoDisplay}\n**💰 BNB Value**: ${tokenValue}\n**📊 Market Cap**: ${marketCap}\n**🧳 Holdings**: ${tokens} $PETS\n**👤 Holder Address**: ${to}\n[BscScan](${bscScanUrl})\n\n📍 [Staking](https://pets.micropets.io/petdex)  📊 [Chart](https://www.dextools.io/app/en/bnb/pair-explorer/0x4bdece4e422fa015336234e4fc4d39ae6dd75b01)  🛍️ [Merch](https://micropets.store/)  💰 [Buy $PETS](https://pancakeswap.finance/swap?outputCurrency=0x4bdece4e422fa015336234e4fc4d39ae6dd75b01)`;
    }
  } catch (err) {
    console.error(`Error fetching BSC stats:`, err.message);
    bscMessage = 'BNB Pair: Error fetching latest transaction.';
  }

  try {
    const latestEthBlock = await ethWeb3.eth.getBlockNumber();
    const events = await ethContract.getPastEvents('Transfer', {
      fromBlock: 0,
      toBlock: Number(latestEthBlock)
    });
    const lastEvent = events.sort((a, b) => Number(b.blockNumber - a.blockNumber))[0];
    if (lastEvent) {
      const { returnValues, transactionHash } = lastEvent;
      const { to, value } = returnValues;
      const isPairTrade = await isDexTrade(transactionHash, 'Ethereum');
      const category = categorizeBuy(value, ethWeb3);
      const videoDisplay = categoryVideoDisplays[category] || '[Default Video]';
      const tokenValue = await getTokenValue(value, 'Ethereum');
      const marketCap = await getMarketCap('Ethereum');
      const tokens = ethWeb3.utils.fromWei(value, 'ether');
      const etherscanUrl = `https://etherscan.io/tx/${transactionHash}`;
      ethMessage = `@MicroPetsBuy_bot\nMicroPets Buy - ETH Pair\n${videoDisplay}\n**💰 ETH Value**: ${tokenValue}\n**📊 Market Cap**: ${marketCap}\n**🧳 Holdings**: ${tokens} $PETS\n**👤 Holder Address**: ${to}\n[Etherscan](${etherscanUrl})\n\n📍 [Staking](https://pets.micropets.io/petdex)  📊 [Chart](https://www.dextools.io/app/en/ether/pair-explorer/0x98b794be9c4f49900c6193aaff20876e1f36043e?t=1726815772329)  🛍️ [Merch](https://micropets.store/)  💰 [Buy $PETS](https://app.uniswap.org/swap?chain=mainnet&inputCurrency=NATIVE&outputCurrency=0x98b794be9c4f49900c6193aaff20876e1f36043e)`;
    }
  } catch (err) {
    console.error(`Error fetching Ethereum stats:`, err.message);
    ethMessage = 'ETH Pair: Error fetching latest transaction.';
  }

  const message = `📊 *Latest $PETS Transactions:*\n\n${bscMessage}\n\n${ethMessage}`;
  await bot.sendMessage(chatId, message, { parse_mode: 'Markdown' })
    .catch(err => console.error(`Failed to send /stats message to ${chatId}:`, err));
});

bot.onText(/\/help/, (msg) => {
  const chatId = msg.chat.id;
  console.log(`Processing /help for chat ${chatId}`);
  bot.sendMessage(chatId, '🆘 *Available commands:*\n/start - Start the bot\n/track - Enable buy alerts\n/stop - Disable buy alerts\n/stats - View latest buy from BSC and Ethereum\n/status - Check tracking status\n/test - Show a sample buy template\n/help - Show this message', { parse_mode: 'Markdown' })
    .catch(err => console.error(`Failed to send /help message to ${chatId}:`, err));
});

bot.onText(/\/status/, (msg) => {
  const chatId = msg.chat.id;
  console.log(`Processing /status for chat ${chatId}`);
  const isTracking = activeChats.has(chatId);
  bot.sendMessage(chatId, `🔍 *Status:* ${isTracking ? 'Tracking enabled' : 'Tracking disabled'}\n*Total tracked transactions:* ${transactions.length}`, { parse_mode: 'Markdown' })
    .catch(err => console.error(`Failed to send /status message to ${chatId}:`, err));
});

bot.onText(/\/test/, async (msg) => {
  const chatId = msg.chat.id;
  console.log(`Processing /test for chat ${chatId}`);
  const categories = ['MicroPets Buy', 'Medium Bullish Buy', 'Whale Buy'];
  const category = categories[Math.floor(Math.random() * categories.length)];
  const videoDisplay = categoryVideoDisplays[category] || '[Default Video]';
  const videoUrl = getVideoUrl(category);
  const randomTxHash = '0x' + Array.from({length: 64}, () => Math.floor(Math.random() * 16).toString(16)).join('');
  const toAddress = '0x1234567890abcdef1234567890abcdef12345678';
  const tokens = category === 'MicroPets Buy' ? '500' : category === 'Medium Bullish Buy' ? '5000' : '15000';
  const chain = Math.random() > 0.5 ? 'BSC' : 'Ethereum';
  const web3 = chain === 'BSC' ? bscWeb3 : ethWeb3;
  const tokenValue = await getTokenValue(web3.utils.toWei(tokens, 'ether'), chain);
  const marketCap = await getMarketCap(chain);
  const scanUrl = chain === 'BSC' ? `https://bscscan.com/tx/${randomTxHash}` : `https://etherscan.io/tx/${randomTxHash}`;
  const message = chain === 'BSC'
    ? `@MicroPetsBuy_bot\nMicroPets Buy - BNB Pair\n${videoDisplay}\n**💰 BNB Value**: ${tokenValue}\n**📊 Market Cap**: ${marketCap}\n**🧳 Holdings**: ${tokens} $PETS\n**👤 Holder Address**: ${toAddress}\n[BscScan](${scanUrl})\n\n📍 [Staking](https://pets.micropets.io/petdex)  📊 [Chart](https://www.dextools.io/app/en/bnb/pair-explorer/0x4bdece4e422fa015336234e4fc4d39ae6dd75b01)  🛍️ [Merch](https://micropets.store/)  💰 [Buy $PETS](https://pancakeswap.finance/swap?outputCurrency=0x4bdece4e422fa015336234e4fc4d39ae6dd75b01)`
    : `@MicroPetsBuy_bot\nMicroPets Buy - ETH Pair\n${videoDisplay}\n**💰 ETH Value**: ${tokenValue}\n**📊 Market Cap**: ${marketCap}\n**🧳 Holdings**: ${tokens} $PETS\n**👤 Holder Address**: ${toAddress}\n[Etherscan](${scanUrl})\n\n📍 [Staking](https://pets.micropets.io/petdex)  📊 [Chart](https://www.dextools.io/app/en/ether/pair-explorer/0x98b794be9c4f49900c6193aaff20876e1f36043e?t=1726815772329)  🛍️ [Merch](https://micropets.store/)  💰 [Buy $PETS](https://app.uniswap.org/swap?chain=mainnet&inputCurrency=NATIVE&outputCurrency=0x98b794be9c4f49900c6193aaff20876e1f36043e)`;

  console.log(`Attempting to send video to chat ${chatId} with URL: ${videoUrl}`);

  try {
    await bot.sendVideo(chatId, videoUrl, {
      caption: message,
      parse_mode: 'Markdown'
    });
    console.log(`Successfully sent /test video to chat ${chatId}`);
  } catch (err) {
    console.error(`Failed to send /test video to chat ${chatId}:`, err.message);
    try {
      await bot.sendMessage(chatId, `${message}\n\n⚠️ Video unavailable, please check bot configuration.`, {
        parse_mode: 'Markdown'
      });
      console.log(`Sent fallback text message to chat ${chatId}`);
    } catch (textErr) {
      console.error(`Failed to send fallback text message to chat ${chatId}:`, textErr.message);
    }
  }
});

// Polling function
const monitorTransactions = async () => {
  const pollInterval = 90 * 1000;
  const maxBlocksPerPoll = 3;

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
        maxTimeout: 60000,
        factor: 2,
        onFailedAttempt: (error) => {
          console.log(`[${chain}] Retry attempt ${error.attemptNumber} failed: ${error.message}`);
        },
      }
    );
  };

  const pollBsc = async () => {
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
        const category = categorizeBuy(value, bscWeb3);
        const videoDisplay = categoryVideoDisplays[category] || '[Default Video]';
        const videoUrl = getVideoUrl(category);
        const tokenValue = await getTokenValue(value, 'BSC');
        const marketCap = await getMarketCap('BSC');
        const tokens = bscWeb3.utils.fromWei(value, 'ether');
        const bscScanUrl = `https://bscscan.com/tx/${transactionHash}`;
        const tx = {
          chain: 'BSC',
          to,
          amount: tokens,
          category,
          video: videoUrl,
          videoDisplay,
          timestamp: Date.now(),
          isPairTrade,
          transactionHash
        };

        if (!transactions.some(t => t.transactionHash === tx.transactionHash)) {
          transactions.push(tx);
          if (transactions.length > 100) transactions.shift();

          for (const chatId of activeChats) {
            console.log(`Attempting to send BSC video to chat ${chatId} with URL: ${videoUrl}`);
            const message = `@MicroPetsBuy_bot\nMicroPets Buy - BNB Pair\n${videoDisplay}\n**💰 BNB Value**: ${tokenValue}\n**📊 Market Cap**: ${marketCap}\n**🧳 Holdings**: ${tokens} $PETS\n**👤 Holder Address**: ${to}\n[BscScan](${bscScanUrl})\n\n📍 [Staking](https://pets.micropets.io/petdex)  📊 [Chart](https://www.dextools.io/app/en/bnb/pair-explorer/0x4bdece4e422fa015336234e4fc4d39ae6dd75b01)  🛍️ [Merch](https://micropets.store/)  💰 [Buy $PETS](https://pancakeswap.finance/swap?outputCurrency=0x4bdece4e422fa015336234e4fc4d39ae6dd75b01)`;

            try {
              await bot.sendVideo(chatId, videoUrl, {
                caption: message,
                parse_mode: 'Markdown'
              });
              console.log(`Successfully sent BSC video to chat ${chatId}`);
            } catch (err) {
              console.error(`Failed to send BSC video to chat ${chatId}:`, err.message);
              try {
                await bot.sendMessage(chatId, `${message}\n\n⚠️ Video unavailable, please check bot configuration.`, {
                  parse_mode: 'Markdown'
                });
                console.log(`Sent fallback text message to chat ${chatId} for BSC`);
              } catch (textErr) {
                console.error(`Failed to send fallback text message to chat ${chatId} for BSC:`, textErr.message);
              }
            }
          }
        }
      }

      lastBscBlock = toBlock + BigInt(1);
    } catch (err) {
      throw new Error(`BSC polling failed: ${err.message}`);
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
        const category = categorizeBuy(value, ethWeb3);
        const videoDisplay = categoryVideoDisplays[category] || '[Default Video]';
        const videoUrl = getVideoUrl(category);
        const tokenValue = await getTokenValue(value, 'Ethereum');
        const marketCap = await getMarketCap('Ethereum');
        const tokens = ethWeb3.utils.fromWei(value, 'ether');
        const etherscanUrl = `https://etherscan.io/tx/${transactionHash}`;
        const tx = {
          chain: 'Ethereum',
          to,
          amount: tokens,
          category,
          video: videoUrl,
          videoDisplay,
          timestamp: Date.now(),
          isPairTrade,
          transactionHash
        };

        if (!transactions.some(t => t.transactionHash === tx.transactionHash)) {
          transactions.push(tx);
          if (transactions.length > 100) transactions.shift();

          for (const chatId of activeChats) {
            console.log(`Attempting to send ETH video to chat ${chatId} with URL: ${videoUrl}`);
            const message = `@MicroPetsBuy_bot\nMicroPets Buy - ETH Pair\n${videoDisplay}\n**💰 ETH Value**: ${tokenValue}\n**📊 Market Cap**: ${marketCap}\n**🧳 Holdings**: ${tokens} $PETS\n**👤 Holder Address**: ${to}\n[Etherscan](${etherscanUrl})\n\n📍 [Staking](https://pets.micropets.io/petdex)  📊 [Chart](https://www.dextools.io/app/en/ether/pair-explorer/0x98b794be9c4f49900c6193aaff20876e1f36043e?t=1726815772329)  🛍️ [Merch](https://micropets.store/)  💰 [Buy $PETS](https://app.uniswap.org/swap?chain=mainnet&inputCurrency=NATIVE&outputCurrency=0x98b794be9c4f49900c6193aaff20876e1f36043e)`;

            try {
              await bot.sendVideo(chatId, videoUrl, {
                caption: message,
                parse_mode: 'Markdown'
              });
              console.log(`Successfully sent ETH video to chat ${chatId}`);
            } catch (err) {
              console.error(`Failed to send ETH video to chat ${chatId}:`, err.message);
              try {
                await bot.sendMessage(chatId, `${message}\n\n⚠️ Video unavailable, please check bot configuration.`, {
                  parse_mode: 'Markdown'
                });
                console.log(`Sent fallback text message to chat ${chatId} for ETH`);
              } catch (textErr) {
                console.error(`Failed to send fallback text message to chat ${chatId} for ETH:`, textErr.message);
              }
            }
          }
        }
      }

      lastEthBlock = toBlock + BigInt(1);
    } catch (err) {
      throw new Error(`Ethereum polling failed: ${err.message}`);
    }
  };

  setInterval(() => pollWithRetry(pollBsc, 'BSC').catch(err => console.error('BSC polling interval error:', err)), pollInterval);
  setInterval(() => pollWithRetry(pollEth, 'Ethereum').catch(err => console.error('Ethereum polling interval error:', err)), pollInterval);

  await pollWithRetry(pollBsc, 'BSC').catch(err => console.error('Initial BSC poll failed:', err));
  await pollWithRetry(pollEth, 'Ethereum').catch(err => console.error('Initial Ethereum poll failed:', err));
};

// Start monitoring
try {
  monitorTransactions();
} catch (err) {
  console.error('Failed to start transaction monitoring:', err);
  process.exit(1);
}

// API route for frontend
app.get('/api/transactions', (req, res) => {
  res.json(transactions.map(tx => ({
    ...tx,
    video: tx.video
  })));
});

// Export for serverless handler
export default app;
