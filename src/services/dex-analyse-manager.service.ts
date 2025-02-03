import { Logger } from '../utils/logger';

export class DexAnalyseManagerService {
    private readonly logger = new Logger(DexAnalyseManagerService.name);
    private readonly solanaAddressRegex = /^[1-9A-HJ-NP-Za-km-z]{44}$/;
    public onTokenReceived: ((tokenAddress: string) => Promise<void>) | undefined;

    private readonly CryptoPumpClubChannelId = '1625691880';
    private readonly CryptoBotTestChannelId = '1629064884';

    async analyseTelegramMessage(message: string, channelId: string, channelName: string): Promise<void> {
        try {
            if (channelId === this.CryptoPumpClubChannelId || channelId === this.CryptoBotTestChannelId) {
                this.logger.log(`Analysing DEX telegram message: ${message} from channelId: ${channelId} and channelName: ${channelName}`);
                
                // Extract token address from message
                const tokenAddress = this.extractSolanaAddress(message);
                if (!tokenAddress) {
                    this.logger.warn('No token address found in message');
                    return;
                }

                this.logger.log(`Token address found: ${tokenAddress}`);

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

    private extractSolanaAddress(message: string): string | null {
        const lines = message.split('\n');
      
        for (const line of lines) {
            const trimmedLine = line.trim();
            if (this.solanaAddressRegex.test(trimmedLine)) {
                return trimmedLine;
            }
        }
      
        return null;
    }
} 