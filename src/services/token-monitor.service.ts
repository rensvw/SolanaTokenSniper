import WebSocket from 'ws';
import { Logger } from '../utils/logger';
import { DateTime } from 'luxon';
import axios from 'axios';
import { config } from '../config';
import { WebSocketRequest } from '../types';
import { createSwapTransaction, getRugCheckConfirmed } from '../transactions';
import { DatabaseService, TokenTrack } from './database.service';

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
        await this.dbService.initialize();
        this.startCleanupInterval();
    }

    private startCleanupInterval(): void {
        setInterval(() => {
            this.dbService.cleanupOldTokens(this.TOKEN_MAX_AGE_HOURS)
                .catch(error => this.logger.error('Failed to cleanup old tokens:', error));
        }, this.CLEANUP_INTERVAL);
    }

    async startMonitoring(): Promise<void> {
        if (this.monitoringInterval) {
            this.logger.warn('Monitoring is already running');
            return;
        }

        this.monitoringInterval = setInterval(async () => {
            try {
                const activeTokens = await this.dbService.getActiveTokens();
                for (const token of activeTokens) {
                    await this.checkToken(token);
                }
            } catch (error) {
                this.logger.error('Error during token monitoring:', error);
            }
        }, 10000); // Check every 10 seconds
    }

    async stopMonitoring(): Promise<void> {
        if (this.monitoringInterval) {
            clearInterval(this.monitoringInterval);
            this.monitoringInterval = null;
        }
    }

    async addToken(tokenAddress: string, price: number): Promise<void> {
        const token: TokenTrack = {
            tokenAddress,
            timestamp: Date.now(),
            price,
            lastCheck: Date.now(),
            status: 'active'
        };

        await this.dbService.addToken(token);
        this.logger.info(`Added new token to monitor: ${tokenAddress}`);
    }

    private async checkToken(token: TokenTrack): Promise<void> {
        try {
            const currentPrice = await this.getCurrentPrice(token.tokenAddress);
            if (currentPrice !== null) {
                await this.dbService.updateTokenPrice(token.tokenAddress, currentPrice);

                // Calculate price increase
                const priceIncrease = ((currentPrice - token.price) / token.price) * 100;
                if (priceIncrease > 200) { // 200% increase threshold
                    await this.buyToken(token.tokenAddress);
                }
            }

            // Check if dev has sold
            const devSold = await this.checkDevSold(token.tokenAddress);
            if (devSold) {
                await this.dbService.updateTokenStatus(token.tokenAddress, 'inactive');
                this.logger.warn(`Developer sold tokens for ${token.tokenAddress}, marking as inactive`);
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

            const currentPrice = await this.getCurrentPrice(txDetails.mint);
            if (currentPrice !== null) {
                await this.addToken(txDetails.mint, currentPrice);
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
        
        // Sell all tokens except the correct one
        for (const token of activeTokens) {
            if (token.tokenAddress !== tokenAddress) {
                try {
                    // Sell incorrect token using WSOL mint
                    await createSwapTransaction(token.tokenAddress, config.liquidity_pool.wsol_pc_mint);
                    this.logger.info(`Sold incorrect token ${token.tokenAddress}`);
                    await this.dbService.updateTokenStatus(token.tokenAddress, 'inactive');
                } catch (error) {
                    this.logger.error(`Error selling token ${token.tokenAddress}:`, error);
                }
            }
        }

        // If we haven't bought the correct token yet, buy it
        const correctToken = await this.dbService.getToken(tokenAddress);
        if (!correctToken) {
            const currentPrice = await this.getCurrentPrice(tokenAddress);
            if (currentPrice !== null) {
                await this.addToken(tokenAddress, currentPrice);
                await this.buyToken(tokenAddress);
            }
        }
    }
}