import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import { Logger } from '../utils/logger';

const logger = new Logger('DatabaseService');

export interface TokenTrack {
    tokenAddress: string;
    timestamp: number;
    price: number;
    lastCheck: number;
    status: 'active' | 'inactive';
}

export class DatabaseService {
    private db: any;
    private static instance: DatabaseService;

    private constructor() {}

    static getInstance(): DatabaseService {
        if (!DatabaseService.instance) {
            DatabaseService.instance = new DatabaseService();
        }
        return DatabaseService.instance;
    }

    async initialize(): Promise<void> {
        try {
            this.db = await open({
                filename: 'tokens.db',
                driver: sqlite3.Database
            });

            await this.createTables();
            logger.info('Database initialized successfully');
        } catch (error) {
            logger.error('Failed to initialize database:', error);
            throw error;
        }
    }

    private async createTables(): Promise<void> {
        await this.db.exec(`
            CREATE TABLE IF NOT EXISTS tokens (
                tokenAddress TEXT PRIMARY KEY,
                timestamp INTEGER NOT NULL,
                price REAL NOT NULL,
                lastCheck INTEGER NOT NULL,
                status TEXT NOT NULL CHECK(status IN ('active', 'inactive'))
            );

            CREATE INDEX IF NOT EXISTS idx_tokens_status ON tokens(status);
            CREATE INDEX IF NOT EXISTS idx_tokens_lastCheck ON tokens(lastCheck);
        `);
    }

    async addToken(token: TokenTrack): Promise<void> {
        try {
            await this.db.run(
                `INSERT OR REPLACE INTO tokens (tokenAddress, timestamp, price, lastCheck, status)
                 VALUES (?, ?, ?, ?, ?)`,
                [token.tokenAddress, token.timestamp, token.price, token.lastCheck, token.status]
            );
        } catch (error) {
            logger.error(`Failed to add token ${token.tokenAddress}:`, error);
            throw error;
        }
    }

    async getToken(tokenAddress: string): Promise<TokenTrack | null> {
        try {
            const token = await this.db.get(
                'SELECT * FROM tokens WHERE tokenAddress = ?',
                [tokenAddress]
            );
            return token || null;
        } catch (error) {
            logger.error(`Failed to get token ${tokenAddress}:`, error);
            throw error;
        }
    }

    async updateTokenStatus(tokenAddress: string, status: 'active' | 'inactive'): Promise<void> {
        try {
            await this.db.run(
                'UPDATE tokens SET status = ?, lastCheck = ? WHERE tokenAddress = ?',
                [status, Date.now(), tokenAddress]
            );
        } catch (error) {
            logger.error(`Failed to update token status ${tokenAddress}:`, error);
            throw error;
        }
    }

    async updateTokenPrice(tokenAddress: string, price: number): Promise<void> {
        try {
            await this.db.run(
                'UPDATE tokens SET price = ?, lastCheck = ? WHERE tokenAddress = ?',
                [price, Date.now(), tokenAddress]
            );
        } catch (error) {
            logger.error(`Failed to update token price ${tokenAddress}:`, error);
            throw error;
        }
    }

    async getActiveTokens(): Promise<TokenTrack[]> {
        try {
            return await this.db.all('SELECT * FROM tokens WHERE status = ?', ['active']);
        } catch (error) {
            logger.error('Failed to get active tokens:', error);
            throw error;
        }
    }

    async cleanupOldTokens(maxAgeHours: number): Promise<void> {
        const cutoffTime = Date.now() - (maxAgeHours * 60 * 60 * 1000);
        try {
            await this.db.run(
                'DELETE FROM tokens WHERE lastCheck < ? AND status = ?',
                [cutoffTime, 'inactive']
            );
        } catch (error) {
            logger.error('Failed to cleanup old tokens:', error);
            throw error;
        }
    }
} 