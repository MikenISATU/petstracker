import express from 'express';
import TelegramBot from 'node-telegram-bot-api';
import Web3 from 'web3';

const app = express();
app.use(express.json());

// Environment variables
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '7347310243:AAGYxgwO4jMaZVkZsCPxrUN9X_GE2emq73Y';
const INFURA_BSC_URL = process.env.INFURA_BSC_URL || 'https://bsc-dataseed.binance.org/';
const INFURA_ETH_URL = process.env.INFURA_ETH_URL || 'https://mainnet.infura.io/v3/b9998be18b6941e9bc6ebbb4f1b5dfa3';
const VERCEL_URL = process.env.VERCEL_URL || 'https://petstokenbuy-eid20nn7i-miles-kenneth-napilan-isatus-projects.vercel.app/';

// Validate environment variables
if (!TELEGRAM_BOT_TOKEN || !INFURA_BSC_URL || !INFURA_ETH_URL || !VERCEL_URL) {
  console.error('Missing critical environment variables.');
  process.exit(1);
}

// Contract addresses
const PETS_BSC_ADDRESS = '0x4bdece4e422fa015336234e4fc4d39ae6dd75b01';
const PETS_ETH_ADDRESS = '0x98b794be9c4f49900c6193aaff20876e1f36043e';
const PANCAKESWAP_ROUTER = '0x10ED43C718714eb63d5aA57B78B54704E256024E';
const UNISWAP_ROUTER = '0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D';

// Initialize Web3 providers
const bscWeb3 = new Web3(new Web3.providers.HttpProvider(INFURA_BSC_URL));
const ethWeb3 = new Web3(new Web3.providers.HttpProvider(INFURA_ETH_URL));

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
const bscContract = new bscWeb3.eth.Contract(ERC20_ABI, PETS_BSC_ADDRESS);
const ethContract = new ethWeb3.eth.Contract(ERC20_ABI, PETS_ETH_ADDRESS);

// In-memory data
let transactions = [];
let activeChats = new Set();
let lastBscBlock = 0;
let lastEthBlock = 0;

// Categorize buy amounts
const categorizeBuy = (amount, web3) => {
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

// Detect DEX trade
const isDexTrade = async (txHash, chain) => {
  const web3 = chain === 'BSC' ? bscWeb3 : ethWeb3;
  const router = chain === 'BSC' ? PANCAKESWAP_ROUTER : UNISWAP_ROUTER;
  try {
    const tx = await web3.eth.getTransaction(txHash);
    return tx?.to?.toLowerCase() === router.toLowerCase();
  } catch (err) {
    console.error(`[DEX Check Error] Chain: ${chain}, TxHash: ${txHash}, Error:`, err.message);
    return false;
  }
};

// Initialize Telegram Bot with webhook
const bot = new TelegramBot(TELEGRAM_BOT_TOKEN);
console.log(`Set webhook: curl -X GET "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook?url=${VERCEL_URL}/api/bot"`);

// Telegram webhook route
app.post('/api/bot', (req, res) => {
  try {
    bot.processUpdate(req.body);
    res.sendStatus(200);
  } catch (err) {
    console.error('Error processing Telegram update:', err.message);
    res.sendStatus(500);
  }
});

// Telegram commands
bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  activeChats.add(chatId);
  bot.sendMessage(chatId, 'Welcome to PETS Tracker! Use /track to start receiving buy alerts.');
});

bot.onText(/\/track/, (msg) => {
  const chatId = msg.chat.id;
  activeChats.add(chatId);
  bot.sendMessage(chatId, 'Started tracking PETS buys.');
});

bot.onText(/\/stop/, (msg) => {
  const chatId = msg.chat.id;
  activeChats.delete(chatId);
  bot.sendMessage(chatId, 'Stopped tracking PETS buys.');
});

bot.onText(/\/stats/, async (msg) => {
  const chatId = msg.chat.id;
  let bscMessage = 'BSC: No transactions recorded yet.';
  let ethMessage = 'Ethereum: No transactions recorded yet.';

  // Fetch latest BSC transaction
  try {
    const latestBscBlock = await bscWeb3.eth.getBlockNumber();
    const events = await bscContract.getPastEvents('Transfer', {
      fromBlock: Number(latestBscBlock) - 1,
      toBlock: Number(latestBscBlock)
    });
    const lastEvent = events.sort((a, b) => b.blockNumber - a.blockNumber)[0];
    if (lastEvent) {
      const { returnValues, transactionHash } = lastEvent;
      const { to, value } = returnValues;
      const isPairTrade = await isDexTrade(transactionHash, 'BSC');
      const category = categorizeBuy(value, bscWeb3);
      bscMessage = `BSC Last Transaction:\nCategory: ${category}\nAmount: ${bscWeb3.utils.fromWei(value, 'ether')} PETS\nTo: ${to}\nPair Trade: ${isPairTrade ? 'Yes' : 'No'}`;
    }
  } catch (err) {
    console.error(`Error fetching BSC stats:`, err.message);
    bscMessage = 'BSC: Error fetching latest transaction.';
  }

  // Fetch latest Ethereum transaction
  try {
    const latestEthBlock = await ethWeb3.eth.getBlockNumber();
    const events = await ethContract.getPastEvents('Transfer', {
      fromBlock: Number(latestEthBlock) - 1,
      toBlock: Number(latestEthBlock)
    });
    const lastEvent = events.sort((a, b) => b.blockNumber - a.blockNumber)[0];
    if (lastEvent) {
      const { returnValues, transactionHash } = lastEvent;
      const { to, value } = returnValues;
      const isPairTrade = await isDexTrade(transactionHash, 'Ethereum');
      const category = categorizeBuy(value, ethWeb3);
      ethMessage = `Ethereum Last Transaction:\nCategory: ${category}\nAmount: ${ethWeb3.utils.fromWei(value, 'ether')} PETS\nTo: ${to}\nPair Trade: ${isPairTrade ? 'Yes' : 'No'}`;
    }
  } catch (err) {
    console.error(`Error fetching Ethereum stats:`, err.message);
    ethMessage = 'Ethereum: Error fetching latest transaction.';
  }

  const message = `Latest $PETS Transactions:\n\n${bscMessage}\n\n${ethMessage}`;
  bot.sendMessage(chatId, message)
    .catch(err => console.error(`Failed to send /stats message to ${chatId}:`, err.message));
});

bot.onText(/\/help/, (msg) => {
  const chatId = msg.chat.id;
  bot.sendMessage(chatId, 'Commands:\n/start - Start bot\n/track - Enable alerts\n/stop - Disable alerts\n/stats - Last $PETS tx on BSC & ETH\n/status - Tracking status\n/help - This message');
});

bot.onText(/\/status/, (msg) => {
  const chatId = msg.chat.id;
  const isTracking = activeChats.has(chatId);
  bot.sendMessage(chatId, `Status: ${isTracking ? 'Tracking' : 'Not tracking'}\nTotal transactions: ${transactions.length}`);
});

// Polling function
const monitorTransactions = async () => {
  const pollInterval = 120 * 1000; // Poll every 120 seconds
  const maxBlocksPerPoll = 5; // Process 5 blocks per poll
  let retryDelay = 2000; // Initial retry delay

  const pollChain = async (chain, web3, contract, lastBlock, router) => {
    try {
      const latestBlock = await web3.eth.getBlockNumber();
      if (lastBlock === 0) lastBlock = latestBlock - BigInt(maxBlocksPerPoll);

      const fromBlock = lastBlock;
      const toBlock = latestBlock > fromBlock + BigInt(maxBlocksPerPoll) ? fromBlock + BigInt(maxBlocksPerPoll) : latestBlock;

      if (fromBlock >= toBlock) return lastBlock;

      const events = await contract.getPastEvents('Transfer', {
        fromBlock: Number(fromBlock),
        toBlock: Number(toBlock)
      });

      const newTxs = [];
      for (const event of events) {
        const { returnValues, transactionHash } = event;
        const { to, value } = returnValues;
        const isPairTrade = await isDexTrade(transactionHash, chain);
        if (!isPairTrade) continue; // Only process DEX trades
        const category = categorizeBuy(value, web3);
        const tx = {
          chain,
          to,
          amount: web3.utils.fromWei(value, 'ether'),
          category,
          video: categoryVideos[category],
          timestamp: Date.now(),
          isPairTrade,
          transactionHash
        };

        if (!transactions.some(t => t.transactionHash === tx.transactionHash)) {
          transactions.push(tx);
          if (transactions.length > 50) transactions.shift();
          newTxs.push(tx);
        }
      }

      // Batch notifications
      if (newTxs.length > 0) {
        for (const chatId of activeChats) {
          const message = newTxs.map(tx => 
            `🚀 ${tx.category} on ${chain}${tx.isPairTrade ? ' (Pair Trade)' : ''}\nTo: ${tx.to}\nAmount: ${tx.amount} PETS`
          ).join('\n\n');
          try {
            await bot.sendMessage(chatId, message);
            if (newTxs[0].video) {
              await bot.sendVideo(chatId, `${VERCEL_URL}${newTxs[0].video}`, { caption: newTxs[0].category });
            }
          } catch (err) {
            console.error(`Failed to send to chat ${chatId}:`, err.message);
          }
        }
      }

      return toBlock + BigInt(1);
    } catch (err) {
      console.error(`Error polling ${chain}:`, err.message);
      if (err.message.includes('limit exceeded') || err.message.includes('socket hang up')) {
        console.log(`Retrying ${chain} in ${retryDelay / 1000}s`);
        await new Promise(resolve => setTimeout(resolve, retryDelay));
        retryDelay = Math.min(retryDelay * 2, 30000); // Max 30s
      }
      return lastBlock;
    }
  };

  // Main polling loop
  const pollLoop = async () => {
    while (true) {
      if (activeChats.size > 0) {
        lastBscBlock = await pollChain('BSC', bscWeb3, bscContract, lastBscBlock, PANCAKESWAP_ROUTER);
        lastEthBlock = await pollChain('Ethereum', ethWeb3, ethContract, lastEthBlock, UNISWAP_ROUTER);
      }
      await new Promise(resolve => setTimeout(resolve, pollInterval));
    }
  };

  // Start polling loop
  pollLoop().catch(err => console.error('Polling loop error:', err.message));
};

// Start monitoring
monitorTransactions().catch(err => {
  console.error('Failed to start monitoring:', err.message);
  process.exit(1);
});

// API route for frontend
app.get('/api/transactions', (req, res) => {
  res.json(transactions.map(tx => ({
    ...tx,
    video: `${VERCEL_URL}${tx.video}`
  })));
});

// Export for serverless
export default app;
