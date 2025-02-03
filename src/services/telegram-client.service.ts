import { Logger } from '../utils/logger';
import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions';
import { DexAnalyseManagerService } from './dex-analyse-manager.service';

export class TelegramClientService {
    private readonly logger = new Logger(TelegramClientService.name);
    private readonly apiId = 14319953;
    private readonly apiHash = 'b2cd8096f712d0b2ca8f5d87ec23e2d2';
    private readonly stringSession = new StringSession(
        '1BAAOMTQ5LjE1NC4xNjcuOTEAUIKOZBfJn+G7e+2E4AEQnAdVsnY1oVJVjH48pQwRp6n4If0/uHuTn0vYNKTbwjjwvy6oT773NEB+9XeU5YwquTCFD6B/wqgJ756eC5AS2O4xF7718sBy+9DxKVsoV+pKfUrBi01jJA1y5xJUJnU0fl3xVlvYleMLqCeAjKxzAprGifRgUan/gG9TqLZtmkJuCC/ccPAW954mSPf5bZsPz9mCOmadTWyGs+j0B2oRlCbpT/JEwnIOnoaOZOMAeyH7wF2SQaiquHuJR8XlO3BvST9mcz/ANq//bGMYaXZYaxk2FVdKJavS8Gof+uF2pUQxG2Mtp9oJcLXesVOtP3UXrpw=',
    );
    private client: TelegramClient | undefined;
    private channelNames: Map<string, string> = new Map();
    private dexAnalyseManager: DexAnalyseManagerService;

    constructor() {
        this.dexAnalyseManager = new DexAnalyseManagerService();
    }

    async initialize(): Promise<void> {
        this.createClient().then((client) => {
            this.client = client;
            this.client.addEventHandler(this.sendMessage.bind(this));
            this.getSubscribedChannels(this.client);
        });
    }

    private async getSubscribedChannels(client: TelegramClient) {
        const dialogs = await client.getDialogs({});
        const channels = dialogs.filter(dialog => dialog.isChannel);

        channels.forEach(channel => {
            const channelId = channel.id.toString().replace('-100', '');
            this.channelNames.set(channelId, channel.title);
            console.log(`Channel Name: ${channel.title}, Channel ID: ${channelId}`);
        });
    }

    private async createClient(): Promise<TelegramClient> {
        const client = new TelegramClient(
            this.stringSession,
            this.apiId,
            this.apiHash,
            {
                connectionRetries: 5,
                useWSS: true,
            },
        );
        await client.start({
            phoneNumber: async () => '',
            password: async () => '',
            phoneCode: async () => '',
            onError: (err) => console.log(err),
        });
        return client;
    }

    private async sendMessage(event: { message?: { message?: string; peerId: { channelId: unknown; }; }; }) {
        if (!event.message?.message) {
            return;
        }

        const { message, peerId: { channelId } } = event.message;
        const channelName = this.channelNames.get(channelId.toString());

        this.logger.log(`Send analyse message to telegram: ${message} from channelId ${channelId} with channelName ${channelName}`);

        try {
            await this.dexAnalyseManager.analyseTelegramMessage(message, channelId.toString(), channelName || 'Unknown Channel');
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'An unknown error occurred';
            this.logger.error(`Error in sendMessage: ${errorMessage}`);
        }
    }
} 