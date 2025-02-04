import axios from "axios";

const RAYDIUM_PROGRAM_ID = "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8";
const HELIUS_API_KEY = "YOUR_API_KEY";

function getFiveHoursAgo() {
  const now = Math.floor(Date.now() / 1000);
  return now - 5 * 60 * 60;
}

async function fetchRecentRaydiumTxs() {
  const endpoint = `https://api.helius.xyz/v0/addresses/transactions?api-key=${HELIUS_API_KEY}`;

  // First batch
  let txs: any[] = [];
  let done = false;
  let beforeSignature: string | undefined = undefined;
  const fiveHoursAgo = getFiveHoursAgo();

  while (!done) {
    // Build request body
    const body: any = {
      addresses: [RAYDIUM_PROGRAM_ID],
      limit: 1000,
    };
    if (beforeSignature) {
      body.before = beforeSignature;
    }

    const { data } = await axios.post(endpoint, body);

    if (!Array.isArray(data) || data.length === 0) {
      // No more transactions
      break;
    }

    // Filter in-code by blockTime
    const relevantTxs = data.filter((tx: any) => tx.blockTime >= fiveHoursAgo);
    txs = txs.concat(relevantTxs);

    // Check if the oldest transaction is still within the 5-hour window
    const oldestTx = data[data.length - 1];
    if (!oldestTx || oldestTx.blockTime < fiveHoursAgo) {
      // We’ve gone past 5 hours
      done = true;
    } else {
      // Prepare for next batch
      beforeSignature = oldestTx.signature;
    }
  }

  return txs;
}

(async () => {
  try {
    const raydiumTxs = await fetchRecentRaydiumTxs();
    console.log(`Total txs in last 5 hours: ${raydiumTxs.length}`);

    // Now parse the instructions/logs to identify pool creation
    for (const tx of raydiumTxs) {
      const logs = tx.meta?.logMessages || [];
      const signature = tx.signature;

      const isPoolCreation = logs.some((log: string) =>
        log.includes("Program log: initialize2: InitializeInstruction2")
      );

      if (isPoolCreation) {
        console.log(`Found potential pool creation at signature: ${signature}`);
        // ...
      }
    }
  } catch (err) {
    console.error("Error fetching Raydium txs:", err);
  }
})();