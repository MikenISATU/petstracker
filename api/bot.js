import express from 'express';
import TelegramBot from 'node-telegram-bot-api';
import Web3 from 'web3';
import pRetry from 'p-retry';
import { Agent } from 'undici';

console.log('Web3 import:', Web3);

const app = express();
app.use(express.json());

// Load environment variables safely
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '7347310243:AAGYxgwO4jMaZVkZsCPxrUN9X_GE2emq73Y';
const INFURA_BSC_URL = process.env.INFURA_BSC_URL || 'https://bsc.nownodes.io/97a8bb57-9985-48b3-ad57-8054752cfcb5';
const INFURA_ETH_URL = process.env.INFURA_ETH_URL || 'https://rpc.ankr.com/eth';
const VERCEL_URL = process.env.VERCEL_URL || 'https://petstokenbuy-eid20nn7i-miles-kenneth-napilan-isatus-projects.vercel.app/';

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

// Placeholder for USDT price
const getUSDTValue = (amountInPETS, chain) => {
  const web3 = chain === 'BSC' ? bscWeb3 : ethWeb3;
  if (!web3) return '0.00';
  const tokens = web3.utils.fromWei(amountInPETS, 'ether');
  const pricePerPETS = 0.01; // Placeholder: $0.01 per PETS
  return (parseFloat(tokens) * pricePerPETS).toFixed(2);
};

// Placeholder for Market Cap
const getMarketCap = () => {
  return '$10M';
};

// Categorize buy amounts
const categorizeBuy = (amount, web3) => {
  if (!web3) return 'Unknown Buy';
  const tokens = web3.utils.fromWei(amount, 'ether');
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

// Video display placeholders
const categoryVideoDisplays = {
  'MicroPets Buy': '[Small Buy Video]',
  'Medium Bullish Buy': '[Medium Buy Video]',
  'Whale Buy': '[Large Buy Video]'
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

  // BSC latest transaction (BNB pair)
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
      const usdtValue = getUSDTValue(value, 'BSC');
      const marketCap = getMarketCap();
      const tokens = bscWeb3.utils.fromWei(value, 'ether');
      const bscScanUrl = `https://bscscan.com/tx/${transactionHash}`;
      bscMessage = `@MicroPets Buy Bot\nMicroPets Buy - BNB Pair\n${videoDisplay}\nBNB Value: $${usdtValue}\nMarket Cap: ${marketCap}\nHoldings: ${tokens} $PETS\nHolder Address: ${to}\n[BscScan](${bscScanUrl})\n\n📍 [Staking](https://pets.micropets.io/petdex)  📊 [Chart](https://www.dextools.io/app/en/bnb/pair-explorer/0x4bdece4e422fa015336234e4fc4d39ae6dd75b01)  🛍️ [Merch](https://micropets.store/)  💰 [Buy $PETS](https://pancakeswap.finance/swap?outputCurrency=0x4bdece4e422fa015336234e4fc4d39ae6dd75b01)`;
    }
  } catch (err) {
    console.error(`Error fetching BSC stats:`, err.message);
    bscMessage = 'BNB Pair: Error fetching latest transaction.';
  }

  // Ethereum latest transaction (ETH pair)
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
      const usdtValue = getUSDTValue(value, 'Ethereum');
      const marketCap = getMarketCap();
      const tokens = ethWeb3.utils.fromWei(value, 'ether');
      const etherscanUrl = `https://etherscan.io/tx/${transactionHash}`;
      ethMessage = `@MicroPets Buy Bot\nMicroPets Buy - ETH Pair\n${videoDisplay}\nETH Value: $${usdtValue}\nMarket Cap: ${marketCap}\nHoldings: ${tokens} $PETS\nHolder Address: ${to}\n[Etherscan](${etherscanUrl})\n\n📍 [Staking](https://pets.micropets.io/petdex)  📊 [Chart](https://www.dextools.io/app/en/ether/pair-explorer/0x98b794be9c4f49900c6193aaff20876e1f36043e?t=1726815772329)  🛍️ [Merch](https://micropets.store/)  💰 [Buy $PETS](https://app.uniswap.org/swap?chain=mainnet&inputCurrency=NATIVE&outputCurrency=0x98b794be9c4f49900c6193aaff20876e1f36043e)`;
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

bot.onText(/\/test/, (msg) => {
  const chatId = msg.chat.id;
  console.log(`Processing /test for chat ${chatId}`);
  // Randomly select a buy category
  const categories = ['MicroPets Buy', 'Medium Bullish Buy', 'Whale Buy'];
  const category = categories[Math.floor(Math.random() * categories.length)];
  const videoDisplay = categoryVideoDisplays[category] || '[Default Video]';
  const videoPath = categoryVideos[category] || '/videos/default.mp4';
  // Generate a random transaction hash (not real)
  const randomTxHash = '0x' + Array.from({length: 64}, () => Math.floor(Math.random() * 16).toString(16)).join('');
  const toAddress = '0x1234567890abcdef1234567890abcdef12345678';
  const tokens = category === 'MicroPets Buy' ? '500' : category === 'Medium Bullish Buy' ? '5000' : '15000';
  const usdtValue = (parseFloat(tokens) * 0.01).toFixed(2);
  const marketCap = getMarketCap();
  
  // Randomly select chain
  const chain = Math.random() > 0.5 ? 'BSC' : 'Ethereum';
  const scanUrl = chain === 'BSC' ? `https://bscscan.com/tx/${randomTxHash}` : `https://etherscan.io/tx/${randomTxHash}`;
  const message = chain === 'BSC' 
    ? `@MicroPets Buy Bot\nMicroPets Buy - BNB Pair\n${videoDisplay}\nBNB Value: $${usdtValue}\nMarket Cap: ${marketCap}\nHoldings: ${tokens} $PETS\nHolder Address: ${toAddress}\n[BscScan](${scanUrl})\n\n📍 [Staking](https://pets.micropets.io/petdex)  📊 [Chart](https://www.dextools.io/app/en/bnb/pair-explorer/0x4bdece4e422fa015336234e4fc4d39ae6dd75b01)  🛍️ [Merch](https://micropets.store/)  💰 [Buy $PETS](https://pancakeswap.finance/swap?outputCurrency=0x4bdece4e422fa015336234e4fc4d39ae6dd75b01)`
    : `@MicroPets Buy Bot\nMicroPets Buy - ETH Pair\n${videoDisplay}\nETH Value: $${usdtValue}\nMarket Cap: ${marketCap}\nHoldings: ${tokens} $PETS\nHolder Address: ${toAddress}\n[Etherscan](${scanUrl})\n\n📍 [Staking](https://pets.micropets.io/petdex)  📊 [Chart](https://www.dextools.io/app/en/ether/pair-explorer/0x98b794be9c4f49900c6193aaff20876e1f36043e?t=1726815772329)  🛍️ [Merch](https://micropets.store/)  💰 [Buy $PETS](https://app.uniswap.org/swap?chain=mainnet&inputCurrency=NATIVE&outputCurrency=0x98b794be9c4f49900c6193aaff20876e1f36043e)`;

  bot.sendVideo(chatId, `${VERCEL_URL}${videoPath}`, {
    caption: message,
    parse_mode: 'Markdown'
  }).catch(err => console.error(`Failed to send /test message to ${chatId}:`, err));
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
        const videoPath = categoryVideos[category] || '/videos/default.mp4';
        const usdtValue = getUSDTValue(value, 'BSC');
        const marketCap = getMarketCap();
        const tokens = bscWeb3.utils.fromWei(value, 'ether');
        const bscScanUrl = `https://bscscan.com/tx/${transactionHash}`;
        const tx = {
          chain: 'BSC',
          to,
          amount: tokens,
          category,
          video: videoPath,
          videoDisplay,
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
                caption: `@MicroPets Buy Bot\nMicroPets Buy - BNB Pair\n${videoDisplay}\nBNB Value: $${usdtValue}\nMarket Cap: ${marketCap}\nHoldings: ${tokens} $PETS\nHolder Address: ${to}\n[BscScan](${bscScanUrl})\n\n📍 [Staking](https://pets.micropets.io/petdex)  📊 [Chart](https://www.dextools.io/app/en/bnb/pair-explorer/0x4bdece4e422fa015336234e4fc4d39ae6dd75b01)  🛍️ [Merch](https://micropets.store/)  💰 [Buy $PETS](https://pancakeswap.finance/swap?outputCurrency=0x4bdece4e422fa015336234e4fc4d39ae6dd75b01)`,
                parse_mode: 'Markdown'
              });
            } catch (err) {
              console.error(`Failed to send video to chat ${chatId}:`, err);
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
        const videoPath = categoryVideos[category] || '/videos/default.mp4';
        const usdtValue = getUSDTValue(value, 'Ethereum');
        const marketCap = getMarketCap();
        const tokens = ethWeb3.utils.fromWei(value, 'ether');
        const etherscanUrl = `https://etherscan.io/tx/${transactionHash}`;
        const tx = {
          chain: 'Ethereum',
          to,
          amount: tokens,
          category,
          video: videoPath,
          videoDisplay,
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
                caption: `@MicroPets Buy Bot\nMicroPets Buy - ETH Pair\n${videoDisplay}\nETH Value: $${usdtValue}\nMarket Cap: ${marketCap}\nHoldings: ${tokens} $PETS\nHolder Address: ${to}\n[Etherscan](${etherscanUrl})\n\n📍 [Staking](https://pets.micropets.io/petdex)  📊 [Chart](https://www.dextools.io/app/en/ether/pair-explorer/0x98b794be9c4f49900c6193aaff20876e1f36043e?t=1726815772329)  🛍️ [Merch](https://micropets.store/)  💰 [Buy $PETS](https://app.uniswap.org/swap?chain=mainnet&inputCurrency=NATIVE&outputCurrency=0x98b794be9c4f49900c6193aaff20876e1f36043e)`,
                parse_mode: 'Markdown'
              });
            } catch (err) {
              console.error(`Failed to send video to chat ${chatId}:`, err);
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
    video: `${VERCEL_URL}${tx.video}`
  })));
});

// Export for serverless handler
export default app;
