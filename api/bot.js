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
if (!TELEGRAM_BOT_TOKEN || !VERCEL_URL) {
  console.warn('Missing critical environment variables. Running with limited functionality.');
}

// Contract addresses
const PETS_BSC_ADDRESS = '0x4bdece4e422fa015336234e4fc4d39ae6dd75b01';
const PETS_ETH_ADDRESS = '0x98b794be9c4f49900c6193aaff20876e1f36043e';

// DEX router addresses
const PANCAKESWAP_ROUTER = '0x10ED43C718714eb63d5aA57B78B54704E256024E';
const UNISWAP_ROUTER = '0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D';

// Initialize Web3 providers
let bscWeb3, ethWeb3;
try {
  bscWeb3 = new Web3(new Web3.providers.HttpProvider(INFURA_BSC_URL));
  console.log('bscWeb3 initialized:', !!bscWeb3);
} catch (err) {
  console.error('Failed to initialize bscWeb3:', err);
  bscWeb3 = null;
}

try {
  ethWeb3 = new Web3(new Web3.providers.HttpProvider(INFURA_ETH_URL));
  console.log('ethWeb3 initialized:', !!ethWeb3);
} catch (err) {
  console.error('Failed to initialize ethWeb3:', err);
  ethWeb3 = null;
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
  bscContract = bscWeb3 ? new bscWeb3.eth.Contract(ERC20_ABI, PETS_BSC_ADDRESS) : null;
  console.log('bscContract initialized:', !!bscContract);
} catch (err) {
  console.error('Failed to initialize bscContract:', err);
  bscContract = null;
}

try {
  ethContract = ethWeb3 ? new ethWeb3.eth.Contract(ERC20_ABI, PETS_ETH_ADDRESS) : null;
  console.log('ethContract initialized:', !!ethContract);
} catch (err) {
  console.error('Failed to initialize ethContract:', err);
  ethContract = null;
}

// In-memory data
let transactions = [];
let activeChats = new Set();
let lastBscBlock = 0n; // Use BigInt for block numbers
let lastEthBlock = 0n;

// Categorize buy amounts
const categorizeBuy = (amount, web3 = bscWeb3) => {
  if (!web3) return 'Unknown Buy';
  const tokens = web3.utils.fromWei(amount.toString(), 'ether');
  if (parseFloat(tokens) < 1000) return 'MicroPets Buy';
  if (parseFloat(tokens) < 10000) return 'Medium Bullish Buy';
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
const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: false });
const webhookPath = '/api/bot';
const webhookUrl = `${VERCEL_URL}${webhookPath}`;

// Set webhook with retries using https
const setWebhook = async (retries = 5, delay = 3000, timeout = 10000) => {
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
      console.error(`Error setting webhook (attempt ${attempt}): ${err.message}`);
      if (attempt < retries) {
        console.log(`Retrying in ${delay / 1000} seconds...`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }
  console.error('All webhook setup attempts failed. Falling back to polling with 1s interval.');
  const pollingBot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: { interval: 1000 } });
  attachCommandHandlers(pollingBot);
  return false;
};

// Attach command handlers
const attachCommandHandlers = (botInstance) => {
  botInstance.onText(/\/start/, (msg) => {
    const chatId = msg.chat.id;
    const startTime = Date.now();
    console.log(`Processing /start for chat ${chatId}`);
    activeChats.add(chatId);
    botInstance.sendMessage(chatId, 'Welcome to PETS Tracker! Use /track to see the latest transaction.')
      .then(() => console.log(`/start response sent to ${chatId} in ${Date.now() - startTime}ms`))
      .catch(err => console.error(`Failed to send /start message to ${chatId}:`, err));
  });

  botInstance.onText(/\/track/, async (msg) => {
    const chatId = msg.chat.id;
    const startTime = Date.now();
    console.log(`Processing /track for chat ${chatId}`);
    activeChats.add(chatId);
    const latestTx = await fetchLatestTransaction();
    let message = 'Tracking PETS buys. Latest transaction:\n';
    if (latestTx) {
      message += `${latestTx.chain} ${latestTx.category}: ${latestTx.amount} PETS at ${new Date(latestTx.timestamp).toLocaleString()}\n`;
    } else {
      message += 'No recent transactions found.';
    }
    botInstance.sendMessage(chatId, message)
      .then(() => console.log(`/track response sent to ${chatId} in ${Date.now() - startTime}ms`))
      .catch(err => console.error(`Failed to send /track message to ${chatId}:`, err));
  });

  botInstance.onText(/\/stop/, (msg) => {
    const chatId = msg.chat.id;
    const startTime = Date.now();
    console.log(`Processing /stop for chat ${chatId}`);
    activeChats.delete(chatId);
    botInstance.sendMessage(chatId, 'Stopped tracking PETS buys.')
      .then(() => console.log(`/stop response sent to ${chatId} in ${Date.now() - startTime}ms`))
      .catch(err => console.error(`Failed to send /stop message to ${chatId}:`, err));
  });

  botInstance.onText(/\/stats/, async (msg) => {
    const chatId = msg.chat.id;
    const startTime = Date.now();
    console.log(`Processing /stats for chat ${chatId}`);
    const latestTx = await fetchLatestTransaction();
    let message = 'Most Recent Transaction:\n';
    if (latestTx) {
      message += `Chain: ${latestTx.chain}\nTo: ${latestTx.to}\nAmount: ${latestTx.amount} PETS\nCategory: ${latestTx.category}\nTimestamp: ${new Date(latestTx.timestamp).toLocaleString()}\n`;
    } else {
      message += 'No transactions recorded yet.';
    }
    botInstance.sendMessage(chatId, message)
      .then(() => console.log(`/stats response sent to ${chatId} in ${Date.now() - startTime}ms`))
      .catch(err => console.error(`Failed to send /stats message to ${chatId}:`, err));
  });

  botInstance.onText(/\/help/, (msg) => {
    const chatId = msg.chat.id;
    const startTime = Date.now();
    console.log(`Processing /help for chat ${chatId}`);
    botInstance.sendMessage(chatId, 'Available commands:\n/start - Start the bot\n/track - Enable buy alerts\n/stop - Disable buy alerts\n/stats - View most recent transaction\n/status - Check tracking status\n/help - Show this message\n/setwebhook - Manually set webhook')
      .then(() => console.log(`/help response sent to ${chatId} in ${Date.now() - startTime}ms`))
      .catch(err => console.error(`Failed to send /help message to ${chatId}:`, err));
  });

  botInstance.onText(/\/status/, (msg) => {
    const chatId = msg.chat.id;
    const startTime = Date.now();
    console.log(`Processing /status for chat ${chatId}`);
    const isTracking = activeChats.has(chatId);
    botInstance.sendMessage(chatId, `Status: ${isTracking ? 'Tracking enabled' : 'Tracking disabled'}\nTotal tracked transactions: ${transactions.length}`)
      .then(() => console.log(`/status response sent to ${chatId} in ${Date.now() - startTime}ms`))
      .catch(err => console.error(`Failed to send /status message to ${chatId}:`, err));
  });

  botInstance.onText(/\/setwebhook/, async (msg) => {
    const chatId = msg.chat.id;
    const startTime = Date.now();
    console.log(`Processing /setwebhook for chat ${chatId}`);
    try {
      const success = await setWebhook(3, 2000, 8000);
      botInstance.sendMessage(chatId, success ? 'Webhook set successfully!' : 'Failed to set webhook. Check logs for details.')
        .then(() => console.log(`/setwebhook response sent to ${chatId} in ${Date.now() - startTime}ms`))
        .catch(err => console.error(`Failed to send /setwebhook message to ${chatId}:`, err));
    } catch (err) {
      console.error(`Error in /setwebhook: ${err.message}`);
      botInstance.sendMessage(chatId, 'Error setting webhook. Check logs.')
        .then(() => console.log(`/setwebhook response sent to ${chatId} in ${Date.now() - startTime}ms`))
        .catch(err => console.error(`Failed to send /setwebhook message to ${chatId}:`, err));
    }
  });
};

// Fetch the latest transaction
const fetchLatestTransaction = async () => {
  let latestTx = null;

  // BSC transaction
  if (bscContract) {
    try {
      const bscBlock = await bscWeb3.eth.getBlockNumber();
      const bscEvents = await bscContract.getPastEvents('Transfer', {
        fromBlock: Number(bscBlock) - 3,
        toBlock: Number(bscBlock)
      });
      if (bscEvents.length > 0) {
        const event = bscEvents[bscEvents.length - 1];
        const { returnValues, transactionHash } = event;
        const { to, value } = returnValues;
        const amount = bscWeb3.utils.fromWei(value.toString(), 'ether');
        const isPairTrade = await isDexTrade(transactionHash, 'BSC');
        latestTx = {
          chain: 'BSC',
          to,
          amount,
          category: categorizeBuy(value),
          video: categoryVideos[categorizeBuy(value)] || '/videos/default.mp4',
          timestamp: Date.now(),
          isPairTrade,
          transactionHash
        };
      }
    } catch (err) {
      console.error('Error fetching latest BSC transaction:', err);
    }
  }

  // Ethereum transaction
  if (ethContract) {
    try {
      const ethBlock = await ethWeb3.eth.getBlockNumber();
      const ethEvents = await ethContract.getPastEvents('Transfer', {
        fromBlock: Number(ethBlock) - 3,
        toBlock: Number(ethBlock)
      });
      if (ethEvents.length > 0) {
        const event = ethEvents[ethEvents.length - 1];
        const { returnValues, transactionHash } = event;
        const { to, value } = returnValues;
        const amount = ethWeb3.utils.fromWei(value.toString(), 'ether');
        const isPairTrade = await isDexTrade(transactionHash, 'Ethereum');
        const ethTx = {
          chain: 'Ethereum',
          to,
          amount,
          category: categorizeBuy(value, ethWeb3),
          video: categoryVideos[categorizeBuy(value, ethWeb3)] || '/videos/default.mp4',
          timestamp: Date.now(),
          isPairTrade,
          transactionHash
        };
        if (!latestTx || ethTx.timestamp > latestTx.timestamp) {
          latestTx = ethTx;
        }
      }
    } catch (err) {
      console.error('Error fetching latest Ethereum transaction:', err);
    }
  }

  if (latestTx) {
    transactions.push(latestTx);
    if (transactions.length > 100) transactions.shift();
  }
  return latestTx;
};

// Polling function with rate limit handling
const monitorTransactions = async () => {
  const pollInterval = 120 * 1000; // Poll every 120 seconds
  const maxBlocksPerPoll = 3;
  let retryDelay = 5000;

  const pollChain = async (chain, web3, contract, lastBlock) => {
    if (!web3 || !contract) {
      console.log(`Polling skipped for ${chain}: Web3 or contract not initialized.`);
      return lastBlock;
    }
    try {
      const latestBlock = await web3.eth.getBlockNumber();
      if (lastBlock === 0n) lastBlock = BigInt(latestBlock) - BigInt(maxBlocksPerPoll);

      const fromBlock = lastBlock;
      const toBlock = latestBlock > Number(fromBlock) + maxBlocksPerPoll ? fromBlock + BigInt(maxBlocksPerPoll) : BigInt(latestBlock);

      if (fromBlock >= toBlock) {
        console.log(`No new blocks to poll on ${chain}.`);
        return lastBlock;
      }

      const events = await contract.getPastEvents('Transfer', {
        fromBlock: Number(fromBlock),
        toBlock: Number(toBlock)
      });

      for (const event of events) {
        const { returnValues, transactionHash } = event;
        const { to, value } = returnValues;
        const isPairTrade = await isDexTrade(transactionHash, chain);
        const category = categorizeBuy(value, web3);
        const tx = {
          chain,
          to,
          amount: web3.utils.fromWei(value.toString(), 'ether'),
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
                caption: `🚀 New ${category} on ${chain}${isPairTrade ? ' (Pair Trade)' : ''}!\nTo: ${to}\nAmount: ${tx.amount} PETS`
              });
            } catch (err) {
              console.error(`Failed to send video to chat ${chatId}:`, err);
            }
          }
        }
      }

      return toBlock;
    } catch (err) {
      console.error(`Error polling ${chain} Transfer events:`, err.message);
      if (err.message.includes('limit exceeded')) {
        console.warn('Rate limit hit. Consider a dedicated node provider or set DISABLE_BSC_POLLING=true.');
        console.log(`Retrying in ${retryDelay / 1000} seconds.`);
        await new Promise(resolve => setTimeout(resolve, retryDelay));
        retryDelay = Math.min(retryDelay * 2, 120000);
      }
      return lastBlock;
    }
  };

  setInterval(async () => {
    if (!DISABLE_BSC_POLLING) lastBscBlock = await pollChain('BSC', bscWeb3, bscContract, lastBscBlock);
    lastEthBlock = await pollChain('Ethereum', ethWeb3, ethContract, lastEthBlock);
  }, pollInterval);

  // Run immediately on start
  if (!DISABLE_BSC_POLLING) await pollChain('BSC', bscWeb3, bscContract, lastBscBlock);
  await pollChain('Ethereum', ethWeb3, ethContract, lastEthBlock);
};

// Start monitoring and webhook setup
setWebhook().then(() => monitorTransactions()).catch(err => console.error('Startup error:', err));

// Telegram webhook route
app.post(webhookPath, (req, res) => {
  try {
    console.log('Received Telegram update:', JSON.stringify(req.body));
    bot.processUpdate(req.body);
    res.sendStatus(200);
  } catch (err) {
    console.error('Error processing Telegram update:', err);
    res.sendStatus(500);
  }
});

// API route for frontend
app.get('/api/transactions', (req, res) => {
  res.json(transactions.map(tx => ({
    ...tx,
    video: `${VERCEL_URL}${tx.video}`
  })));
});

export default app;
