export class Logger {
    constructor(private context: string) {}

    log(message: string): void {
        console.log(`[${this.context}] ${message}`);
    }

    error(message: string, error?: any): void {
        console.error(`[${this.context}] ${message}`, error || '');
    }

    warn(message: string): void {
        console.warn(`[${this.context}] ${message}`);
    }
} 