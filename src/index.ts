import { config } from "./config"; // Configuration parameters for our bot
import { fetchTransactionDetails, createSwapTransaction, getRugCheckConfirmed, fetchAndSaveSwapDetails } from "./transactions";
import { validateEnv } from "./utils/env-validator";
import { TelegramMonitorService } from "./services/telegram-monitor.service";
import { AnalyseManagerService } from "./services/analyse-manager.service";
import { TokenMonitorService } from "./services/token-monitor.service";
import { Logger } from './utils/logger';
import WebSocket from "ws"; // Node.js websocket library
import { WebSocketRequest } from "./types"; // Typescript Types for type safety

// Regional Variables
let activeTransactions = 0;
const MAX_CONCURRENT = config.tx.concurrent_transactions;

const logger = new Logger('TokenSniper');

// Function used to open our websocket connection
function sendSubscribeRequest(ws: WebSocket): void {
  const request: WebSocketRequest = {
    jsonrpc: "2.0",
    id: 1,
    method: "logsSubscribe",
    params: [
      {
        mentions: [config.liquidity_pool.radiyum_program_id],
      },
      {
        commitment: "processed", // Can use finalized to be more accurate.
      },
    ],
  };
  ws.send(JSON.stringify(request));
}

// Update the processTransaction function
async function processTransaction(tokenAddress: string): Promise<void> {
  // Output logs
  logger.info("=============================================");
  logger.info("🔎 New Token Signal Received");
  logger.info("🔃 Processing token...");

  // Ensure required data is available
  if (!tokenAddress) return;

  // Output logs
  logger.success("Token found");
  logger.info("👽 GMGN: https://gmgn.ai/sol/token/" + tokenAddress);
  logger.info("😈 BullX: https://neo.bullx.io/terminal?chainId=1399811149&address=" + tokenAddress);

  // Check if simulation mode is enabled
  if (config.rug_check.simulation_mode) {
    logger.warn("👀 Token not swapped. Simulation mode is enabled.");
    logger.info("🟢 Resuming looking for new tokens..\n");
    return;
  }

  // Add initial delay before first buy
  await new Promise((resolve) => setTimeout(resolve, config.tx.swap_tx_initial_delay));

  // Create Swap transaction
  const tx = await createSwapTransaction(null, tokenAddress); // Pass null for solMint as we'll get it from the pool
  if (!tx) {
    logger.error("⛔ Transaction aborted.");
    logger.info("🟢 Resuming looking for new tokens...\n");
    return;
  }
  
  // Output logs
  logger.success("🚀 Swapping SOL for Token.");
  logger.info(`Swap Transaction: https://solscan.io/tx/${tx}`);

  // Fetch and store the transaction for tracking purposes
  const saveConfirmation = await fetchAndSaveSwapDetails(tx);
  if (!saveConfirmation) {
    logger.error("❌ Warning: Transaction not saved for tracking! Track Manually!");
  }
}

// Replace websocketHandler with telegramHandler
async function initializeTelegramHandler(): Promise<void> {
  // Load environment variables from the .env file
  const env = validateEnv();

  // Create and initialize the DexAnalyseManager first
  const dexAnalyseManager = new AnalyseManagerService();
  
  // Set up the callback before creating the telegram service
  dexAnalyseManager.onTokenReceived = async (tokenAddress: string) => {
    try {
      // Verify if we have reached the max concurrent transactions
      if (activeTransactions >= MAX_CONCURRENT) {
        logger.warn("⏳ Max concurrent transactions reached, skipping...");
        return;
      }

      // Add additional concurrent transaction
      activeTransactions++;

      // Process transaction asynchronously
      await processTransaction(tokenAddress)
        .catch((error) => {
          logger.error("Error processing transaction:", error);
        })
        .finally(() => {
          activeTransactions--;
        });
    } catch (error) {
      logger.error("💥 Error processing message:", {
        error: error instanceof Error ? error.message : "Unknown error",
        timestamp: new Date().toISOString(),
      });
    }
  };

  await dexAnalyseManager.initialize();

  // Create telegram service and pass the dexAnalyseManager to it
  const telegramService = new TelegramMonitorService(dexAnalyseManager);
  await telegramService.initialize();

  // Fetch latest messages from the channel
  logger.info('Fetching latest messages from the channel...');
  await telegramService.getLatestChannelMessages();
}

// Start Telegram Handler
initializeTelegramHandler().catch((err) => {
  logger.error("Failed to initialize Telegram handler:", err.message);
});

// Websocket Handler for listening to the Solana logSubscribe method
let init = false;
let tokenMonitorInstance: TokenMonitorService | null = null;

async function websocketHandler(): Promise<void> {
  // Load environment variables from the .env file
  const env = validateEnv();

  // Create a WebSocket connection with correct URL format
  const wsUrl = `wss://mainnet.helius-rpc.com/v0/ws?api-key=${env.HELIUS_API_KEY}`;
  let ws: WebSocket | null = new WebSocket(wsUrl);
  if (!init) console.clear();

  // Function to send a ping to keep connection alive
  function startPing(ws: WebSocket) {
    setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
            ws.ping();
            logger.info('Ping sent to keep connection alive');
        }
    }, 30000); // Ping every 30 seconds
  }

  // Send subscription to the websocket once the connection is open
  ws.on("open", () => {
    logger.info("\n🔓 WebSocket is open and listening.");
    if (ws) {
        // Send subscription request
        const request: WebSocketRequest = {
            jsonrpc: "2.0",
            id: 1,
            method: "logsSubscribe",
            params: [
                {
                    mentions: [config.liquidity_pool.radiyum_program_id]
                },
                {
                    commitment: "finalized"
                }
            ]
        };
        ws.send(JSON.stringify(request));
        logger.info("Subscription request sent");
        startPing(ws);
    }
    init = true;
  });

  // Logic for the message event for the .on event listener
  ws.on("message", async (data: WebSocket.Data) => {
    try {
      const messageStr = data.toString('utf8');
      const parsedData = JSON.parse(messageStr);

      // Handle subscription response
      if (parsedData.result !== undefined && !parsedData.error) {
        logger.info("✅ Subscription confirmed");
        return;
      }

      // Only log RPC errors for debugging
      if (parsedData.error) {
        logger.error("🚫 RPC Error:", parsedData.error);
        return;
      }

      // Safely access the nested structure
      const logs = parsedData?.params?.result?.value?.logs;
      const signature = parsedData?.params?.result?.value?.signature;

      // Validate `logs` is an array and if we have a signature
      if (!Array.isArray(logs) || !signature) return;

      // Verify if this is a new pool creation
      const containsCreate = logs.some((log: string) => typeof log === "string" && log.includes("Program log: initialize2: InitializeInstruction2"));
      if (!containsCreate || typeof signature !== "string") return;

      logger.info(`New pool creation detected with signature: ${signature}`);

      // Fetch transaction details to get the token mint
      try {
        const txDetails = await fetchTransactionDetails(signature);
        if (!txDetails) {
          logger.error("Failed to fetch transaction details");
          return;
        }

        logger.info(`Found new token mint: ${txDetails.mint}`);

        // If we have a token monitor instance, let it handle the new token
        if (tokenMonitorInstance) {
          await tokenMonitorInstance.handleNewTokenFromWebsocket(txDetails);
        }
      } catch (error) {
        logger.error("Error fetching transaction details:", error);
      }
    } catch (error) {
      logger.error("💥 Error processing message:", {
        error: error instanceof Error ? error.message : "Unknown error",
        timestamp: new Date().toISOString(),
      });
    }
  });

  ws.on("error", (err: Error) => {
    logger.error("WebSocket error:", err);
    // Try to reconnect on error after a delay
    if (ws) {
        ws.removeAllListeners();
        ws = null;
    }
    setTimeout(websocketHandler, 5000);
  });

  ws.on("close", () => {
    logger.info("📴 WebSocket connection closed, cleaning up...");
    if (ws) {
      ws.removeAllListeners();
      ws = null;
    }
    logger.info("🔄 Attempting to reconnect in 5 seconds...");
    setTimeout(websocketHandler, 5000);
  });

  // Handle process termination
  process.on('SIGINT', () => {
    logger.info('Shutting down WebSocket connection...');
    if (ws) {
        ws.close();
        ws.removeAllListeners();
        ws = null;
    }
    process.exit(0);
  });
}

async function main() {
    try {
        // Validate environment variables
        validateEnv();
        
        // Initialize services
        tokenMonitorInstance = new TokenMonitorService();
        const dexAnalyseManager = new AnalyseManagerService();
        
        // Wire services together
        dexAnalyseManager.setTokenMonitor(tokenMonitorInstance);
        
        // Initialize Telegram client
        const telegramClient = new TelegramMonitorService(dexAnalyseManager);
        await telegramClient.initialize();
        
        // Start monitoring for new tokens
        tokenMonitorInstance.startMonitoring();
        
        // Start websocket handler
        await websocketHandler();
        
        // Keep the process running
        process.on('SIGINT', () => {
            logger.info('Shutting down...');
            process.exit(0);
        });
        
        logger.info('Token Sniper Bot started successfully');
        logger.info('Monitoring for new tokens and waiting for signals...');

        // Perform rug checks on specified addresses
        const addressesToCheck = [
            'BBc9zfiSMgqmmTqtFGE1xHzb1XcPzYSLQNLYTVoMpump',
            '713RhkKwaZi2DwdEhCpmgGLfKuYCtrm7qFEzgsCspump',
            'DLviyvDVYKbSrrwddrYbrPZCFaW4ZUgtjzMZZnuUpump'
        ];

        logger.info('Starting rug checks for specified addresses...');
        for (const address of addressesToCheck) {
            try {
                logger.info(`Checking address: ${address}`);
                const isRugCheckPassed = await getRugCheckConfirmed(address);
              if (!isRugCheckPassed) {
                  console.log("🚫 Rug Check not passed! Transaction aborted.");
                  console.log("🟢 Resuming looking for new tokens...\n");
                  
              } else {
                logger.info(`Rug check passed for address: ${address}`);
              }
            } catch (error) {
                logger.error(`Error checking address ${address}:`, error);
            }
        }

    } catch (error) {
        logger.error('Error starting bot:', error);
        process.exit(1);
    }
}

main();