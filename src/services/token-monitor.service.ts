import WebSocket from 'ws';
import { Logger } from '../utils/logger';
import { DateTime } from 'luxon';
import axios from 'axios';
import { config } from '../config';
import { WebSocketRequest } from '../types';
import { createSwapTransaction, getRugCheckConfirmed } from '../transactions';
import { DatabaseService, TokenTrack } from './database.service';
import { sleep } from 'telegram/Helpers';

export class TokenMonitorService {
    private logger: Logger;
    private dbService: DatabaseService;
    private monitoringInterval: NodeJS.Timeout | null = null;
    private readonly CLEANUP_INTERVAL = 24 * 60 * 60 * 1000; // 24 hours
    private readonly TOKEN_MAX_AGE_HOURS = 72; // 3 days

    constructor() {
        this.logger = new Logger('TokenMonitorService');
        this.dbService = DatabaseService.getInstance();
    }

    async initialize(): Promise<void> {
        this.logger.info('Initializing TokenMonitorService...');
        await this.dbService.initialize();
        this.startCleanupInterval();
        this.logger.info('TokenMonitorService initialized successfully');
    }

    private startCleanupInterval(): void {
        this.logger.info(`Setting up cleanup interval for every ${this.CLEANUP_INTERVAL / (60 * 60 * 1000)} hours`);
        setInterval(() => {
            this.logger.info(`Running cleanup for tokens older than ${this.TOKEN_MAX_AGE_HOURS} hours`);
            this.dbService.cleanupOldTokens(this.TOKEN_MAX_AGE_HOURS)
                .then(() => this.logger.info('Cleanup completed successfully'))
                .catch(error => this.logger.error('Failed to cleanup old tokens:', error));
        }, this.CLEANUP_INTERVAL);
    }

    async startMonitoring(): Promise<void> {
        if (this.monitoringInterval) {
            this.logger.warn('Monitoring is already running');
            return;
        }

        this.logger.info('Starting token monitoring service...');
        this.monitoringInterval = setInterval(async () => {
            try {
                const activeTokens = await this.dbService.getActiveTokens();
                this.logger.info(`Checking ${activeTokens.length} active tokens`);
                
                for (const token of activeTokens) {
                    this.logger.info(`Processing token: ${token.tokenAddress} (Last price: ${token.price})`);
                    await this.checkToken(token);
                    this.logger.info(`Waiting 600ms before next token check`);
                    await sleep(600);
                }
            } catch (error) {
                this.logger.error('Error during token monitoring:', error);
            }
        }, 10000); // Check every 10 seconds
        this.logger.info('Token monitoring started successfully');
    }

    async stopMonitoring(): Promise<void> {
        if (this.monitoringInterval) {
            clearInterval(this.monitoringInterval);
            this.monitoringInterval = null;
        }
    }

    async addToken(tokenAddress: string, price: number, name?: string, totalSupply?: number, marketCap?: number): Promise<void> {
        const token: TokenTrack = {
            tokenAddress,
            timestamp: Date.now(),
            price,
            lastCheck: Date.now(),
            status: 'active',
            name,
            totalSupply,
            marketCap
        };

        await this.dbService.addToken(token);
        this.logger.info(`Added new token to monitor: ${tokenAddress}${name ? ` (${name})` : ''}`);
    }

    private async checkToken(token: TokenTrack): Promise<void> {
        try {
            this.logger.info(`Checking current price for token ${token.tokenAddress}...`);
            const currentPrice = await this.getCurrentPrice(token.tokenAddress);
            
            if (currentPrice !== null) {
                this.logger.info(`Current price for ${token.tokenAddress}: ${currentPrice} (Previous: ${token.price})`);
                await this.dbService.updateTokenPrice(token.tokenAddress, currentPrice);

                // Calculate price increase
                const priceIncrease = ((currentPrice - token.price) / token.price) * 100;
                this.logger.info(`Price change for ${token.tokenAddress}: ${priceIncrease.toFixed(2)}%`);
                
                if (priceIncrease > 200) {
                    this.logger.info(`Price increase threshold met (${priceIncrease.toFixed(2)}% > 200%), initiating buy...`);
                    await this.buyToken(token.tokenAddress);
                }
            } else {
                this.logger.warn(`Could not fetch current price for token ${token.tokenAddress}`);
            }

            // Check if dev has sold
            this.logger.info(`Checking if dev has sold for token ${token.tokenAddress}...`);
            const devSold = await this.checkDevSold(token.tokenAddress);
            if (devSold) {
                this.logger.warn(`Developer sold tokens for ${token.tokenAddress}, marking as inactive`);
                await this.dbService.updateTokenStatus(token.tokenAddress, 'inactive');
            } else {
                this.logger.info(`No developer sales detected for ${token.tokenAddress}`);
            }
        } catch (error) {
            this.logger.error(`Error checking token ${token.tokenAddress}:`, error);
        }
    }

    private async getCurrentPrice(tokenAddress: string): Promise<number | null> {
        try {
            const response = await axios.get(`${process.env.JUP_HTTPS_PRICE_URI}`, {
                params: {
                    ids: tokenAddress
                }
            });

            return response.data?.data?.[tokenAddress]?.price || null;
        } catch (error) {
            this.logger.error(`Error fetching price for token ${tokenAddress}:`, error);
            return null;
        }
    }

    async handleNewTokenFromWebsocket(txDetails: any): Promise<void> {
        try {
            if (!txDetails || !txDetails.mint) {
                this.logger.error('Invalid transaction details received');
                return;
            }

            // Check if token already exists
            const existingToken = await this.dbService.getToken(txDetails.mint);
            if (existingToken) {
                this.logger.info(`Token ${txDetails.mint} already being monitored`);
                return;
            }

            // Perform rug check with error handling
            try {
                const isRugCheckPassed = await getRugCheckConfirmed(txDetails.mint);
                if (!isRugCheckPassed) {
                    this.logger.warn("🚫 Rug Check not passed! Token not added.");
                    return;
                }
                this.logger.info(`✅ Rug check passed for token ${txDetails.mint}`);
            } catch (rugCheckError) {
                this.logger.error(`Failed to perform rug check for token ${txDetails.mint}:`, rugCheckError);
                return; // Skip token if rug check fails
            }

            // Fetch token metadata from Helius
            let tokenName = "Unknown";
            let totalSupply = 0;
            try {
                const metadataResponse = await axios.get(`${process.env.HELIUS_HTTPS_URI}/v0/tokens/${txDetails.mint}`);
                tokenName = metadataResponse.data.name || "Unknown";
                totalSupply = metadataResponse.data.supply || 0;
            } catch (error) {
                this.logger.error(`Failed to fetch token metadata for ${txDetails.mint}:`, error);
            }

            // Get current price and calculate market cap
            const currentPrice = await this.getCurrentPrice(txDetails.mint);
            if (currentPrice !== null) {
                const marketCap = currentPrice * totalSupply;
                
                // Add token with all metadata
                await this.addToken(txDetails.mint, currentPrice, tokenName, totalSupply, marketCap);
                
                // Log token information and trading links
                this.logger.success(`New token detected! 🚀`);
                this.logger.info(`Token Name: ${tokenName}`);
                this.logger.info(`Address: ${txDetails.mint}`);
                this.logger.info(`Price: $${currentPrice.toFixed(6)}`);
                this.logger.info(`Total Supply: ${totalSupply.toLocaleString()}`);
                this.logger.info(`Market Cap: $${marketCap.toLocaleString()}`);
                
                // Trading links
                this.logger.info("\n📊 Trading Links:");
                this.logger.info("👽 GMGN: https://gmgn.ai/sol/token/" + txDetails.mint);
                this.logger.info("😈 BullX: https://neo.bullx.io/terminal?chainId=1399811149&address=" + txDetails.mint);
                this.logger.info("🦊 Raydium: https://raydium.io/swap/?inputCurrency=sol&outputCurrency=" + txDetails.mint);
                this.logger.info("🌟 Solscan: https://solscan.io/token/" + txDetails.mint);
                this.logger.info("🔍 Birdeye: https://birdeye.so/token/" + txDetails.mint + "?chain=solana\n");
            } else {
                this.logger.error(`Could not fetch price for token ${txDetails.mint}`);
            }
        } catch (error) {
            this.logger.error('Error handling new token from websocket:', error);
        }
    }

    private async getTokenCreationTime(tokenAddress: string): Promise<number | null> {
        try {
            const response = await axios.get(`${process.env.HELIUS_HTTPS_URI}/v0/tokens/${tokenAddress}`);
            return response.data.timestamp;
        } catch (error) {
            this.logger.error('Error getting token creation time:', error);
            return null;
        }
    }

    private async checkDevSold(tokenAddress: string): Promise<boolean> {
        try {
            const response = await axios.post(process.env.HELIUS_HTTPS_URI_TX || '', {
                query: {
                    accounts: [tokenAddress],
                    startSlot: 0,
                    types: ['TOKEN_TRANSFER']
                }
            });

            return response.data.some((tx: any) => 
                tx.tokenTransfers?.some((transfer: any) => 
                    transfer.fromUserAccount === tx.feePayer && 
                    transfer.tokenAmount > 0
                )
            );
        } catch (error) {
            this.logger.error('Error checking dev sales:', error);
            return false;
        }
    }

    private isTokenSafe(rugcheck: any): boolean {
        return !rugcheck.rugged &&
            (!rugcheck.mintAuthority || config.rug_check.allow_mint_authority) &&
            (!rugcheck.freezeAuthority || config.rug_check.allow_freeze_authority) &&
            (!rugcheck.mutable || config.rug_check.allow_mutable);
    }

    private async buyToken(tokenAddress: string): Promise<void> {
        try {
            await createSwapTransaction(null, tokenAddress);
            this.logger.success(`Bought token ${tokenAddress}`);
        } catch (error) {
            this.logger.error('Error buying token:', error);
        }
    }

    public async setCorrectToken(tokenAddress: string): Promise<void> {
        this.logger.info(`Setting correct token: ${tokenAddress}`);
        
        // Get all active tokens
        const activeTokens = await this.dbService.getActiveTokens();
        this.logger.info(`Found ${activeTokens.length} active tokens`);
        
        // Sell all tokens except the correct one
        for (const token of activeTokens) {
            if (token.tokenAddress !== tokenAddress) {
                try {
                    this.logger.info(`Attempting to sell incorrect token ${token.tokenAddress}`);
                    // Sell incorrect token using WSOL mint
                    await createSwapTransaction(token.tokenAddress, config.liquidity_pool.wsol_pc_mint);
                    this.logger.info(`Successfully sold incorrect token ${token.tokenAddress}`);
                    await this.dbService.updateTokenStatus(token.tokenAddress, 'inactive');
                } catch (error) {
                    this.logger.error(`Error selling token ${token.tokenAddress}:`, error);
                }
            } else {
                this.logger.info(`Keeping correct token ${token.tokenAddress}`);
            }
        }

        // If we haven't bought the correct token yet, buy it
        const correctToken = await this.dbService.getToken(tokenAddress);
        if (!correctToken) {
            this.logger.info(`Correct token ${tokenAddress} not yet bought, initiating purchase...`);
            
            // Fetch token metadata
            let tokenName = "Unknown";
            let totalSupply = 0;
            try {
                const metadataResponse = await axios.get(`${process.env.HELIUS_HTTPS_URI}/v0/tokens/${tokenAddress}`);
                tokenName = metadataResponse.data.name || "Unknown";
                totalSupply = metadataResponse.data.supply || 0;
            } catch (error) {
                this.logger.error(`Failed to fetch token metadata for ${tokenAddress}:`, error);
            }

            const currentPrice = await this.getCurrentPrice(tokenAddress);
            if (currentPrice !== null) {
                const marketCap = currentPrice * totalSupply;
                this.logger.info(`Adding token ${tokenAddress} (${tokenName}) to monitor at price ${currentPrice}`);
                await this.addToken(tokenAddress, currentPrice, tokenName, totalSupply, marketCap);
                await this.buyToken(tokenAddress);

                // Display trading links
                this.logger.info("\n📊 Trading Links for correct token:");
                this.logger.info("👽 GMGN: https://gmgn.ai/sol/token/" + tokenAddress);
                this.logger.info("😈 BullX: https://neo.bullx.io/terminal?chainId=1399811149&address=" + tokenAddress);
                this.logger.info("🦊 Raydium: https://raydium.io/swap/?inputCurrency=sol&outputCurrency=" + tokenAddress);
                this.logger.info("🌟 Solscan: https://solscan.io/token/" + tokenAddress);
                this.logger.info("🔍 Birdeye: https://birdeye.so/token/" + tokenAddress + "?chain=solana\n");
            } else {
                this.logger.warn(`Could not get current price for token ${tokenAddress}, skipping purchase`);
            }
        } else {
            this.logger.info(`Correct token ${tokenAddress} already being monitored`);
        }
    }
}