import chalk from 'chalk';

export class Logger {
    constructor(private context: string) {}

    private getTimestamp(): string {
        return chalk.gray(`[${new Date().toISOString()}]`);
    }

    log(message: string): void {
        console.log(
            this.getTimestamp(),
            chalk.blue(`[${this.context}]`),
            chalk.white(message)
        );
    }

    error(message: string, error?: any): void {
        console.error(
            this.getTimestamp(),
            chalk.red(`[${this.context}]`),
            chalk.red(message),
            error ? chalk.red(error) : ''
        );
    }

    warn(message: string): void {
        console.warn(
            this.getTimestamp(),
            chalk.yellow(`[${this.context}]`),
            chalk.yellow(message)
        );
    }

    success(message: string): void {
        console.log(
            this.getTimestamp(),
            chalk.green(`[${this.context}]`),
            chalk.green(message)
        );
    }

    info(message: string): void {
        console.log(
            this.getTimestamp(),
            chalk.cyan(`[${this.context}]`),
            chalk.cyan(message)
        );
    }
} 