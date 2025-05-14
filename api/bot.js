import express from 'express';
import TelegramBot from 'node-telegram-bot-api';
import Web3 from 'web3';

console.log('Web3 import:', Web3); // Debug log to verify import

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
const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true }); // Enable polling as fallback
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
  bot.sendMessage(chatId, 'Welcome to PETS Tracker! Use /track to start receiving buy alerts.')
    .catch(err => console.error(`Failed to send /start message to ${chatId}:`, err));
});

bot.onText(/\/track/, (msg) => {
  const chatId = msg.chat.id;
  console.log(`Processing /track for chat ${chatId}`);
  activeChats.add(chatId);
  bot.sendMessage(chatId, 'Started tracking PETS buys. You’ll get notified on new buys.')
    .catch(err => console.error(`Failed to send /track message to ${chatId}:`, err));
});

bot.onText(/\/stop/, (msg) => {
  const chatId = msg.chat.id;
  console.log(`Processing /stop for chat ${chatId}`);
  activeChats.delete(chatId);
  bot.sendMessage(chatId, 'Stopped tracking PETS buys.')
    .catch(err => console.error(`Failed to send /stop message to ${chatId}:`, err));
});

bot.onText(/\/stats/, async (msg) => {
  const chatId = msg.chat?.id;
  if (!chatId) {
    console.error('Invalid message object in /stats:', msg);
    return;
  }
  console.log(`Processing /stats for chat ${chatId}`);
  let bscMessage = 'BSC: No transactions recorded yet.';
  let ethMessage = 'Ethereum: No transactions recorded yet.';

  try {
    const latestBscBlock = await bscWeb3.eth.getBlockNumber();
    const events = await bscContract.getPastEvents('Transfer', {
      fromBlock: Number(BigInt(latestBscBlock) - 1n),
      toBlock: Number(latestBscBlock)
    });
    const lastEvent = events.sort((a, b) => Number(b.blockNumber - a.blockNumber))[0];
    if (lastEvent) {
      const { returnValues, transactionHash } = lastEvent;
      const { to, value } = returnValues;
      const isPairTrade = await isDexTrade(transactionHash, 'BSC');
      const category = categorizeBuy(value, bscWeb3);
      bscMessage = `BSC Latest Transaction:\nCategory: ${category}\nAmount: ${bscWeb3.utils.fromWei(value, 'ether')} PETS\nTo: ${to}\nPair Trade: ${isPairTrade ? 'Yes' : 'No'}\nVideo: ${VERCEL_URL}${categoryVideos[category]}`;
    }
  } catch (err) {
    console.error(`Error fetching BSC stats:`, err.message);
    bscMessage = 'BSC: Error fetching latest transaction.';
  }

  try {
    const latestEthBlock = await ethWeb3.eth.getBlockNumber();
    const events = await ethContract.getPastEvents('Transfer', {
      fromBlock: Number(BigInt(latestEthBlock) - 1n),
      toBlock: Number(latestEthBlock)
    });
    const lastEvent = events.sort((a, b) => Number(b.blockNumber - a.blockNumber))[0];
    if (lastEvent) {
      const { returnValues, transactionHash } = lastEvent;
      const { to, value } = returnValues;
      const isPairTrade = await isDexTrade(transactionHash, 'Ethereum');
      const category = categorizeBuy(value, ethWeb3);
      ethMessage = `Ethereum Latest Transaction:\nCategory: ${category}\nAmount: ${ethWeb3.utils.fromWei(value, 'ether')} PETS\nTo: ${to}\nPair Trade: ${isPairTrade ? 'Yes' : 'No'}\nVideo: ${VERCEL_URL}${categoryVideos[category]}`;
    }
  } catch (err) {
    console.error(`Error fetching Ethereum stats:`, err.message);
    ethMessage = 'Ethereum: Error fetching latest transaction.';
  }

  const message = `Latest $PETS Transactions:\n\n${bscMessage}\n\n${ethMessage}`;
  await bot.sendMessage(chatId, message)
    .catch(err => console.error(`Failed to send /stats message to ${chatId}:`, err));
});

bot.onText(/\/help/, (msg) => {
  const chatId = msg.chat.id;
  console.log(`Processing /help for chat ${chatId}`);
  bot.sendMessage(chatId, 'Available commands:\n/start - Start the bot\n/track - Enable buy alerts\n/stop - Disable buy alerts\n/stats - View last 5 transaction stats\n/status - Check tracking status\n/help - Show this message')
    .catch(err => console.error(`Failed to send /help message to ${chatId}:`, err));
});

bot.onText(/\/status/, (msg) => {
  const chatId = msg.chat.id;
  console.log(`Processing /status for chat ${chatId}`);
  const isTracking = activeChats.has(chatId);
  bot.sendMessage(chatId, `Status: ${isTracking ? 'Tracking enabled' : 'Tracking disabled'}\nTotal tracked transactions: ${transactions.length}`)
    .catch(err => console.error(`Failed to send /status message to ${chatId}:`, err));
});

// Polling function with rate limit handling
const monitorTransactions = async () => {
  const pollInterval = 60 * 1000; // Poll every 60 seconds
  const maxBlocksPerPoll = 10; // Limit to 10 blocks per poll
  let retryDelay = 5000; // Initial retry delay for rate limits

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
        console.log(`Rate limit hit. Retrying in ${retryDelay / 1000} seconds.`);
        await new Promise(resolve => setTimeout(resolve, retryDelay));
        retryDelay = Math.min(retryDelay * 2, 60000); // Exponential backoff, max 60s
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
        retryDelay = Math.min(retryDelay * 2, 60000); // Exponential backoff, max 60s
      }
    }
  };

  // Run polling loops
  setInterval(pollBsc, pollInterval);
  setInterval(pollEth, pollInterval);

  // Run immediately on start
  await pollBsc();
  await pollEth();
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
