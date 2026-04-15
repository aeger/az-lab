/**
 * logger.ts — Local file logger with automatic log trimming
 */

import { promises as fs } from 'fs';
import * as path from 'path';

const MAX_LINES = 1000;
const TRIM_TO_LINES = 400;

export class LocalLogger {
  private readonly logFile: string;
  private writing = false;
  private queue: string[] = [];

  constructor(logFile: string) {
    this.logFile = logFile;
  }

  async log(message: string): Promise<void> {
    const timestamp = new Date().toISOString();
    const line = `[${timestamp}] ${message}\n`;
    this.queue.push(line);
    if (!this.writing) {
      await this.flush();
    }
  }

  private async flush(): Promise<void> {
    this.writing = true;
    while (this.queue.length > 0) {
      const lines = this.queue.splice(0);
      try {
        // Ensure directory exists
        await fs.mkdir(path.dirname(this.logFile), { recursive: true });
        await fs.appendFile(this.logFile, lines.join(''), 'utf8');
        await this.trimIfNeeded();
      } catch {
        // Swallow — logger must never crash
      }
    }
    this.writing = false;
  }

  private async trimIfNeeded(): Promise<void> {
    try {
      const contents = await fs.readFile(this.logFile, 'utf8');
      // Split and filter out the trailing empty string from the final \n
      const allLines = contents.split('\n').filter((_, i, arr) =>
        i < arr.length - 1 || arr[i] !== ''
      );
      if (allLines.length > MAX_LINES) {
        const kept = allLines.slice(-TRIM_TO_LINES).join('\n') + '\n';
        const tmp = this.logFile + '.trim.tmp';
        await fs.writeFile(tmp, kept, 'utf8');
        await fs.rename(tmp, this.logFile);
      }
    } catch {
      // Swallow
    }
  }
}
