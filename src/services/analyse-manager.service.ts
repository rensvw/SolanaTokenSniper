import { Logger } from '../utils/logger';
import { TokenMonitorService } from './token-monitor.service';

export class AnalyseManagerService {
    private readonly logger = new Logger(AnalyseManagerService.name);
    private readonly solanaAddressRegex = /^[1-9A-HJ-NP-Za-km-z]{44}$/;
    public onTokenReceived: ((tokenAddress: string) => Promise<void>) | undefined;

    private readonly CryptoPumpClubChannelId = '1625691880';
    private readonly CryptoBotTestChannelId = '1629064884';

    private tokenMonitor: TokenMonitorService | null = null;

    setTokenMonitor(monitor: TokenMonitorService): void {
        this.tokenMonitor = monitor;
    }

    async analyseTelegramMessage(message: string, channelId: string, channelName: string): Promise<void> {
        try {
            if (channelId === this.CryptoPumpClubChannelId || channelId === this.CryptoBotTestChannelId) {
                this.logger.log(`Analysing DEX telegram message: ${message} from channelId: ${channelId} and channelName: ${channelName}`);
                
                // Extract token address from message
                const tokenAddress = this.extractTokenAddress(message);
                if (!tokenAddress) {
                    this.logger.info('No token address found in message');
                    return;
                }

                this.logger.info(`Extracted token address: ${tokenAddress} from ${channelName}`);
                
                // Notify token monitor of the correct token
                if (this.tokenMonitor) {
                    this.tokenMonitor.setCorrectToken(tokenAddress);
                }

                // Call the callback function if it exists
                if (this.onTokenReceived) {
                    await this.onTokenReceived(tokenAddress);
                }
            }
        } catch (error) {
            this.logger.error('Error analyzing telegram message:', error);
            throw error;
        }
    }

    async initialize(): Promise<void> {
        try {
            this.logger.log('Initializing DEX analysis manager');
        } catch (error) {
            this.logger.error('Error initializing DEX analysis manager:', error);
            throw error;
        }
    }

    private extractTokenAddress(message: string): string | null {
        // Look for Solana address pattern (base58 string)
        const addressPattern = /[1-9A-HJ-NP-Za-km-z]{32,44}/;
        const match = message.match(addressPattern);
        return match ? match[0] : null;
    }
} 