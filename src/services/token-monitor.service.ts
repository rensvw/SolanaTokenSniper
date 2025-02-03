import WebSocket from 'ws';
import { Logger } from '../utils/logger';
import { DateTime } from 'luxon';
import axios from 'axios';
import { config } from '../config';
import { WebSocketRequest } from '../types';
import { createSwapTransaction, getRugCheckConfirmed } from '../transactions';

export class TokenMonitorService {
    private readonly logger = new Logger(TokenMonitorService.name);
    private activeTokens: Map<string, { timestamp: number, price: number, lastCheck: number }> = new Map();
    private correctToken: string | null = null;
    private isWithinTimeWindow = false;
    private monitoringInterval: NodeJS.Timeout | null = null;
    private priceCheckInterval: NodeJS.Timeout | null = null;

    constructor() {}

    public startMonitoring(): void {
        this.logger.info('Starting token monitoring service');
        
        // Start checking time window
        this.checkTimeWindow();
        this.monitoringInterval = setInterval(() => this.checkTimeWindow(), 1000);
        
        // Start price monitoring (runs every second but only processes during time window)
        this.priceCheckInterval = setInterval(() => this.checkAllTokenPrices(), 1000);
    }

    public stopMonitoring(): void {
        if (this.monitoringInterval) {
            clearInterval(this.monitoringInterval);
            this.monitoringInterval = null;
        }
        if (this.priceCheckInterval) {
            clearInterval(this.priceCheckInterval);
            this.priceCheckInterval = null;
        }
    }

    private checkTimeWindow(): void {
        const now = DateTime.now().setZone('GMT');
        const targetHour = 5; // 5 GMT
        
        // Check if we're within the 2-second window
        const startTime = now.set({ hour: targetHour, minute: 0, second: 0, millisecond: 0 });
        const endTime = startTime.plus({ seconds: 2 });
        
        const wasWithinWindow = this.isWithinTimeWindow;
        this.isWithinTimeWindow = now >= startTime && now <= endTime;
        
        // Log when we enter/exit the time window
        if (this.isWithinTimeWindow !== wasWithinWindow) {
            if (this.isWithinTimeWindow) {
                this.logger.info('Entered monitoring time window');
            } else {
                this.logger.info('Exited monitoring time window');
            }
        }
    }

    public async handleNewTokenFromWebsocket(tokenData: any): Promise<void> {
        await this.handleNewToken(tokenData);
    }

    private async checkAllTokenPrices(): Promise<void> {
        if (!this.isWithinTimeWindow) return;

        const now = Date.now();
        const thirtyMinutesAgo = now - (30 * 60 * 1000);

        // Check all tokens that were created in the last 30 minutes
        for (const [tokenAddress, data] of this.activeTokens.entries()) {
            if (data.timestamp < thirtyMinutesAgo) {
                // Remove tokens older than 30 minutes
                this.activeTokens.delete(tokenAddress);
                continue;
            }

            // Only check price every second
            if (now - data.lastCheck < 1000) continue;

            await this.checkTokenPrice(tokenAddress);
        }
    }

    private async checkTokenPrice(tokenAddress: string): Promise<void> {
        try {
            const response = await axios.get(`${process.env.JUP_HTTPS_PRICE_URI}`, {
                params: {
                    ids: tokenAddress
                }
            });

            const price = response.data?.data?.[tokenAddress]?.price;
            if (!price) return;

            const tokenData = this.activeTokens.get(tokenAddress);
            if (!tokenData) return;

            // Update last check time
            tokenData.lastCheck = Date.now();

            // Calculate price increase
            const priceIncrease = ((price - tokenData.price) / tokenData.price) * 100;

            if (priceIncrease > 200) { // 200% increase threshold - adjust as needed
                await this.buyToken(tokenAddress);
            }

            // Update stored price
            tokenData.price = price;
            this.activeTokens.set(tokenAddress, tokenData);

        } catch (error) {
            this.logger.error(`Error checking price for token ${tokenAddress}:`, error);
        }
    }

    private async handleNewToken(tokenData: any): Promise<void> {
        const tokenAddress = tokenData.mint;
        if (!tokenAddress) return;

        // Check if we're already tracking this token
        if (this.activeTokens.has(tokenAddress)) return;

        // Check if token was created in last 30 minutes
        const creationTime = await this.getTokenCreationTime(tokenAddress);
        if (!creationTime) return;

        const thirtyMinutesAgo = Date.now() - (30 * 60 * 1000);
        if (creationTime < thirtyMinutesAgo) return;

        // Check if developer has sold their tokens
        const hasDevSold = await this.checkDevSold(tokenAddress);
        if (!hasDevSold) {
            this.logger.info(`Token ${tokenAddress} skipped: Developer hasn't sold yet`);
            return;
        }

        // Run rugcheck
        const rugcheck = await getRugCheckConfirmed(tokenAddress);
        if (!this.isTokenSafe(rugcheck)) {
            this.logger.info(`Token ${tokenAddress} skipped: Failed rugcheck`);
            return;
        }

        // Get initial price
        try {
            const response = await axios.get(`${process.env.JUP_HTTPS_PRICE_URI}`, {
                params: {
                    ids: tokenAddress
                }
            });

            const price = response.data?.data?.[tokenAddress]?.price;
            if (!price) {
                this.logger.info(`Token ${tokenAddress} skipped: No price data available`);
                return;
            }

            // Start tracking the token
            this.activeTokens.set(tokenAddress, {
                timestamp: Date.now(),
                price,
                lastCheck: Date.now()
            });

            const watchlistCount = this.activeTokens.size;
            this.logger.info(`Added token ${tokenAddress} to watchlist (Price: ${price} USDC)`);
            this.logger.info(`Current watchlist size: ${watchlistCount} tokens`);
            
            // Log all tokens in watchlist
            this.logger.info('Current watchlist:');
            for (const [address, data] of this.activeTokens.entries()) {
                const ageInMinutes = Math.round((Date.now() - data.timestamp) / 60000);
                this.logger.info(`- ${address} (Age: ${ageInMinutes}m, Initial Price: ${data.price} USDC)`);
            }
        } catch (error) {
            this.logger.error('Error getting initial price:', error);
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
            // Query token transfers to check if developer has sold
            const response = await axios.post(process.env.HELIUS_HTTPS_URI_TX || '', {
                query: {
                    accounts: [tokenAddress],
                    startSlot: 0,
                    types: ['TOKEN_TRANSFER']
                }
            });

            // Analyze transfers to determine if dev has sold
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
            // Pass null for solMint to use the default WSOL mint from the pool
            await createSwapTransaction(null, tokenAddress);
            this.logger.success(`Bought token ${tokenAddress}`);
        } catch (error) {
            this.logger.error('Error buying token:', error);
        }
    }

    public setCorrectToken(tokenAddress: string): void {
        this.logger.info(`Setting correct token: ${tokenAddress}`);
        this.correctToken = tokenAddress;
        this.handleCorrectTokenAnnouncement();
    }

    private async handleCorrectTokenAnnouncement(): Promise<void> {
        // Sell all tokens except the correct one
        for (const [tokenAddress] of this.activeTokens) {
            if (tokenAddress !== this.correctToken) {
                try {
                    // Sell incorrect token using WSOL mint
                    await createSwapTransaction(tokenAddress, config.liquidity_pool.wsol_pc_mint);
                    this.logger.info(`Sold incorrect token ${tokenAddress}`);
                    this.activeTokens.delete(tokenAddress);
                } catch (error) {
                    this.logger.error(`Error selling token ${tokenAddress}:`, error);
                }
            }
        }

        // If we haven't bought the correct token yet, buy it
        if (this.correctToken && !this.activeTokens.has(this.correctToken)) {
            await this.buyToken(this.correctToken);
        }
    }
}