import { Logger } from '../utils/logger';
import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions';
import { AnalyseManagerService } from './analyse-manager.service';
import { Api } from 'telegram';
import { BigInteger } from 'big-integer';

export class TelegramMonitorService {
    private readonly logger = new Logger(TelegramMonitorService.name);
    private readonly apiId = 14319953;
    private readonly apiHash = 'b2cd8096f712d0b2ca8f5d87ec23e2d2';
    private readonly stringSession = new StringSession(
        '1BAAOMTQ5LjE1NC4xNjcuOTEAUIKOZBfJn+G7e+2E4AEQnAdVsnY1oVJVjH48pQwRp6n4If0/uHuTn0vYNKTbwjjwvy6oT773NEB+9XeU5YwquTCFD6B/wqgJ756eC5AS2O4xF7718sBy+9DxKVsoV+pKfUrBi01jJA1y5xJUJnU0fl3xVlvYleMLqCeAjKxzAprGifRgUan/gG9TqLZtmkJuCC/ccPAW954mSPf5bZsPz9mCOmadTWyGs+j0B2oRlCbpT/JEwnIOnoaOZOMAeyH7wF2SQaiquHuJR8XlO3BvST9mcz/ANq//bGMYaXZYaxk2FVdKJavS8Gof+uF2pUQxG2Mtp9oJcLXesVOtP3UXrpw=',
    );
    private client: TelegramClient | undefined;
    private channelNames: Map<string, string> = new Map();
    private readonly CryptoPumpClubChannelId = '1625691880';
    private readonly CryptoBotTestChannelId = '1629064884';
    private currentDC: number | null = null;

    constructor(private readonly dexAnalyseManager: AnalyseManagerService) {}

    async initialize(): Promise<void> {
        // First determine the optimal DC
        const client = await this.createInitialClient();
        this.client = client;

        // Get the DC for our target channel
        await this.determineOptimalDataCenter();
        
        // If we found a different DC, reconnect to it
        if (this.currentDC && this.currentDC !== this.client.session.dcId) {
            this.logger.info(`Switching to optimal DC ${this.currentDC} for faster connection`);
            await this.reconnectToOptimalDC();
        }

        await this.getSubscribedChannels(this.client);
        this.client.addEventHandler(this.handleNewMessage.bind(this));
        this.logger.log(`Telegram client initialized on DC${this.currentDC || 'unknown'}`);
    }

    private async createInitialClient(): Promise<TelegramClient> {
        const client = new TelegramClient(
            this.stringSession,
            this.apiId,
            this.apiHash,
            {
                connectionRetries: 5,
                useWSS: true,
                // Optimize connection parameters
                maxConcurrentDownloads: 1,
                autoReconnect: true,
                requestRetries: 3,
                timeout: 2000,
            },
        );

        await client.start({
            phoneNumber: async () => '',
            password: async () => '',
            phoneCode: async () => '',
            onError: (err) => this.logger.error("Telegram client error:", err),
        });

        return client;
    }

    private async determineOptimalDataCenter(): Promise<void> {
        try {
            if (!this.client) return;

            // First get dialogs to get the proper access hash
            const dialogs = await this.client.getDialogs({});
            const targetChannel = dialogs.find(dialog => 
                dialog.id?.toString().replace('-100', '') === this.CryptoPumpClubChannelId
            );

            if (!targetChannel?.inputEntity) {
                this.logger.error('Could not find channel in dialogs');
                return;
            }

            // Now we have the proper input entity with correct access hash
            const result = await this.client.invoke(new Api.channels.GetFullChannel({
                channel: targetChannel.inputEntity
            }));

            if (result?.fullChat) {
                const chat = result.chats[0];
                if (chat && 'photo' in chat) {
                    this.currentDC = (chat as any).photo?.dcId || null;
                    if (this.currentDC) {
                        this.logger.info(`Channel is hosted on DC${this.currentDC}`);
                        
                        // Log the physical location of the DC
                        const dcLocation = this.getDataCenterLocation(this.currentDC);
                        this.logger.info(`DC${this.currentDC} is located in ${dcLocation}`);
                    }
                }
            }
        } catch (error) {
            this.logger.error('Error determining optimal DC:', error);
        }
    }

    private async reconnectToOptimalDC(): Promise<void> {
        if (!this.currentDC || !this.client) return;

        try {
            // Transfer authorization to the new DC
            await this.client.connect();
            await this.client._switchDC(this.currentDC);
            await this.client.connect();
        } catch (error) {
            this.logger.error('Error reconnecting to optimal DC:', error);
        }
    }

    private getDataCenterLocation(dcId: number): string {
        // Telegram's main data center locations
        const dcLocations: { [key: number]: string } = {
            1: 'Miami, USA',
            2: 'Amsterdam, Netherlands',
            3: 'Miami, USA',
            4: 'Amsterdam, Netherlands',
            5: 'Singapore'
        };

        return dcLocations[dcId] || 'Unknown Location';
    }

    private async getSubscribedChannels(client: TelegramClient) {
        const dialogs = await client.getDialogs({});
        const channels = dialogs.filter(dialog => dialog.isChannel);

        this.logger.info('=== Channel Locations ===');
        
        for (const channel of channels) {
            const channelId = channel.id?.toString().replace('-100', '') || '';
            this.channelNames.set(channelId, channel.title || '');
            
            // try {
            //     if (channel.inputEntity) {
            //         const result = await client.invoke(new Api.channels.GetFullChannel({
            //             channel: channel.inputEntity
            //         }));

            //         if (result?.chats?.[0] && 'photo' in result.chats[0]) {
            //             const dcId = (result.chats[0] as any).photo?.dcId;
            //             if (dcId) {
            //                 const location = this.getDataCenterLocation(dcId);
            //                 this.logger.info(`Channel: ${channel.title}`);
            //                 this.logger.info(`├── ID: ${channelId}`);
            //                 this.logger.info(`├── DC: ${dcId}`);
            //                 this.logger.info(`└── Location: ${location}\n`);
            //             }
            //         }
            //     }
            // } catch (error) {
            //     this.logger.error(`Could not get DC info for channel ${channel.title}:`, error);
            // }
        }
        
        this.logger.info('=====================');
    }

    private async handleNewMessage(event: { message?: { message?: string; peerId: { channelId: unknown; }; }; }) {
        if (!event.message?.message) {
            return;
        }

        const { message, peerId: { channelId } } = event.message;
        const channelName = this.channelNames.get(channelId?.toString() || '');
        
        if (channelId?.toString() === this.CryptoPumpClubChannelId || channelId?.toString() === this.CryptoBotTestChannelId) {
            this.logger.info(`Received message from ${channelName} (${channelId})`);
            this.logger.info(`Message content: ${message}`);

            try {
                await this.dexAnalyseManager.analyseTelegramMessage(message, channelId?.toString() || '', channelName || 'Unknown Channel');
            } catch (error) {
                const errorMessage = error instanceof Error ? error.message : 'An unknown error occurred';
                this.logger.error(`Error processing message:`, errorMessage);
            }
        }
    }

    async getLatestChannelMessages(): Promise<void> {
        if (!this.client) {
            this.logger.error('Telegram client not initialized');
            return;
        }

        // try {
        //     const messages = await this.client.getMessages(parseInt(this.CryptoPumpClubChannelId), {
        //         limit: 200
        //     });

        //     messages.forEach(message => {
        //         if (message.date) {
        //             const timestamp = new Date(message.date * 1000).toISOString();
        //             this.logger.info(`Message timestamp: ${timestamp}`);
        //             if (message.message) {
        //                 this.logger.info(`Message content: ${message.message.substring(0, 100)}...\n`);
        //             }
        //         }
        //     });

        //     this.logger.info(`Retrieved ${messages.length} messages from CryptoPumpClub channel`);
        // } catch (error) {
        //     const errorMessage = error instanceof Error ? error.message : 'An unknown error occurred';
        //     this.logger.error('Error fetching channel messages:', errorMessage);
        // }
    }
} 