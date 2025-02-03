import { config } from "./config"; // Configuration parameters for our bot
import { fetchTransactionDetails, createSwapTransaction, getRugCheckConfirmed, fetchAndSaveSwapDetails } from "./transactions";
import { validateEnv } from "./utils/env-validator";
import { TelegramClientService } from "./services/telegram-client.service";
import { DexAnalyseManagerService } from "./services/dex-analyse-manager.service";

// Regional Variables
let activeTransactions = 0;
const MAX_CONCURRENT = config.tx.concurrent_transactions;

// Update the processTransaction function
async function processTransaction(tokenAddress: string): Promise<void> {
  // Output logs
  console.log("=============================================");
  console.log("🔎 New Token Signal Received");
  console.log("🔃 Processing token...");

  // Ensure required data is available
  if (!tokenAddress) return;

  // Output logs
  console.log("Token found");
  console.log("👽 GMGN: https://gmgn.ai/sol/token/" + tokenAddress);
  console.log("😈 BullX: https://neo.bullx.io/terminal?chainId=1399811149&address=" + tokenAddress);

  // Check if simulation mode is enabled
  if (config.rug_check.simulation_mode) {
    console.log("👀 Token not swapped. Simulation mode is enabled.");
    console.log("🟢 Resuming looking for new tokens..\n");
    return;
  }

  // Add initial delay before first buy
  await new Promise((resolve) => setTimeout(resolve, config.tx.swap_tx_initial_delay));

  // Create Swap transaction
  const tx = await createSwapTransaction(null, tokenAddress); // Pass null for solMint as we'll get it from the pool
  if (!tx) {
    console.log("⛔ Transaction aborted.");
    console.log("🟢 Resuming looking for new tokens...\n");
    return;
  }
  
  // Output logs
  console.log("🚀 Swapping SOL for Token.");
  console.log("Swap Transaction: ", "https://solscan.io/tx/" + tx);

  // Fetch and store the transaction for tracking purposes
  const saveConfirmation = await fetchAndSaveSwapDetails(tx);
  if (!saveConfirmation) {
    console.log("❌ Warning: Transaction not saved for tracking! Track Manually!");
  }
}

// Replace websocketHandler with telegramHandler
async function initializeTelegramHandler(): Promise<void> {
  // Load environment variables from the .env file
  const env = validateEnv();

  const telegramService = new TelegramClientService();
  const dexAnalyseManager = new DexAnalyseManagerService();

  // Initialize the DexAnalyseManager with a callback for processing transactions
  dexAnalyseManager.onTokenReceived = async (tokenAddress: string) => {
    try {
      // Verify if we have reached the max concurrent transactions
      if (activeTransactions >= MAX_CONCURRENT) {
        console.log("⏳ Max concurrent transactions reached, skipping...");
        return;
      }

      // Add additional concurrent transaction
      activeTransactions++;

      // Process transaction asynchronously
      await processTransaction(tokenAddress)
        .catch((error) => {
          console.error("Error processing transaction:", error);
        })
        .finally(() => {
          activeTransactions--;
        });
    } catch (error) {
      console.error("💥 Error processing message:", {
        error: error instanceof Error ? error.message : "Unknown error",
        timestamp: new Date().toISOString(),
      });
    }
  };

  await telegramService.initialize();
  await dexAnalyseManager.initialize();
}

// Start Telegram Handler
initializeTelegramHandler().catch((err) => {
  console.error(err.message);
});
